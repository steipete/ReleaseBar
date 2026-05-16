import {
  buildDashboard,
  dashboardCacheKey,
  GitHubRateLimitError,
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import type { GenericSchema, InferOutput } from "valibot";
import {
  gitHubInstallationListSchema,
  gitHubInstallationRepositoryListSchema,
  gitHubInstallationTokenSchema,
  gitHubOAuthTokenSchema,
  gitHubOAuthUserSchema,
  gitHubSearchRepositoryListSchema,
  hotIndexSchema,
  parseGitHubResponse,
  safeJsonParse,
  storedAuthSessionSchema,
  tryJsonParse,
  type GitHubInstallationRepository,
  type GitHubSearchRepository,
} from "./schemas.js";
import type {
  ApiQuota,
  AuthInstallation,
  AuthPayload,
  AuthUser,
  DashboardProfile,
  DashboardPayload,
  Owner,
  Project,
} from "../src/types.js";

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

type DurableObjectId = unknown;

type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

type DurableObjectState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

type Env = {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AUTH_COOKIE_SECRET?: string;
  DASHBOARD_CACHE?: KVNamespace;
  DASHBOARD_LOCKS?: DurableObjectNamespace;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_TOKEN?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const fullTtlMs = 60 * 60 * 1000;
const staleTtlSeconds = 3 * 24 * 60 * 60;
const installationTokenTtlSeconds = 50 * 60;
const coldBuildWaitMs = 15 * 1000;
const buildLockTtlMs = 2 * 60 * 1000;
const buildLockRefreshMs = 30 * 1000;
const repoLimit = 12;
const repoScanLimit = 12;
const hotLimit = 50;
const hotOwnerLimit = 3;
const hotSourceLimit = 24;
const hotIndexLimit = 100;
const hotCacheTtlMs = 5 * 60 * 1000;
const discoverLimit = 40;
const discoverCacheTtlMs = 60 * 60 * 1000;
const maxCustomSources = 8;
const dashboardSchemaVersion = 4;
const previousDashboardSchemaVersion = 3;
const auxiliaryCacheSchemaVersion = 3;
const dashboardCachePrefix = `dashboard:v${dashboardSchemaVersion}:`;
const previousDashboardCachePrefix = `dashboard:v${previousDashboardSchemaVersion}:`;
const dashboardCachePrefixes = [dashboardCachePrefix, previousDashboardCachePrefix];
const hotCacheKey = `hot:v${auxiliaryCacheSchemaVersion}`;
const hotIndexKey = `hot:index:v${auxiliaryCacheSchemaVersion}`;
const sessionCookie = "rd_session";
const installReturnCookie = "rd_install_return";
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const stateMaxAgeSeconds = 10 * 60;
const locks = new Map<string, Promise<DashboardPayload>>();
const buildPending = Symbol("build-pending");
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const workerFetch: typeof fetch = (input, init) => fetch(input, init);

type DashboardRequest = {
  owners: Owner[];
  includeRepos: string[];
  profile: DashboardProfile | null;
  subtitle: string;
  key: string;
  url: URL;
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
};

type RequestToken = {
  token: string;
  quotaSource: "app";
  quotaAccount: string | null;
};

type ProfileInput = {
  includeOwners?: unknown;
  includeRepos?: unknown;
  hiddenOwners?: unknown;
  hiddenRepos?: unknown;
};

type BuildLock = {
  refresh(): Promise<void>;
  release(): Promise<void>;
};

type StoredBuildLock = {
  token: string;
  expiresAt: number;
};

type AuthState = {
  returnTo: string;
  iat: number;
  nonce: string;
};

type AuthSession = {
  id: string;
  exp: number;
};

type StoredAuthSession = {
  user: AuthUser;
  accessToken: string;
  iat: number;
  exp: number;
};

function isPublicInstallationRepository(repo: GitHubInstallationRepository): boolean {
  if (repo.private === true) {
    return false;
  }
  return repo.private === false || repo.visibility === "public";
}

type TokenSources = {
  owners: string[];
  repos: string[];
};

function shouldServeAppShell(url: URL): boolean {
  if (url.pathname.endsWith("/")) return true;
  const leaf = url.pathname.split("/").pop() ?? "";
  return !leaf.includes(".");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function signedJson(secret: string, value: unknown): Promise<string> {
  const payload = base64UrlJson(value);
  return `${payload}.${await hmac(secret, payload)}`;
}

async function verifySignedJson<T>(secret: string, token: string): Promise<T | null> {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(signature, expected)) return null;
  return decodeBase64UrlJson<T>(payload);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function safeReturnTo(value: string | null, origin: string): string {
  if (!value || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function parseCookies(request: Request): Map<string, string> {
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

function authConfigured(env: Env): boolean {
  return Boolean(
    env.AUTH_COOKIE_SECRET &&
    env.DASHBOARD_CACHE &&
    env.GITHUB_APP_CLIENT_ID &&
    env.GITHUB_APP_CLIENT_SECRET,
  );
}

function appSlug(env: Env): string {
  return env.GITHUB_APP_SLUG || "releasebar-app";
}

function cookie(name: string, value: string, maxAge = sessionMaxAgeSeconds): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function authCookie(value: string, maxAge = sessionMaxAgeSeconds): string {
  return cookie(sessionCookie, value, maxAge);
}

function installReturnCookieValue(value: string, maxAge = stateMaxAgeSeconds): string {
  return cookie(installReturnCookie, value, maxAge);
}

function authUrls(
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

async function currentSession(request: Request, env: Env): Promise<StoredAuthSession | null> {
  if (!env.AUTH_COOKIE_SECRET) return null;
  const token = parseCookies(request).get(sessionCookie);
  if (!token) return null;
  const pointer = await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token);
  if (!pointer || pointer.exp < Math.floor(Date.now() / 1000)) return null;

  const stored = await env.DASHBOARD_CACHE?.get(`auth:session:${pointer.id}`);
  if (stored) {
    const session = safeJsonParse(storedAuthSessionSchema, stored, "auth session");
    if (!session) return null;
    return session.exp < Math.floor(Date.now() / 1000) ? null : session;
  }

  const legacy = pointer as unknown as StoredAuthSession;
  return legacy.user && legacy.exp >= Math.floor(Date.now() / 1000) ? legacy : null;
}

function ownerListFromUrl(url: URL, primaryOwner?: string): string[] {
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

function repoListFromUrl(url: URL): string[] {
  return [
    ...new Set(
      (url.searchParams.get("repos") ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
  ];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function dashboardSubtitle(owners: Owner[], repos: string[]): string {
  const sourceCount = owners.length + repos.length;
  if (sourceCount === 0) {
    return "Release freshness for public GitHub projects.";
  }
  if (sourceCount === 1 && owners[0]) {
    return `Release freshness for @${owners[0].login}.`;
  }
  return `Release freshness across ${sourceCount} public GitHub sources.`;
}

async function resolveOwners(
  ownerSlugs: string[],
  env: Env,
  token?: string | null,
): Promise<Owner[] | null> {
  const owners: Owner[] = [];
  for (const owner of ownerSlugs) {
    const resolved = await resolveOwnerType(owner, {
      fetch: workerFetch,
      token: token ?? env.GITHUB_TOKEN,
    });
    if (!resolved) {
      return null;
    }
    owners.push(resolved);
  }
  return owners;
}

async function assetResponse(request: Request, env: Env): Promise<Response> {
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
    const image = `${originalUrl.origin}/og/${encodeURIComponent(label)}.svg`;
    const html = (await response.text())
      .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(label)} · ReleaseBar</title>`)
      .replace(
        /<meta property="og:title" content="[^"]*" \/>/,
        `<meta property="og:title" content="${escapeHtml(label)} · ReleaseBar" />`,
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
        `<meta name="twitter:title" content="${escapeHtml(label)} · ReleaseBar" />`,
      )
      .replace(
        /<meta name="twitter:image" content="[^"]*" \/>/,
        `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
      );
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("cache-control", "public, max-age=300");
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

function socialLabel(url: URL): string {
  const owner = slugOwner(url.pathname.split("/").filter(Boolean)[0] ?? "");
  if (validOwnerSlug(owner)) {
    const extra = ownerListFromUrl(url, owner).length + repoListFromUrl(url).length;
    return extra > 0 ? `@${owner} +${extra}` : `@${owner}`;
  }
  const owners = ownerListFromUrl(url);
  const repos = repoListFromUrl(url);
  if (owners[0]) {
    const extra = owners.length - 1 + repos.length;
    return extra > 0 ? `@${owners[0]} +${extra}` : `@${owners[0]}`;
  }
  if (repos.length === 1) {
    return repos[0] ?? "custom deck";
  }
  return repos.length > 1 ? `custom deck +${repos.length}` : "ReleaseBar Hot";
}

function socialImage(label: string): Response {
  const title = escapeHtml(label);
  const titleSize = label.length > 24 ? 64 : label.length > 17 ? 82 : label.length > 12 ? 100 : 118;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080908"/>
  <path d="M0 124H1200M0 248H1200M0 372H1200M0 496H1200M160 0V630M400 0V630M640 0V630M880 0V630M1120 0V630" stroke="#182014" stroke-width="1"/>
  <rect x="72" y="70" width="1056" height="490" rx="0" fill="none" stroke="#8cff4b" stroke-width="2"/>
  <text x="96" y="148" fill="#a8ff6b" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="38" letter-spacing="0">ReleaseBar</text>
  <text x="92" y="354" fill="#f2ffe9" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="${titleSize}" font-weight="700" letter-spacing="0">${title}</text>
  <text x="96" y="444" fill="#8f9b89" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="34" letter-spacing="0">release freshness dashboard</text>
  <text x="96" y="506" fill="#52604d" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="24" letter-spacing="0">release.bar</text>
</svg>`;
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      ...corsHeaders,
      ...headers,
    },
  });
}

function redirectResponse(
  location: string,
  headers: Record<string, string | string[]> = {},
): Response {
  const responseHeaders = new Headers({
    location,
    "cache-control": "no-store",
  });
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        responseHeaders.append(key, item);
      }
    } else {
      responseHeaders.set(key, value);
    }
  }
  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

async function meResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const session = await currentSession(request, env);
  const installations = session
    ? await githubInstallations(session.accessToken).catch(() => [])
    : [];
  const coverage = session
    ? sourceCoverage(installations, currentReturnTo(url), url.origin, appTokenConfigured(env))
    : { needed: false, reason: null };
  const body: AuthPayload = {
    configured: authConfigured(env),
    quotaConfigured: appTokenConfigured(env),
    user: session?.user ?? null,
    installations,
    installNeeded: Boolean(session && coverage.needed),
    installReason: session ? coverage.reason : null,
    ...authUrls(url, env),
  };
  return jsonResponse(body, 200, { "cache-control": "no-store" });
}

function currentReturnTo(url: URL): string {
  const value = url.searchParams.get("returnTo");
  return safeReturnTo(value, url.origin) || "/";
}

async function loginResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET || !env.GITHUB_APP_CLIENT_ID) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo: safeReturnTo(url.searchParams.get("returnTo"), url.origin),
    iat: Math.floor(Date.now() / 1000),
    nonce: randomNonce(),
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
  github.searchParams.set("state", state);
  return redirectResponse(github.toString());
}

async function exchangeCode(url: URL, env: Env): Promise<string> {
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken || !env.AUTH_COOKIE_SECRET) {
    throw new Error("missing OAuth code or state");
  }
  const state = await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, stateToken);
  const now = Math.floor(Date.now() / 1000);
  if (!state || now - state.iat > stateMaxAgeSeconds) {
    throw new Error("invalid OAuth state");
  }
  const response = await workerFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  const token = parseGitHubResponse(gitHubOAuthTokenSchema, await response.json(), "oauth token");
  if (!response.ok || !token.access_token) {
    throw new Error(token.error_description || token.error || "GitHub OAuth exchange failed");
  }
  return token.access_token;
}

async function githubUser(accessToken: string): Promise<AuthUser> {
  const response = await workerFetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }
  const user = parseGitHubResponse(gitHubOAuthUserSchema, await response.json(), "oauth user");
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    url: user.html_url,
  };
}

async function githubJson<TSchema extends GenericSchema>(
  accessToken: string,
  pathname: string,
  schema: TSchema,
  context: string,
): Promise<InferOutput<TSchema>> {
  const response = await workerFetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status}`);
  }
  return parseGitHubResponse(schema, await response.json(), context);
}

async function githubInstallations(accessToken: string): Promise<AuthInstallation[]> {
  const result = await githubJson(
    accessToken,
    "/user/installations?per_page=100",
    gitHubInstallationListSchema,
    "installation list",
  );
  const installations = result.installations ?? [];
  return Promise.all(
    installations
      .filter((installation) => installation.account)
      .map(async (installation) => {
        const account = installation.account;
        if (!account) {
          throw new Error("missing installation account");
        }
        const repositories =
          installation.repository_selection === "selected"
            ? await githubInstallationRepositories(accessToken, installation.id)
            : [];
        return {
          id: installation.id,
          accountLogin: account.login.toLowerCase(),
          accountType: account.type === "Organization" ? "org" : "user",
          accountUrl: account.html_url,
          avatarUrl: account.avatar_url,
          repositorySelection: installation.repository_selection,
          repositories,
        };
      }),
  );
}

async function githubInstallationRepositories(
  accessToken: string,
  installationId: number,
): Promise<string[]> {
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(
      accessToken,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      gitHubInstallationRepositoryListSchema,
      "installation repositories",
    );
    const batch = result.repositories ?? [];
    repositories.push(
      ...batch.filter(isPublicInstallationRepository).map((repo) => repo.full_name.toLowerCase()),
    );
    if (batch.length < 100) break;
  }
  return repositories;
}

function appTokenConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(body.length), body);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pkcs1RsaToPkcs8(pkcs1: Uint8Array): ArrayBuffer {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryption = new Uint8Array([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  ]);
  const algorithm = der(0x30, concatBytes(rsaEncryption, new Uint8Array([0x05, 0x00])));
  const privateKey = der(0x04, pkcs1);
  return arrayBuffer(der(0x30, concatBytes(version, algorithm, privateKey)));
}

function pemToPkcs8ArrayBuffer(pem: string): ArrayBuffer {
  const normalized = normalizePrivateKey(pem);
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(normalized)) {
    throw new Error("Encrypted GitHub App private keys are not supported");
  }
  const isPkcs1Rsa = /BEGIN RSA PRIVATE KEY/.test(normalized);
  const base64 = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return isPkcs1Rsa ? pkcs1RsaToPkcs8(bytes) : arrayBuffer(bytes);
}

async function githubAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID,
  };
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8ArrayBuffer(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function githubInstallationToken(env: Env, installationId: number): Promise<string | null> {
  const jwt = await githubAppJwt(env);
  const response = await workerFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "ReleaseBar",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const result = parseGitHubResponse(
    gitHubInstallationTokenSchema,
    await response.json(),
    "installation token",
  );
  if (!response.ok || !result.token) {
    throw new Error(result.message || `GitHub installation token failed: ${response.status}`);
  }
  return result.token;
}

function installationCoversSources(installation: AuthInstallation, sources: TokenSources): boolean {
  if (sources.owners.length > 0) {
    return (
      sources.owners.every((owner) => owner === installation.accountLogin) &&
      sources.repos.every((repo) => repo.split("/")[0] === installation.accountLogin) &&
      installation.repositorySelection === "all"
    );
  }

  if (sources.repos.length === 0) {
    return true;
  }

  return sources.repos.every((repo) => {
    const owner = repo.split("/")[0] ?? "";
    return (
      owner === installation.accountLogin &&
      (installation.repositorySelection === "all" || installation.repositories.includes(repo))
    );
  });
}

function matchingInstallation(
  installations: AuthInstallation[],
  sources: TokenSources,
): AuthInstallation | null {
  return (
    installations.find((installation) => installationCoversSources(installation, sources)) ?? null
  );
}

async function cachedInstallationToken(env: Env, installationId: number): Promise<string | null> {
  const cacheKey = `auth:installation-token:${installationId}`;
  const cached = await env.DASHBOARD_CACHE?.get(cacheKey);
  if (cached) return cached;
  const token = await githubInstallationToken(env, installationId);
  if (token) {
    await env.DASHBOARD_CACHE?.put(cacheKey, token, {
      expirationTtl: installationTokenTtlSeconds,
    });
  }
  return token;
}

async function requestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const session = await currentSession(request, env);
  if (!session) return null;
  const installations = await githubInstallations(session.accessToken);
  const installation = matchingInstallation(installations, sources);
  const token = installation ? await cachedInstallationToken(env, installation.id) : null;
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation?.accountLogin ?? null,
      }
    : null;
}

function sourceAccounts(sources: TokenSources): string[] {
  return [
    ...new Set([
      ...sources.owners,
      ...sources.repos.map((repo) => repo.split("/")[0] ?? "").filter(Boolean),
    ]),
  ];
}

function returnToSources(returnTo: string, origin: string): { owners: string[]; repos: string[] } {
  const url = new URL(returnTo, origin);
  const rawOwner = slugOwner(url.pathname.split("/").filter(Boolean)[0] ?? "");
  const primaryOwner = validOwnerSlug(rawOwner) ? rawOwner : null;
  return {
    owners: [
      ...new Set([
        ...(primaryOwner ? [primaryOwner] : []),
        ...ownerListFromUrl(url, primaryOwner ?? undefined),
      ]),
    ],
    repos: repoListFromUrl(url),
  };
}

function sourceCoverage(
  installations: AuthInstallation[],
  returnTo: string,
  origin: string,
  quotaConfigured: boolean,
): { needed: boolean; reason: string | null } {
  const sources = returnToSources(returnTo, origin);
  if (!quotaConfigured) {
    return {
      needed: false,
      reason: "Dedicated app quota is not configured on this deployment.",
    };
  }
  if (matchingInstallation(installations, sources)) {
    return { needed: false, reason: null };
  }
  if (sources.owners.length === 0 && sources.repos.length === 0) {
    return installations.length === 0
      ? { needed: true, reason: "Install the GitHub App for dedicated API quota." }
      : { needed: false, reason: null };
  }

  if (sourceAccounts(sources).length > 1) {
    return {
      needed: false,
      reason:
        "Mixed-account dashboards use shared API quota; use one installed account per dashboard for dedicated quota.",
    };
  }

  const uncoveredOwners = sources.owners.filter(
    (owner) =>
      !installations.some(
        (installation) =>
          installation.accountLogin === owner && installation.repositorySelection === "all",
      ),
  );
  const uncoveredRepos = sources.repos.filter(
    (repo) =>
      !installations.some((installation) => {
        const owner = repo.split("/")[0] ?? "";
        return (
          installation.accountLogin === owner &&
          (installation.repositorySelection === "all" || installation.repositories.includes(repo))
        );
      }),
  );

  if (uncoveredOwners.length > 0 || uncoveredRepos.length > 0) {
    const target = uncoveredOwners[0] ? `@${uncoveredOwners[0]}` : uncoveredRepos[0];
    return {
      needed: true,
      reason: `Install the GitHub App for ${target} to use dedicated API quota.`,
    };
  }

  return { needed: false, reason: null };
}

async function storedSessionCookie(env: Env, user: AuthUser, accessToken: string): Promise<string> {
  if (!env.AUTH_COOKIE_SECRET) {
    throw new Error("missing auth cookie secret");
  }
  if (!env.DASHBOARD_CACHE) {
    throw new Error("missing auth session storage");
  }
  const now = Math.floor(Date.now() / 1000);
  const id = randomNonce();
  const exp = now + sessionMaxAgeSeconds;
  const stored: StoredAuthSession = {
    user,
    accessToken,
    iat: now,
    exp,
  };
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(stored), {
    expirationTtl: sessionMaxAgeSeconds,
  });
  const session = await signedJson(env.AUTH_COOKIE_SECRET, { id, exp });
  return authCookie(session);
}

async function callbackResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  try {
    const state = await verifySignedJson<AuthState>(
      env.AUTH_COOKIE_SECRET,
      url.searchParams.get("state") ?? "",
    );
    if (!state || Math.floor(Date.now() / 1000) - state.iat > stateMaxAgeSeconds) {
      throw new Error("invalid OAuth state");
    }
    const accessToken = await exchangeCode(url, env);
    const user = await githubUser(accessToken);
    const sessionCookieValue = await storedSessionCookie(env, user, accessToken);
    const installations = await githubInstallations(accessToken).catch(() => []);
    const coverage = sourceCoverage(
      installations,
      state.returnTo,
      url.origin,
      appTokenConfigured(env),
    );
    if (coverage.needed) {
      const installReturn = await signedJson(env.AUTH_COOKIE_SECRET, {
        returnTo: state.returnTo,
        iat: Math.floor(Date.now() / 1000),
        nonce: randomNonce(),
      });
      return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`, {
        "set-cookie": [sessionCookieValue, installReturnCookieValue(installReturn)],
      });
    }
    return redirectResponse(state.returnTo, { "set-cookie": sessionCookieValue });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, {
      "cache-control": "no-store",
    });
  }
}

async function logoutResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.AUTH_COOKIE_SECRET) {
    const token = parseCookies(request).get(sessionCookie);
    const session = token
      ? await verifySignedJson<AuthSession>(env.AUTH_COOKIE_SECRET, token)
      : null;
    if (session?.id) {
      await env.DASHBOARD_CACHE?.delete?.(`auth:session:${session.id}`);
    }
  }
  return redirectResponse(safeReturnTo(url.searchParams.get("returnTo"), url.origin), {
    "set-cookie": authCookie("", 0),
  });
}

async function installResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.AUTH_COOKIE_SECRET) {
    return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`);
  }

  if (url.searchParams.has("installation_id") || url.searchParams.has("setup_action")) {
    const token = parseCookies(request).get(installReturnCookie);
    const state = token ? await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, token) : null;
    const returnTo =
      state && Math.floor(Date.now() / 1000) - state.iat <= stateMaxAgeSeconds
        ? state.returnTo
        : "/";
    return redirectResponse(returnTo, {
      "set-cookie": installReturnCookieValue("", 0),
    });
  }

  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo: safeReturnTo(url.searchParams.get("returnTo"), url.origin),
    iat: Math.floor(Date.now() / 1000),
    nonce: randomNonce(),
  });
  return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`, {
    "set-cookie": installReturnCookieValue(state),
  });
}

async function authResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") return loginResponse(request, env);
  if (url.pathname === "/api/auth/callback") return callbackResponse(request, env);
  if (url.pathname === "/api/auth/logout") return logoutResponse(request, env);
  if (url.pathname === "/api/auth/install") {
    return installResponse(request, env);
  }
  return jsonResponse({ error: "not found" }, 404);
}

function withCacheState(
  payload: DashboardPayload,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message?: string,
): DashboardPayload {
  const cacheMessage = message ?? payload.cache?.message;
  return {
    ...payload,
    cache: {
      state,
      stale: state !== "fresh",
      capped: payload.cache?.capped ?? false,
      repoLimit: payload.cache ? payload.cache.repoLimit : repoLimit,
      generatedAt: payload.generatedAt,
      ...(payload.cache?.quota ? { quota: payload.cache.quota } : {}),
      ...(cacheMessage ? { message: cacheMessage } : {}),
    },
  };
}

function quotaForDashboard(dashboard: DashboardRequest, env: Env): ApiQuota {
  return {
    source: dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
    account: dashboard.quotaAccount ?? null,
    remaining: null,
    limit: null,
    resetAt: null,
    resource: null,
  };
}

function optionsFromUrl(url: URL) {
  return {
    includeForks: url.searchParams.get("forks") === "true",
    includeArchived: url.searchParams.get("archived") === "true",
    includeUnreleased: url.searchParams.get("unreleased") === "true",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitHubRateLimit(error: unknown): boolean {
  if (error instanceof GitHubRateLimitError) return true;
  return /rate limit|secondary rate|api rate limit exceeded|shared api quota|quota .*exhausted/i.test(
    errorMessage(error),
  );
}

function retryAfterSeconds(error: unknown): number | null {
  return error instanceof GitHubRateLimitError ? error.retryAfterSeconds : null;
}

function retryAfterHeaders(error: unknown): Record<string, string> {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? { "cache-control": "no-store" }
    : { "cache-control": "no-store", "retry-after": String(seconds) };
}

function dashboardErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub shared API quota is exhausted. Connect GitHub and install the app for this account to use dedicated quota, or try again after the shared quota resets.";
  }

  const message = errorMessage(error);
  const githubMatch = message.match(/^GitHub API (\d+) for ([^:]+):/);
  if (githubMatch) {
    return `GitHub API ${githubMatch[1]} while loading ${githubMatch[2]}.`;
  }
  return message;
}

function errorStatus(error: unknown): number {
  return isGitHubRateLimit(error) ? 429 : 502;
}

async function readCached(env: Env, key: string): Promise<DashboardPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`) : null;
}

