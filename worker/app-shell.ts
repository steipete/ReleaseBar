import {
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import { ownerActivityFromPath, repoFromPath } from "../src/routing.js";
import type {
  ApiQuota,
  AuthPayload,
  DashboardPayload,
  Owner,
  RepoDetailPayload,
} from "../src/types.js";
import { hmac, verifySignedJson } from "./crypto.js";
import { auditGitHubFetch } from "./github-audit.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { safeJsonParse, storedAuthSessionSchema, tryJsonParse } from "./schemas.js";
import { authDependentAppShellHeaders } from "./auth-oauth.js";
import { cachedHotInitialData } from "./build-progress.js";
import {
  type AuthSession,
  installReturnCookie,
  oauthStateCookiePrefix,
  ownerCachePrefix,
  ownerCacheTtlSeconds,
  sessionCookie,
  sessionMaxAgeSeconds,
  stateMaxAgeSeconds,
  type StoredAuthSession,
} from "./config.js";
import { cachedDashboardInitialData, cachedDiscoverInitialData } from "./discover.js";
import { cachedRepoInitialData } from "./repo-detail-response.js";
import { socialLabel, socialPreviewTitle } from "./social-card.js";

export type TokenSources = {
  owners: string[];
  repos: string[];
};

export type InitialPageData =
  | { route: "dashboard"; payload: DashboardPayload }
  | { route: "repo"; payload: RepoDetailPayload };

export function shouldServeAppShell(url: URL): boolean {
  if (url.pathname.split("/").filter(Boolean)[0] === "-" && repoFullNameFromPath(url.pathname)) {
    return true;
  }
  if (url.pathname.endsWith("/")) return true;
  const leaf = url.pathname.split("/").pop() ?? "";
  return !leaf.includes(".");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function injectInitialPageData(html: string, data: InitialPageData | null): string {
  if (!data) return html;
  const script = `<script id="releasebar-initial-data" type="application/json">${escapeJsonForHtml(data)}</script>`;
  return html.includes('<script type="module"')
    ? html.replace('<script type="module"', `${script}<script type="module"`)
    : html.replace("</head>", `${script}</head>`);
}

export function safeReturnTo(value: string | null, origin: string): string {
  if (!value || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function parseCookies(request: Request): Map<string, string> {
  return new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...parts] = cookie.split("=");
        return [name ?? "", parts.join("=")] as const;
      }),
  );
}

export function authConfigured(env: Env): boolean {
  return Boolean(
    env.AUTH_COOKIE_SECRET &&
    env.DASHBOARD_CACHE &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET,
  );
}

export function appSlug(env: Env): string {
  return env.GITHUB_APP_SLUG || "releasebar-app";
}

export function cookie(name: string, value: string, maxAge = sessionMaxAgeSeconds): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function authCookie(value: string, maxAge = sessionMaxAgeSeconds): string {
  return cookie(sessionCookie, value, maxAge);
}

export function installReturnCookieValue(value: string, maxAge = stateMaxAgeSeconds): string {
  return cookie(installReturnCookie, value, maxAge);
}

export function oauthStateCookieName(nonce: string): string {
  return `${oauthStateCookiePrefix}${nonce}`;
}

export async function oauthStateBinding(secret: string, nonce: string): Promise<string> {
  return hmac(secret, `oauth-state:${nonce}`);
}

export function oauthStateCookieValue(
  nonce: string,
  value: string,
  maxAge = stateMaxAgeSeconds,
): string {
  return cookie(oauthStateCookieName(nonce), value, maxAge);
}

export function authUrls(
  url: URL,
  env: Env,
): Pick<AuthPayload, "loginUrl" | "logoutUrl" | "installUrl" | "appUrl"> {
  return {
    loginUrl: `${url.origin}/api/auth/login`,
    logoutUrl: `${url.origin}/api/auth/logout`,
    installUrl: `${url.origin}/api/auth/install`,
    appUrl: `https://github.com/apps/${appSlug(env)}`,
  };
}

export async function currentSession(
  request: Request,
  env: Env,
): Promise<StoredAuthSession | null> {
  const record = await currentSessionRecord(request, env);
  return record?.session ?? null;
}

export async function currentSessionRecord(
  request: Request,
  env: Env,
): Promise<{ id: string | null; session: StoredAuthSession } | null> {
  if (!env.AUTH_COOKIE_SECRET) return null;
  const token = parseCookies(request).get(sessionCookie);
  if (!token) return null;
  const pointer = await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token);
  if (!pointer || pointer.exp < Math.floor(Date.now() / 1000)) return null;

  const stored = await env.DASHBOARD_CACHE?.get(`auth:session:${pointer.id}`);
  if (stored) {
    const session = safeJsonParse(storedAuthSessionSchema, stored, "auth session");
    if (!session) return null;
    return session.exp < Math.floor(Date.now() / 1000) ? null : { id: pointer.id, session };
  }

  const legacy = pointer as unknown as StoredAuthSession;
  return legacy.user && legacy.exp >= Math.floor(Date.now() / 1000)
    ? { id: null, session: legacy }
    : null;
}

export function ownerListFromUrl(url: URL, primaryOwner?: string): string[] {
  const primary = primaryOwner ? slugOwner(primaryOwner) : null;
  return [
    ...new Set(
      (url.searchParams.get("owners") ?? "")
        .split(",")
        .map((value) => slugOwner(value))
        .filter((value) => validOwnerSlug(value) && value !== primary),
    ),
  ];
}