function profileKey(owner: string): string {
  return `profile:v1:${slugOwner(owner)}`;
}

async function readProfile(env: Env, owner: string): Promise<DashboardProfile | null> {
  const raw = await env.DASHBOARD_CACHE?.get(profileKey(owner));
  if (!raw) return null;
  const parsed = tryJsonParse<DashboardProfile>(raw, `profile ${owner}`);
  return parsed?.owner === slugOwner(owner) ? parsed : null;
}

async function writeProfile(env: Env, profile: DashboardProfile): Promise<void> {
  await env.DASHBOARD_CACHE?.put(profileKey(profile.owner), JSON.stringify(profile));
}

async function deleteProfile(env: Env, owner: string): Promise<void> {
  await env.DASHBOARD_CACHE?.delete?.(profileKey(owner));
}

async function writeCached(
  env: Env,
  key: string,
  payload: DashboardPayload,
  ttlSeconds = staleTtlSeconds,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
}

function projectActivityDate(project: Project): string | null {
  return project.latestCommitDate || project.pushedAt || project.updatedAt;
}

function daysSince(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 86400000));
}

function hotScore(project: Project): number {
  const commits = project.commitsSinceRelease ?? 0;
  const stars = Math.log1p(project.stars) * 6;
  const activityDays = daysSince(projectActivityDate(project));
  const recency =
    activityDays === null ? 0 : (Math.max(0, 30 - Math.min(activityDays, 30)) / 30) * 20;
  const prs = Math.log1p(project.openPullRequests) * 2;
  const ci = project.ciState === "failure" ? 15 : project.ciState === "running" ? 5 : 0;
  return commits * 4 + stars + recency + prs + ci;
}

function withProfile(
  payload: DashboardPayload,
  profile: DashboardProfile | null,
): DashboardPayload {
  if (!profile) return payload;
  const hiddenOwners = new Set(profile.hiddenOwners);
  const hiddenRepos = new Set(profile.hiddenRepos);
  const projects = payload.projects.filter(
    (project) =>
      !hiddenOwners.has(project.owner.toLowerCase()) &&
      !hiddenRepos.has(project.fullName.toLowerCase()),
  );
  const released = projects.filter((project) => project.releaseDate).length;
  return {
    ...payload,
    profile,
    totals: {
      repos: projects.length,
      released,
      unreleased: projects.length - released,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease ?? 0),
        0,
      ),
    },
    projects,
  };
}

function dashboardTotals(projects: Project[]): DashboardPayload["totals"] {
  const released = projects.filter((project) => project.releaseDate).length;
  return {
    repos: projects.length,
    released,
    unreleased: projects.length - released,
    commitsSinceRelease: projects.reduce(
      (sum, project) => sum + (project.commitsSinceRelease ?? 0),
      0,
    ),
  };
}

async function partialDashboardPayload(
  dashboard: DashboardRequest,
  env: Env,
  ownerSlugs: string[],
): Promise<DashboardPayload | null> {
  const options = optionsFromUrl(dashboard.url);
  const keys = [
    ...ownerSlugs.map((owner) =>
      dashboardCacheKey({
        owner,
        ...options,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
    ...dashboard.includeRepos.map((repo) =>
      dashboardCacheKey({
        owner: "custom",
        repos: [repo],
        ...options,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
  ];
  const dashboards = (
    await Promise.all([...new Set(keys)].map((key) => readCached(env, key)))
  ).filter(
    (payload): payload is DashboardPayload =>
      payload !== null && payload.cache?.state !== "error" && payload.projects.length > 0,
  );
  if (dashboards.length === 0) return null;

  const projectsByName = new Map<string, Project>();
  for (const payload of dashboards) {
    for (const project of payload.projects) {
      projectsByName.set(project.fullName.toLowerCase(), project);
    }
  }
  const projects = [...projectsByName.values()];
  const generatedAt = dashboards
    .map((payload) => payload.generatedAt)
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort()[0];
  const firstQuota = dashboards.find((payload) => payload.cache?.quota)?.cache?.quota;
  return withProfile(
    {
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      generatedAt: generatedAt ?? new Date().toISOString(),
      owners: dashboard.owners,
      options: {
        ...options,
        repoLimit,
      },
      cache: {
        state: "partial",
        stale: true,
        capped: dashboards.some((payload) => payload.cache?.capped),
        repoLimit,
        generatedAt: generatedAt ?? new Date().toISOString(),
        ...(firstQuota ? { quota: firstQuota } : {}),
        message: `showing cached data from ${dashboards.length} source${dashboards.length === 1 ? "" : "s"} while the combined dashboard updates`,
      },
      totals: dashboardTotals(projects),
      projects,
    },
    dashboard.profile,
  );
}

async function readCachedDashboards(env: Env): Promise<DashboardPayload[]> {
  if (!env.DASHBOARD_CACHE) return [];

  const dashboards: DashboardPayload[] = [];
  let keys = await readHotIndex(env);
  if (keys.length < hotSourceLimit && env.DASHBOARD_CACHE.list) {
    for (const prefix of dashboardCachePrefixes) {
      if (keys.length >= hotSourceLimit) break;
      const page = await env.DASHBOARD_CACHE.list({
        prefix,
        limit: hotSourceLimit,
      });
      keys = [...new Set([...keys, ...page.keys.map((key) => key.name)])];
    }
  }

  for (const key of keys.slice(0, hotSourceLimit)) {
    const raw = await env.DASHBOARD_CACHE.get(key);
    if (!raw) continue;
    const payload = tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`);
    if (!payload) continue;
    if (
      payload.cache?.state === "error" ||
      payload.options?.includeForks ||
      payload.projects.length === 0
    ) {
      continue;
    }
    dashboards.push(payload);
  }

  return dashboards;
}

async function readHotIndex(env: Env): Promise<string[]> {
  const raw = await env.DASHBOARD_CACHE?.get(hotIndexKey);
  if (!raw) return [];
  const keys = safeJsonParse(hotIndexSchema, raw, "hot index");
  return keys
    ? keys.filter((key) => dashboardCachePrefixes.some((prefix) => key.startsWith(prefix)))
    : [];
}

async function rememberHotDashboard(
  env: Env,
  key: string,
  payload: DashboardPayload,
): Promise<void> {
  if (payload.options?.includeForks) return;
  const keys = await readHotIndex(env);
  const next = [key, ...keys.filter((existing) => existing !== key)].slice(0, hotIndexLimit);
  await env.DASHBOARD_CACHE?.put(hotIndexKey, JSON.stringify(next), {
    expirationTtl: staleTtlSeconds,
  });
}

function hotDashboardPayload(
  dashboards: DashboardPayload[],
  env: Env,
  generatedAt = new Date().toISOString(),
): DashboardPayload {
  const candidates = new Map<string, Project>();
  for (const dashboard of dashboards) {
    for (const project of dashboard.projects) {
      if (project.archived || !project.releaseDate || project.commitsSinceRelease === null) {
        continue;
      }
      const existing = candidates.get(project.fullName.toLowerCase());
      if (!existing || hotScore(project) > hotScore(existing)) {
        candidates.set(project.fullName.toLowerCase(), project);
      }
    }
  }

  const ownerCounts = new Map<string, number>();
  const projects = [...candidates.values()]
    .sort((a, b) => hotScore(b) - hotScore(a))
    .filter((project) => {
      const owner = project.owner.toLowerCase();
      const count = ownerCounts.get(owner) ?? 0;
      if (count >= hotOwnerLimit) return false;
      ownerCounts.set(owner, count + 1);
      return true;
    })
    .slice(0, hotLimit);
  const omitted = candidates.size > projects.length;

  return {
    title: "ReleaseBar Hot",
    subtitle: "Release debt across recently requested public dashboards.",
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: false,
      repoLimit: null,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: omitted,
      repoLimit: null,
      generatedAt,
      message: `built from ${dashboards.length} cached dashboard${dashboards.length === 1 ? "" : "s"}`,
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

async function hotResponse(env: Env): Promise<Response> {
  const cached = await readCached(env, hotCacheKey);
  const ageMs = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;
  if (cached && ageMs < hotCacheTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  const payload = hotDashboardPayload(await readCachedDashboards(env), env);
  await writeCached(env, hotCacheKey, payload);
  return jsonResponse(payload);
}

type DiscoverPeriod = "day" | "week" | "month" | "year";

const discoverPeriods = new Set<DiscoverPeriod>(["day", "week", "month", "year"]);

function discoverPeriod(url: URL): DiscoverPeriod {
  const raw = (url.searchParams.get("period") ?? "week").toLowerCase();
  if (raw === "today") return "day";
  return discoverPeriods.has(raw as DiscoverPeriod) ? (raw as DiscoverPeriod) : "week";
}

function discoverLanguage(url: URL): string {
  const raw = (url.searchParams.get("lang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

function discoverCacheKey(period: DiscoverPeriod, language: string): string {
  return `discover:v${auxiliaryCacheSchemaVersion}:${period}:${language.trim().toLowerCase() || "all"}`;
}

function discoverSince(period: DiscoverPeriod): string {
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
  const date = new Date(Date.now() - days * 86400000);
  return date.toISOString().slice(0, 10);
}

function discoverPeriodLabel(period: DiscoverPeriod): string {
  return period === "day" ? "today" : `this ${period}`;
}

function discoverSearchQuery(period: DiscoverPeriod, language: string): string {
  const minimumStars =
    period === "day" ? 50 : period === "week" ? 100 : period === "month" ? 250 : 1000;
  const parts = [
    `stars:>${minimumStars}`,
    `pushed:>=${discoverSince(period)}`,
    "archived:false",
    "fork:false",
  ];
  if (language) {
    parts.push(`language:"${language.replaceAll('"', "")}"`);
  }
  return parts.join(" ");
}

function quotaFromResponse(response: Response, env: Env): ApiQuota {
  const remaining = parseHeaderInt(response.headers.get("x-ratelimit-remaining"));
  const limit = parseHeaderInt(response.headers.get("x-ratelimit-limit"));
  const reset = parseHeaderInt(response.headers.get("x-ratelimit-reset"));
  return {
    source: env.GITHUB_TOKEN ? "shared" : "anonymous",
    account: null,
    remaining,
    limit,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: response.headers.get("x-ratelimit-resource"),
  };
}

function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function discoverFreshness(repo: GitHubSearchRepository): Project["freshness"] {
  const stars = repo.stargazers_count ?? 0;
  const pushedAt = repo.pushed_at ? Date.parse(repo.pushed_at) : 0;
  const ageDays = pushedAt ? Math.max(0, (Date.now() - pushedAt) / 86400000) : 365;
  if (stars >= 1000 && ageDays <= 7) return "hot";
  if (stars >= 250 && ageDays <= 30) return "busy";
  return "warm";
}

function discoverProject(repo: GitHubSearchRepository): Project {
  const owner = repo.owner.login;
  const fullName = repo.full_name;
  const defaultBranch = repo.default_branch || "main";
  const releaseUrl = `${repo.html_url}/releases`;
  return {
    owner,
    name: repo.name,
    fullName,
    description: repo.description,
    url: repo.html_url,
    defaultBranch,
    language: repo.language,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    openPullRequests: 0,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived ?? false,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: defaultBranch,
    latestCommitDate: repo.pushed_at,
    version: "repo search",
    releaseName: null,
    releaseUrl,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: discoverFreshness(repo),
  };
}

function discoverErrorPayload(
  period: DiscoverPeriod,
  language: string,
  env: Env,
  error: unknown,
): DashboardPayload {
  const generatedAt = new Date().toISOString();
  return {
    title: "GitHub Hot",
    subtitle: `GitHub repository search for ${language ? `${language} projects ` : "projects "}${discoverPeriodLabel(period)}.`,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: discoverLimit,
    },
    cache: {
      state: "error",
      stale: true,
      capped: false,
      repoLimit: discoverLimit,
      generatedAt,
      message: discoveryErrorMessage(error),
    },
    totals: dashboardTotals([]),
    projects: [],
  };
}

function discoveryErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub repository search quota is exhausted. Try again after the search quota resets.";
  }
  return dashboardErrorMessage(error);
}

async function discoverPayload(
  period: DiscoverPeriod,
  language: string,
  env: Env,
): Promise<DashboardPayload> {
  const search = new URL("https://api.github.com/search/repositories");
  search.searchParams.set("q", discoverSearchQuery(period, language));
  search.searchParams.set("sort", "stars");
  search.searchParams.set("order", "desc");
  search.searchParams.set("per_page", String(discoverLimit));

  const response = await workerFetch(search.toString(), {
    headers: {
      accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const body = parseGitHubResponse(
    gitHubSearchRepositoryListSchema,
    await response.json(),
    "repository search",
  );
  if (!response.ok) {
    const message = body.message ?? `GitHub repository search failed: ${response.status}`;
    if (response.status === 403 || /rate limit|secondary rate/i.test(message)) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(message);
  }

  const projects = (body.items ?? [])
    .filter((repo) => !repo.private && !repo.fork && !repo.archived)
    .map(discoverProject);
  const generatedAt = new Date().toISOString();
  const total = body.total_count ?? projects.length;
  return {
    title: "GitHub Hot",
    subtitle: `Popular public GitHub repositories active ${discoverPeriodLabel(period)}${
      language ? ` in ${language}` : ""
    }.`,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: [],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: discoverLimit,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: total > projects.length,
      repoLimit: discoverLimit,
      generatedAt,
      quota: quotaFromResponse(response, env),
      message: "approximated with GitHub repository search; star velocity needs GH Archive",
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

async function discoverResponse(env: Env, url: URL): Promise<Response> {
  const period = discoverPeriod(url);
  const language = discoverLanguage(url);
  const key = discoverCacheKey(period, language);
  const cached = await readCached(env, key);
  const ageMs = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;
  if (cached && ageMs < discoverCacheTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  try {
    const payload = await discoverPayload(period, language, env);
    await writeCached(env, key, payload);
    return jsonResponse(payload);
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withCacheState(cached, "stale", `${discoveryErrorMessage(error)} Showing cached search.`),
      );
    }
    const payload = discoverErrorPayload(period, language, env, error);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
}

async function acquireBuildLock(env: Env, key: string): Promise<BuildLock | null> {
  if (!env.DASHBOARD_LOCKS) {
    return {
      refresh: async () => undefined,
      release: async () => undefined,
    };
  }

  try {
    const token = randomNonce();
    const id = env.DASHBOARD_LOCKS.idFromName(key);
    const stub = env.DASHBOARD_LOCKS.get(id);
    const response = await stub.fetch(
      new Request("https://releasebar.internal/acquire", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    );
    if (response.status === 409) {
      return null;
    }
    if (!response.ok) {
      return {
        refresh: async () => undefined,
        release: async () => undefined,
      };
    }
    const sendToken = (pathname: string) =>
      stub.fetch(
        new Request(`https://releasebar.internal/${pathname}`, {
          method: "POST",
          body: JSON.stringify({ token }),
        }),
      );
    return {
      refresh: async () => {
        await sendToken("refresh").catch(() => undefined);
      },
      release: async () => {
        await sendToken("release").catch(() => undefined);
      },
    };
  } catch {
    return {
      refresh: async () => undefined,
      release: async () => undefined,
    };
  }
}

async function rebuild(dashboard: DashboardRequest, env: Env): Promise<DashboardPayload> {
  const existing = locks.get(dashboard.key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const payload = await buildDashboard({
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      owners: dashboard.owners,
      includeRepos: dashboard.includeRepos,
      excludeRepos: dashboard.profile?.hiddenRepos,
      ...optionsFromUrl(dashboard.url),
      repoLimit,
      repoScanLimit,
      token: dashboard.token ?? env.GITHUB_TOKEN,
      quotaSource:
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
      quotaAccount: dashboard.quotaAccount ?? null,
      fetch: workerFetch,
      projectCache: env.DASHBOARD_CACHE,
    });
    const profiled = withProfile(payload, dashboard.profile);
    await writeCached(env, dashboard.key, profiled);
    await rememberHotDashboard(env, dashboard.key, profiled);
    return profiled;
  })();

  locks.set(dashboard.key, promise);
  try {
    return await promise;
  } finally {
    locks.delete(dashboard.key);
  }
}

async function rebuildWithBuildLock(
  dashboard: DashboardRequest,
  env: Env,
): Promise<DashboardPayload | null> {
  const lock = await acquireBuildLock(env, dashboard.key);
  if (!lock) {
    return null;
  }

  const refresh = globalThis.setInterval(() => {
    void lock.refresh();
  }, buildLockRefreshMs);
  try {
    return await rebuild(dashboard, env);
  } finally {
    globalThis.clearInterval(refresh);
    await lock.release();
  }
}

function errorPayload(dashboard: DashboardRequest, env: Env, message: string): DashboardPayload {
  return statusPayload(dashboard, env, "error", message, new Date().toISOString());
}

function unresolvedDashboardRequest(
  ownerSlugs: string[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    ownerSlugs.map((login) => ({ type: "user", login })),
    includeRepos,
    profile,
    key,
    url,
    token,
  );
}

function rebuildingPayload(dashboard: DashboardRequest, env: Env): DashboardPayload {
  return statusPayload(
    dashboard,
    env,
    "rebuilding",
    "dashboard build queued",
    new Date().toISOString(),
  );
}

function cacheBuildError(dashboard: DashboardRequest, env: Env, error: unknown): Promise<void> {
  return writeCached(
    env,
    dashboard.key,
    errorPayload(dashboard, env, dashboardErrorMessage(error)),
    5 * 60,
  );
}

function statusPayload(
  dashboard: DashboardRequest,
  env: Env,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message: string,
  generatedAt: string,
): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: dashboard.subtitle,
    canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
    generatedAt,
    owners: dashboard.owners,
    ...(dashboard.profile ? { profile: dashboard.profile } : {}),
    options: {
      ...optionsFromUrl(dashboard.url),
      repoLimit,
    },
    cache: {
      state,
      stale: true,
      capped: false,
      repoLimit,
      generatedAt,
      quota: quotaForDashboard(dashboard, env),
      message,
    },
    totals: {
      repos: 0,
      released: 0,
      unreleased: 0,
      commitsSinceRelease: 0,
    },
    projects: [],
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function profileFromInput(owner: string, input: ProfileInput, user: AuthUser): DashboardProfile {
  const normalizedOwner = slugOwner(owner);
  const includeOwners = uniqueSorted(
    stringList(input.includeOwners)
      .map(slugOwner)
      .filter((value) => validOwnerSlug(value) && value !== normalizedOwner),
  );
  const includeRepos = uniqueSorted(
    stringList(input.includeRepos)
      .map((value) => value.trim().replace(/^@/, "").toLowerCase())
      .filter(validRepoSlug),
  );
  if (includeOwners.length + includeRepos.length > maxCustomSources) {
    throw new Error(`too many custom sources; max ${maxCustomSources}`);
  }
  return {
    owner: normalizedOwner,
    includeOwners,
    includeRepos,
    hiddenOwners: uniqueSorted(
      stringList(input.hiddenOwners).map(slugOwner).filter(validOwnerSlug),
    ),
    hiddenRepos: uniqueSorted(
      stringList(input.hiddenRepos)
        .map((value) => value.trim().replace(/^@/, "").toLowerCase())
        .filter(validRepoSlug),
    ),
    updatedAt: new Date().toISOString(),
    updatedBy: user.login,
  };
}

async function profileResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const owner = slugOwner(url.pathname.replace(/^\/api\/profile\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(owner)) {
    return jsonResponse({ error: "invalid owner" }, 400, { "cache-control": "no-store" });
  }
  const session = await currentSession(request, env);
  const canEdit = session?.user.login.toLowerCase() === owner;

  if (request.method === "GET") {
    return jsonResponse({ profile: await readProfile(env, owner), canEdit }, 200, {
      "cache-control": "no-store",
    });
  }
  if (!session) {
    return jsonResponse({ error: "login required" }, 401, { "cache-control": "no-store" });
  }
  if (!canEdit) {
    return jsonResponse({ error: "only the dashboard owner can edit this default" }, 403, {
      "cache-control": "no-store",
    });
  }
  if (request.method === "DELETE") {
    await deleteProfile(env, owner);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile: null, canEdit: true }, 200, { "cache-control": "no-store" });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405, {
      allow: "GET, POST, DELETE",
      "cache-control": "no-store",
    });
  }

  const input = (await request.json().catch(() => null)) as ProfileInput | null;
  if (!input) {
    return jsonResponse({ error: "invalid profile" }, 400, { "cache-control": "no-store" });
  }
  try {
    const profile = profileFromInput(owner, input, session.user);
    await writeProfile(env, profile);
    await env.DASHBOARD_CACHE?.delete?.(hotCacheKey);
    return jsonResponse({ profile, canEdit: true }, 200, { "cache-control": "no-store" });
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, { "cache-control": "no-store" });
  }
}

async function ownerResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const rawOwner = url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "";
  const primaryOwner = rawOwner === "dashboard" ? null : slugOwner(rawOwner);
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }

  const options = optionsFromUrl(url);
  const profile = primaryOwner ? await readProfile(env, primaryOwner) : null;
  const hiddenProfileOwners = new Set(profile?.hiddenOwners ?? []);
  const hiddenProfileRepos = new Set(profile?.hiddenRepos ?? []);
  const extraOwnerSlugs = uniqueSorted([
    ...(profile?.includeOwners ?? []),
    ...ownerListFromUrl(url, primaryOwner ?? undefined),
  ]).filter((owner) => owner !== primaryOwner && !hiddenProfileOwners.has(owner));
  const includeRepos = uniqueSorted([
    ...(profile?.includeRepos ?? []),
    ...repoListFromUrl(url),
  ]).filter(
    (repo) => !hiddenProfileOwners.has(repo.split("/")[0] ?? "") && !hiddenProfileRepos.has(repo),
  );
  if (extraOwnerSlugs.length + includeRepos.length > maxCustomSources) {
    return jsonResponse({ error: `too many custom sources; max ${maxCustomSources}` }, 400, {
      "cache-control": "no-store",
    });
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return jsonResponse({ error: "at least one owner or repo is required" }, 400);
  }
  const ownerSlugs =
    primaryOwner && !hiddenProfileOwners.has(primaryOwner)
      ? [primaryOwner, ...extraOwnerSlugs]
      : extraOwnerSlugs;
  const key = dashboardCacheKey({
    owner: primaryOwner ?? "custom",
    owners: extraOwnerSlugs,
    repos: includeRepos,
    salt: profile?.updatedAt,
    ...options,
    schemaVersion: dashboardSchemaVersion,
  });
  const cached = await readCached(env, key);
  const ageMs = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;
  const tokenSources = { owners: ownerSlugs, repos: includeRepos };
  const requestToken = () => requestInstallationToken(request, env, tokenSources);

  if (cached?.cache?.state === "error") {
    context.waitUntil(
      requestToken()
        .catch(() => null)
        .then((token) => {
          const dashboard = cachedDashboardRequest(cached, includeRepos, key, url, token);
          return rebuildWithBuildLock(dashboard, env).catch((error) =>
            cacheBuildError(dashboard, env, error),
          );
        }),
    );
    return jsonResponse(cached, errorStatus(cached.cache.message ?? ""), {
      "cache-control": "no-store",
    });
  }

  if (cached && ageMs < fullTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  if (cached) {
    context.waitUntil(
      requestToken()
        .catch(() => null)
        .then((token) => {
          const dashboard = cachedDashboardRequest(cached, includeRepos, key, url, token);
          return rebuildWithBuildLock(dashboard, env).catch(() => undefined);
        }),
    );
    return jsonResponse(withCacheState(cached, "stale"));
  }

  const token = await requestToken().catch(() => null);
  let owners: Owner[] | null;
  try {
    owners = await resolveOwners(ownerSlugs, env, token?.token);
  } catch (error) {
    const dashboard = unresolvedDashboardRequest(
      ownerSlugs,
      includeRepos,
      profile,
      key,
      url,
      token,
    );
    const payload = errorPayload(dashboard, env, dashboardErrorMessage(error));
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
  if (!owners) {
    return jsonResponse({ error: "owner not found" }, 404, {
      "cache-control": "no-store",
    });
  }

  const dashboard = dashboardRequest(owners, includeRepos, profile, key, url, token);
  const build = rebuildWithBuildLock(dashboard, env);
  try {
    const payload = await Promise.race([
      build,
      new Promise<typeof buildPending>((resolve) => {
        setTimeout(() => resolve(buildPending), coldBuildWaitMs);
      }),
    ]);
    if (payload === buildPending || payload === null) {
      context.waitUntil(build.catch((error) => cacheBuildError(dashboard, env, error)));
      const partial = await partialDashboardPayload(dashboard, env, ownerSlugs);
      if (partial) {
        return jsonResponse(partial, 200, {
          "cache-control": "no-store",
        });
      }
      return jsonResponse(rebuildingPayload(dashboard, env), 202, {
        "cache-control": "no-store",
      });
    }
    return jsonResponse(payload);
  } catch (error) {
    const payload = errorPayload(dashboard, env, dashboardErrorMessage(error));
    await writeCached(env, key, payload, 5 * 60);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
}

function cachedDashboardRequest(
  payload: DashboardPayload,
  includeRepos: string[],
  key: string,
  url: URL,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(payload.owners, includeRepos, payload.profile ?? null, key, url, token);
}

function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  token?: RequestToken | null,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    profile,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
    ...(token
      ? {
          token: token.token,
          quotaSource: token.quotaSource,
          quotaAccount: token.quotaAccount,
        }
      : {}),
  };
}

export class DashboardBuildLock {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/acquire") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) {
        return new Response(null, { status: 400 });
      }
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing && existing.expiresAt > Date.now()) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: body.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/release") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (existing?.token === body?.token) {
        await this.state.storage.delete("lock");
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/refresh") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const existing = await this.state.storage.get<StoredBuildLock>("lock");
      if (!existing || existing.token !== body?.token) {
        return new Response(null, { status: 409 });
      }
      await this.state.storage.put("lock", {
        token: existing.token,
        expiresAt: Date.now() + buildLockTtlMs,
      } satisfies StoredBuildLock);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isHead = request.method === "HEAD";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const profileWrite =
      url.pathname.startsWith("/api/profile/") &&
      (request.method === "POST" || request.method === "DELETE");
    if (request.method !== "GET" && !isHead && !profileWrite) {
      return jsonResponse({ error: "method not allowed" }, 405, { allow: "GET" });
    }
    const response = await routeRequest(request, env, context, url);
    if (!isHead) {
      return response;
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};

async function routeRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname.startsWith("/og/")) {
    const label = decodeURIComponent(url.pathname.replace(/^\/og\//, "").replace(/\.svg$/, ""));
    const title =
      label.startsWith("@") || label.includes("/") || !validOwnerSlug(label) ? label : `@${label}`;
    return socialImage(title);
  }
  if (url.pathname === "/api/me") {
    return meResponse(request, env);
  }
  if (url.pathname.startsWith("/api/profile/")) {
    return profileResponse(request, env);
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return authResponse(request, env);
  }
  if (url.pathname === "/api/_hot") {
    return hotResponse(env);
  }
  if (url.pathname === "/api/_discover") {
    return discoverResponse(env, url);
  }
  if (url.pathname.startsWith("/api/")) {
    return ownerResponse(request, env, context);
  }
  return assetResponse(request, env);
}