export function repoListFromUrl(url: URL): string[] {
  return [
    ...new Set(
      (url.searchParams.get("repos") ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
  ];
}

export function ownerCacheKey(login: string): string {
  return `${ownerCachePrefix}${slugOwner(login)}`;
}

export function isCachedOwner(value: unknown): value is Owner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<Owner>;
  return (
    (owner.type === "user" || owner.type === "org") &&
    typeof owner.login === "string" &&
    validOwnerSlug(owner.login)
  );
}

export async function readCachedOwner(env: Env, login: string): Promise<Owner | null> {
  const raw = await env.DASHBOARD_CACHE?.get(ownerCacheKey(login));
  if (!raw) return null;
  const parsed = tryJsonParse<Owner>(raw, `owner ${login}`);
  return isCachedOwner(parsed) ? parsed : null;
}

export async function writeCachedOwner(env: Env, owner: Owner): Promise<void> {
  await env.DASHBOARD_CACHE?.put(ownerCacheKey(owner.login), JSON.stringify(owner), {
    expirationTtl: ownerCacheTtlSeconds,
  });
}

export function repoFullNameFromPath(pathname: string): string | null {
  return repoFromPath(pathname)?.fullName ?? null;
}

export function ownerActivityPageOwner(pathname: string): string | null {
  return ownerActivityFromPath(pathname)?.owner ?? null;
}

export function ownerFromPagePath(pathname: string): string | null {
  if (ownerActivityPageOwner(pathname)) return null;
  if (repoFullNameFromPath(pathname)) return null;
  const owner = slugOwner(pathname.split("/").filter(Boolean)[0] ?? "");
  return validOwnerSlug(owner) ? owner : null;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function dashboardSubtitle(owners: Owner[], repos: string[]): string {
  const sourceCount = owners.length + repos.length;
  if (sourceCount === 0) {
    return "Release freshness for public GitHub projects.";
  }
  if (sourceCount === 1 && owners[0]) {
    return `Release freshness for @${owners[0].login}.`;
  }
  return `Release freshness across ${sourceCount} public GitHub sources.`;
}

export async function resolveOwners(
  ownerSlugs: string[],
  env: Env,
  token?: string | null,
  quotaSource: ApiQuota["source"] = token || env.GITHUB_TOKEN ? "shared" : "anonymous",
  quotaAccount: string | null = null,
  signal?: AbortSignal,
  context?: ExecutionContext,
): Promise<Owner[] | null> {
  const owners: Owner[] = [];
  for (const owner of ownerSlugs) {
    const cached = await readCachedOwner(env, owner);
    if (cached) {
      owners.push(cached);
      continue;
    }
    const resolved = await resolveOwnerType(owner, {
      fetch: auditGitHubFetch("dashboard", quotaSource, quotaAccount, env, context, signal),
      token: token ?? env.GITHUB_TOKEN,
    });
    if (!resolved) {
      return null;
    }
    const write = writeCachedOwner(env, resolved).catch(() => undefined);
    if (context) {
      context.waitUntil(write);
    } else {
      await write;
    }
    owners.push(resolved);
  }
  return owners;
}

export async function initialPageData(
  request: Request,
  url: URL,
  env: Env,
): Promise<InitialPageData | null> {
  if (url.pathname === "/_admin") return null;
  if (ownerActivityPageOwner(url.pathname)) return null;
  const repo = repoFullNameFromPath(url.pathname);
  if (repo) return cachedRepoInitialData(env, repo);

  const primaryOwner = ownerFromPagePath(url.pathname);
  const custom =
    ownerListFromUrl(url, primaryOwner ?? undefined).length > 0 || repoListFromUrl(url).length > 0;
  if (primaryOwner || custom) {
    return cachedDashboardInitialData(request, env, url, primaryOwner);
  }
  if ((url.searchParams.get("period") ?? "").toLowerCase() === "releasebar") {
    return cachedHotInitialData(env);
  }
  return cachedDiscoverInitialData(env, url);
}

export async function assetResponse(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const url = new URL(request.url);
  if (shouldServeAppShell(url)) {
    url.pathname = "/index.html";
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (!response.ok) {
      return response;
    }
    const originalUrl = new URL(request.url);
    const label = socialLabel(originalUrl);
    const title = socialPreviewTitle(label);
    const image = `${originalUrl.origin}/og/${encodeURIComponent(label)}.png`;
    const initialData = await initialPageData(request, originalUrl, env).catch(() => null);
    const html = injectInitialPageData(
      (await response.text())
        .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)} · release.bar</title>`)
        .replace(
          /<meta property="og:title" content="[^"]*" \/>/,
          `<meta property="og:title" content="${escapeHtml(title)}" />`,
        )
        .replace(
          /<meta property="og:url" content="[^"]*" \/>/,
          `<meta property="og:url" content="${escapeHtml(originalUrl.href)}" />`,
        )
        .replace(
          /<meta property="og:image" content="[^"]*" \/>/,
          `<meta property="og:image" content="${escapeHtml(image)}" />`,
        )
        .replace(
          /<meta name="twitter:title" content="[^"]*" \/>/,
          `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        )
        .replace(
          /<meta name="twitter:image" content="[^"]*" \/>/,
          `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
        ),
      initialData,
    );
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("content-type", "text/html; charset=utf-8");
    for (const [name, value] of Object.entries(authDependentAppShellHeaders(request, env))) {
      headers.set(name, value);
    }
    return new Response(html, {
      status: response.status,
      headers,
    });
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) {
    return asset;
  }

  return asset;
}
