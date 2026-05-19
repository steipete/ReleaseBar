import {
  calculateAudienceScore,
  type AudienceOrgSignal,
  type AudienceRepoSignal,
  type AudienceScoreTier,
} from "../scripts/lib/audience.js";
import {
  buildDashboard,
  dashboardCacheKey,
  GitHubRateLimitError,
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import * as v from "valibot";
import type { GenericSchema, InferOutput } from "valibot";
import {
  gitHubCheckRunsSchema,
  gitHubCodeFrequencySchema,
  gitHubCommitActivitySchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubInstallationSchema,
  gitHubInstallationListSchema,
  gitHubInstallationRepositoryListSchema,
  gitHubInstallationTokenSchema,
  gitHubLanguageSchema,
  gitHubOAuthTokenSchema,
  gitHubOAuthUserSchema,
  gitHubPublicEventListSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  gitHubSearchRepositoryListSchema,
  gitHubSearchCountSchema,
  gitHubStargazerListSchema,
  gitHubUserOrganizationListSchema,
  gitHubUserProfileSchema,
  gitHubUserRepositoryListSchema,
  hotIndexSchema,
  parseGitHubResponse,
  safeJsonParse,
  storedAuthSessionSchema,
  tryJsonParse,
  type GitHubInstallationRepository,
  type GitHubPublicEvent,
  type GitHubSearchRepository,
  type GitHubStargazer,
  type GitHubUserOrganization,
  type GitHubUserProfile,
  type GitHubUserRepository,
} from "./schemas.js";
import type {
  ApiQuota,
  AudienceRange,
  AuthInstallation,
  AuthPayload,
  AuthUser,
  ActivityRange,
  DashboardProfile,
  DashboardPayload,
  Owner,
  OwnerActivityEvent,
  OwnerActivityPayload,
  OwnerActivityRepository,
  OwnerActivitySummary,
  Project,
  RepoAudiencePayload,
  RepoAudienceUser,
  RepoDetailActivityPayload,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
  RepoDetailWorkTrend,
  AudienceScoreFactor,
  TrustProfilePayload,
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
  OPENAI_API_KEY?: string;
  OPENAI_SUMMARY_MODEL?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type UserTrustSignal = {
  score: number;
  tier: AudienceScoreTier;
};

const fullTtlMs = 60 * 60 * 1000;
const dashboardStorageTtlSeconds = 90 * 24 * 60 * 60;
const progressTtlSeconds = 7 * 24 * 60 * 60;
const maxDisplayStaleMs = 30 * 24 * 60 * 60 * 1000;
const installationTokenTtlSeconds = 50 * 60;
const installationAcknowledgementGraceMs = 15 * 60 * 1000;
const coldBuildWaitMs = 15 * 1000;
const progressiveBuildBudgetMs = 25 * 1000;
const progressWriteIntervalMs = 1100;
const buildLockTtlMs = 2 * 60 * 1000;
const buildLockRefreshMs = 30 * 1000;
const repoLimit = 200;
const repoScanBatchSize = 12;
const hotLimit = 50;
const hotOwnerLimit = 3;
const hotSourceLimit = 24;
const hotIndexLimit = 100;
const hotCacheTtlMs = 5 * 60 * 1000;
const discoverLimit = 40;
const discoverHydrateLimit = discoverLimit;
const discoverHydrateBatchSize = 12;
const discoverCacheTtlMs = 60 * 60 * 1000;
const repoDetailCacheTtlMs = 6 * 60 * 60 * 1000;
const repoDetailWarmingRefreshMs = 30 * 1000;
const repoAudienceCacheTtlMs = 6 * 60 * 60 * 1000;
const repoAudienceUserTtlSeconds = 7 * 24 * 60 * 60;
const repoAudienceStargazerLimit = 30;
const repoAudienceDeepUserLimit = 12;
const repoAudienceRanges: AudienceRange[] = ["week", "month"];
const repoAudienceUserRepoLimit = 8;
const releaseSummaryPromptVersion = 1;
const releaseSummaryCommitLimit = 500;
const activitySummaryPromptVersion = 2;
const activityEventPageLimit = 3;
const activitySummaryInputLimit = 120;
const maxCustomSources = 8;
const dashboardSchemaVersion = 5;
const previousDashboardSchemaVersion = 4;
const auxiliaryCacheSchemaVersion = 3;
const discoverCacheSchemaVersion = 4;
const dashboardCachePrefix = `dashboard:v${dashboardSchemaVersion}:`;
const previousDashboardCachePrefix = `dashboard:v${previousDashboardSchemaVersion}:`;
const dashboardCachePrefixes = [dashboardCachePrefix, previousDashboardCachePrefix];
const hotCacheKey = `hot:v${auxiliaryCacheSchemaVersion}`;
const hotIndexKey = `hot:index:v${auxiliaryCacheSchemaVersion}`;
const socialRepoCachePrefix = `social-repo:v${auxiliaryCacheSchemaVersion}:`;
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

function isRepoDetailApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "repos";
}

function isRepoAudienceApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "audience"
  );
}

function isRepoAudienceBackfillApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 6 &&
    parts[0] === "api" &&
    parts[1] === "repos" &&
    parts[4] === "audience" &&
    parts[5] === "backfill"
  );
}

function isRepoActivityApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return (
    parts.length === 5 && parts[0] === "api" && parts[1] === "repos" && parts[4] === "activity"
  );
}

function isOwnerActivityApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "activity";
}

function isOwnerEventsApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "api" && parts[2] === "events";
}

function isOwnerApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "api";
}

function isTrustProfileApiPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 && parts[0] === "api" && parts[1] === "users" && parts[3] === "trust";
}

type DashboardRequest = {
  owners: Owner[];
  includeRepos: string[];
  profile: DashboardProfile | null;
  subtitle: string;
  key: string;
  url: URL;
  includeReleaseData: boolean;
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
};

type RequestToken = {
  token: string;
  quotaSource: "app";
  quotaAccount: string | null;
};

type GitHubAuditArea =
  | "dashboard"
  | "discover"
  | "owner-activity"
  | "repo-activity"
  | "repo-audience"
  | "repo-detail"
  | "release-summary"
  | "trust-profile"
  | "social-card"
  | "auth";

const githubAuditAreas = new Set<GitHubAuditArea>([
  "dashboard",
  "discover",
  "owner-activity",
  "repo-activity",
  "repo-audience",
  "repo-detail",
  "release-summary",
  "trust-profile",
  "social-card",
  "auth",
]);

function githubRequestOptions(
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
): { accept: string; auditArea: GitHubAuditArea } {
  if (githubAuditAreas.has(acceptOrAuditArea as GitHubAuditArea)) {
    return {
      accept: "application/vnd.github+json",
      auditArea: acceptOrAuditArea as GitHubAuditArea,
    };
  }
  return { accept: acceptOrAuditArea, auditArea };
}

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

type StoredBuildProgress = {
  scannedRepos: string[];
  projects: Project[];
  updatedAt: string;
};

type StoredSocialRepo = {
  generatedAt: string;
  project: Project;
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
  installations?: AuthInstallation[];
  installationsUpdatedAt?: string;
};

const storedInstallationSchema = v.object({
  id: v.number(),
  accountLogin: v.string(),
  accountType: v.picklist(["user", "org"]),
  accountUrl: v.string(),
  avatarUrl: v.string(),
  repositorySelection: v.picklist(["all", "selected"]),
  repositories: v.array(v.string()),
  updatedAt: v.optional(v.string()),
});

type StoredInstallationRecord = AuthInstallation & {
  updatedAt?: string;
};

function isPublicInstallationRepository(repo: GitHubInstallationRepository): boolean {
  if (repo.private === true) {
    return false;
  }
  return repo.private === false || repo.visibility === "public";
}

function installationRegistryKey(accountLogin: string): string {
  return `auth:installation:v1:${slugOwner(accountLogin)}`;
}

function installationMissKey(accountLogin: string): string {
  return `auth:installation-miss:v1:${slugOwner(accountLogin)}`;
}

function normalizedInstallation(installation: AuthInstallation): StoredInstallationRecord {
  return {
    ...installation,
    accountLogin: slugOwner(installation.accountLogin),
    repositories: installation.repositories.map((repo) => repo.toLowerCase()).filter(validRepoSlug),
    updatedAt: new Date().toISOString(),
  };
}

async function writeInstallationRegistry(
  env: Env,
  installations: AuthInstallation[],
): Promise<void> {
  if (!env.DASHBOARD_CACHE) return;
  await Promise.all(
    installations.map((installation) => {
      const normalized = normalizedInstallation(installation);
      return env.DASHBOARD_CACHE!.put(
        installationRegistryKey(normalized.accountLogin),
        JSON.stringify(normalized),
        { expirationTtl: dashboardStorageTtlSeconds },
      );
    }),
  );
}

async function readInstallationRegistry(
  env: Env,
  accountLogin: string,
): Promise<StoredInstallationRecord | null> {
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  const raw = await env.DASHBOARD_CACHE?.get(installationRegistryKey(account));
  if (!raw) return null;
  return safeJsonParse(storedInstallationSchema, raw, `app installation ${account}`);
}

function auditGitHubTokenUse(
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
): void {
  console.log(
    JSON.stringify({
      event: "github_token_use",
      area,
      path,
      status,
      quota: {
        source: quota.source,
        account: quota.account,
        remaining: quota.remaining,
        limit: quota.limit,
        resetAt: quota.resetAt,
        resource: quota.resource,
      },
    }),
  );
}

function auditGitHubFetch(
  area: GitHubAuditArea,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
): typeof fetch {
  return async (input, init) => {
    const response = await workerFetch(input, init);
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      auditGitHubTokenUse(
        area,
        `${url.pathname}${url.search}`,
        response.status,
        quotaFromGitHubResponse(response, quotaSource, quotaAccount),
      );
    }
    return response;
  };
}

type TokenSources = {
  owners: string[];
  repos: string[];
};

type InitialPageData =
  | { route: "dashboard"; payload: DashboardPayload }
  | { route: "repo"; payload: RepoDetailPayload };

function shouldServeAppShell(url: URL): boolean {
  if (url.pathname.split("/").filter(Boolean)[0] === "-" && repoFullNameFromPath(url.pathname)) {
    return true;
  }
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

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function injectInitialPageData(html: string, data: InitialPageData | null): string {
  if (!data) return html;
  const script = `<script id="releasebar-initial-data" type="application/json">${escapeJsonForHtml(data)}</script>`;
  return html.includes('<script type="module"')
    ? html.replace('<script type="module"', `${script}<script type="module"`)
    : html.replace("</head>", `${script}</head>`);
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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
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
  const record = await currentSessionRecord(request, env);
  return record?.session ?? null;
}

async function currentSessionRecord(
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

function repoFullNameFromPath(pathname: string): string | null {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const escaped = parts[0] === "-";
  if ((!escaped && parts.length !== 2) || (escaped && parts.length !== 3)) return null;
  const owner = slugOwner(escaped ? (parts[1] ?? "") : (parts[0] ?? ""));
  const repo = (escaped ? (parts[2] ?? "") : (parts[1] ?? "")).trim().toLowerCase();
  const fullName = `${owner}/${repo}`;
  return validRepoSlug(fullName) ? fullName : null;
}

function ownerFromPagePath(pathname: string): string | null {
  if (repoFullNameFromPath(pathname)) return null;
  const owner = slugOwner(pathname.split("/").filter(Boolean)[0] ?? "");
  return validOwnerSlug(owner) ? owner : null;
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
  quotaSource: ApiQuota["source"] = token || env.GITHUB_TOKEN ? "shared" : "anonymous",
  quotaAccount: string | null = null,
): Promise<Owner[] | null> {
  const owners: Owner[] = [];
  for (const owner of ownerSlugs) {
    const resolved = await resolveOwnerType(owner, {
      fetch: auditGitHubFetch("dashboard", quotaSource, quotaAccount),
      token: token ?? env.GITHUB_TOKEN,
    });
    if (!resolved) {
      return null;
    }
    owners.push(resolved);
  }
  return owners;
}

async function initialPageData(
  request: Request,
  url: URL,
  env: Env,
): Promise<InitialPageData | null> {
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
    const initialData = await initialPageData(request, originalUrl, env).catch(() => null);
    const html = injectInitialPageData(
      (await response.text())
        .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(label)} · release.bar</title>`)
        .replace(
          /<meta property="og:title" content="[^"]*" \/>/,
          `<meta property="og:title" content="${escapeHtml(label)} · release.bar" />`,
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
          `<meta name="twitter:title" content="${escapeHtml(label)} · release.bar" />`,
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

function socialLabel(url: URL): string {
  const repo = repoFullNameFromPath(url.pathname);
  if (repo) return repo;
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

type SocialCard = {
  title: string;
  avatarUrl: string | null;
  detail: string;
  metric: string;
};

const socialNumberFormat = new Intl.NumberFormat("en", { notation: "compact" });

function ownerAvatarUrl(owner: string, size = 240): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;
}

function socialOwnerFromLabel(label: string): string | null {
  const repo = validRepoSlug(label) ? label.split("/")[0] : null;
  if (repo) return repo;
  const owner = label.match(/^@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)/i)?.[1];
  return owner ? slugOwner(owner) : null;
}

function socialRepoMetric(project: Project | null): string {
  if (!project) return "release freshness dashboard";
  const commits =
    project.commitsSinceRelease === null
      ? "commits n/a"
      : `${socialNumberFormat.format(project.commitsSinceRelease)} commits since release`;
  return `${project.version} · ${commits}`;
}

function socialLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function socialRepoCacheKey(owner: string, repo: string): string {
  return `${socialRepoCachePrefix}${slugOwner(owner)}/${repo.toLowerCase()}`;
}

function socialRepoAgeMs(entry: StoredSocialRepo | null): number {
  if (!entry) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(entry.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readSocialRepo(
  env: Env,
  owner: string,
  repo: string,
): Promise<StoredSocialRepo | null> {
  const raw = await env.DASHBOARD_CACHE?.get(socialRepoCacheKey(owner, repo));
  const parsed = raw ? tryJsonParse<StoredSocialRepo>(raw, `social repo ${owner}/${repo}`) : null;
  return parsed?.project?.fullName?.toLowerCase() === `${slugOwner(owner)}/${repo.toLowerCase()}`
    ? parsed
    : null;
}

async function writeSocialRepo(env: Env, project: Project): Promise<void> {
  await env.DASHBOARD_CACHE?.put(
    socialRepoCacheKey(project.owner, project.name),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      project,
    } satisfies StoredSocialRepo),
    { expirationTtl: dashboardStorageTtlSeconds },
  );
}

async function refreshSocialRepo(
  owner: string,
  repo: string,
  request: Request,
  env: Env,
): Promise<void> {
  const project = await buildSocialRepoProject(owner, repo, request, env);
  if (project) {
    await writeSocialRepo(env, project);
  }
}

async function buildSocialRepoProject(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<Project | null> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = (_quota: ApiQuota) => undefined;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository social card",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
  );
  if (repo.private) return null;
  const releases = await detailGitHubJson(
    `${path}/releases?per_page=5`,
    v.array(gitHubReleaseSchema),
    "repository social card releases",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "social-card",
  );
  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        detailGitHubJson(
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "repository social card compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
          "social-card",
        ),
        null,
      )
    : null;
  const project = releaseProject(repo);
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  return project;
}

async function socialRepoProject(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Project | null> {
  if (!validRepoSlug(label)) return null;
  const [owner, repo] = label.split("/");
  if (!owner || !repo) return null;
  const key = repoDetailCacheKey(owner, repo);
  const cached = await readRepoDetail(env, key);
  const ageMs = repoDetailAgeMs(cached);
  if (cached && ageMs > repoDetailCacheTtlMs) {
    context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
  }
  if (cached && ageMs <= maxDisplayStaleMs) return cached.project;
  const social = await readSocialRepo(env, owner, repo);
  const socialAgeMs = socialRepoAgeMs(social);
  if (social && socialAgeMs > repoDetailCacheTtlMs) {
    context.waitUntil(refreshSocialRepo(owner, repo, request, env).catch(() => undefined));
  }
  if (social && socialAgeMs <= maxDisplayStaleMs) return social.project;
  try {
    const project = await buildSocialRepoProject(owner, repo, request, env);
    if (project) {
      await writeSocialRepo(env, project);
    }
    return project;
  } catch {
    return null;
  }
}

async function socialCardForLabel(
  label: string,
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<SocialCard> {
  const project = await socialRepoProject(label, request, env, context);
  const owner = project?.owner ?? socialOwnerFromLabel(label);
  return {
    title: label,
    avatarUrl: owner ? ownerAvatarUrl(owner) : null,
    detail: project?.description ?? "Open source release freshness",
    metric: socialRepoMetric(project),
  };
}

function socialImage(card: SocialCard): Response {
  const title = escapeHtml(socialLine(card.title, 42));
  const detail = escapeHtml(socialLine(card.detail, 68));
  const metric = escapeHtml(socialLine(card.metric, 58));
  const avatar = card.avatarUrl ? escapeHtml(card.avatarUrl) : null;
  const titleSize =
    card.title.length > 34 ? 54 : card.title.length > 24 ? 66 : card.title.length > 17 ? 82 : 104;
  const titleX = avatar ? 276 : 96;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <clipPath id="avatarClip"><rect x="96" y="198" width="148" height="148" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#080908"/>
  <path d="M0 124H1200M0 248H1200M0 372H1200M0 496H1200M160 0V630M400 0V630M640 0V630M880 0V630M1120 0V630" stroke="#182014" stroke-width="1"/>
  <rect x="72" y="70" width="1056" height="490" rx="0" fill="none" stroke="#8cff4b" stroke-width="2"/>
  <text x="96" y="148" fill="#a8ff6b" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="38" letter-spacing="0">ReleaseBar</text>
  ${
    avatar
      ? `<rect x="96" y="198" width="148" height="148" rx="28" fill="#121b0f" stroke="#8cff4b" stroke-width="2"/>
  <image x="96" y="198" width="148" height="148" href="${avatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
      : ""
  }
  <text x="${titleX}" y="318" fill="#f2ffe9" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="${titleSize}" font-weight="700" letter-spacing="0">${title}</text>
  <text x="96" y="424" fill="#a8ff6b" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="34" font-weight="700" letter-spacing="0">${metric}</text>
  <text x="96" y="474" fill="#8f9b89" font-family="SFMono-Regular, ui-monospace, Menlo, Consolas, monospace" font-size="28" letter-spacing="0">${detail}</text>
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
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      ...corsHeaders,
      ...headers,
    },
  });
}

function openApiSpec(origin: string): Record<string, unknown> {
  const cacheState = {
    type: "object",
    required: ["state", "stale", "generatedAt"],
    properties: {
      state: { enum: ["fresh", "stale", "partial", "warming", "error"] },
      stale: { type: "boolean" },
      generatedAt: { type: "string", format: "date-time" },
      message: { type: "string" },
      quota: {
        type: "object",
        properties: {
          source: { enum: ["app", "shared", "anonymous"] },
          account: { type: ["string", "null"] },
          remaining: { type: ["number", "null"] },
          limit: { type: ["number", "null"] },
          resetAt: { type: ["string", "null"], format: "date-time" },
          resource: { type: ["string", "null"] },
        },
      },
    },
  };
  const trustFactor = {
    type: "object",
    required: [
      "key",
      "label",
      "value",
      "maxValue",
      "weight",
      "weightedValue",
      "detail",
      "sentiment",
    ],
    properties: {
      key: { enum: ["age", "profile", "orgs", "reach", "builder", "recency", "risk"] },
      label: { type: "string" },
      value: { type: "number" },
      maxValue: { type: "number" },
      weight: { type: "number" },
      weightedValue: { type: "number" },
      detail: { type: "string" },
      sentiment: { enum: ["positive", "neutral", "negative"] },
    },
  };
  const trustDimensions = {
    type: "object",
    required: ["trust", "influence", "builder", "recency", "risk"],
    properties: {
      trust: { type: "number", minimum: 0, maximum: 100 },
      influence: { type: "number", minimum: 0, maximum: 100 },
      builder: { type: "number", minimum: 0, maximum: 100 },
      recency: { type: "number", minimum: 0, maximum: 100 },
      risk: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: "Account safety score. 100 means no obvious public-account risk signals.",
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "ReleaseBar Public API",
      version: "0.1.0",
      description:
        "Cached public GitHub release, people trust, org signal, and stargazer audience context for dashboards and PR-triage agents.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/users/{login}/trust": {
        get: {
          summary: "Get cached public people trust or org signal context for one GitHub profile",
          parameters: [{ name: "login", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "People trust or org signal profile",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/TrustProfile" } },
              },
            },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience": {
        get: {
          summary: "Get cached recent stargazer audience percentages and scored users",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
            { name: "range", in: "query", schema: { enum: ["week", "month"], default: "month" } },
          ],
          responses: {
            "200": {
              description: "Repository audience",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RepoAudience" } },
              },
            },
            "403": { description: "GitHub App quota required for cold audience builds" },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience/backfill": {
        post: {
          summary: "Warm week and month audience caches with GitHub App quota",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Backfill state",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RepoAudienceBackfill" },
                },
              },
            },
            "403": { description: "GitHub App quota required" },
          },
        },
      },
    },
    components: {
      schemas: {
        CacheState: cacheState,
        TrustDimensions: trustDimensions,
        TrustFactor: trustFactor,
        TrustProfile: {
          type: "object",
          required: [
            "login",
            "type",
            "profileKind",
            "scoreLabel",
            "score",
            "tier",
            "dimensions",
            "factors",
            "cache",
          ],
          properties: {
            login: { type: "string" },
            type: { enum: ["user", "org"] },
            profileKind: { enum: ["user_trust", "org_signal"] },
            scoreLabel: { enum: ["trust score", "org signal"] },
            score: { type: "number", minimum: 0, maximum: 100 },
            tier: { enum: ["high", "medium", "low", "bot"] },
            accountAgeDays: { type: ["number", "null"] },
            reasons: { type: "array", items: { type: "string" } },
            dimensions: { $ref: "#/components/schemas/TrustDimensions" },
            factors: { type: "array", items: { $ref: "#/components/schemas/TrustFactor" } },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudience: {
          type: "object",
          required: ["fullName", "range", "totals", "users", "cache"],
          properties: {
            fullName: { type: "string" },
            range: { enum: ["week", "month"] },
            totals: {
              type: "object",
              required: [
                "stargazers",
                "stargazersSampled",
                "highSignalPercent",
                "mediumSignalPercent",
                "lowSignalPercent",
                "botPercent",
              ],
              properties: {
                stargazers: { type: "number" },
                stargazersSampled: { type: "number" },
                highSignal: { type: "number" },
                mediumSignal: { type: "number" },
                lowSignal: { type: "number" },
                bots: { type: "number" },
                highSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                mediumSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                lowSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                botPercent: { type: "number", minimum: 0, maximum: 100 },
              },
            },
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  login: { type: "string" },
                  score: { type: "number" },
                  tier: { enum: ["high", "medium", "low", "bot"] },
                  trustScore: { type: "number" },
                  trustTier: { enum: ["high", "medium", "low", "bot"] },
                  dimensions: { $ref: "#/components/schemas/TrustDimensions" },
                },
              },
            },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudienceBackfill: {
          type: "object",
          required: ["fullName", "ranges", "quota", "message"],
          properties: {
            fullName: { type: "string" },
            ranges: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  range: { enum: ["week", "month"] },
                  state: { enum: ["busy", "fresh", "rebuilt"] },
                  users: { type: "number" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              },
            },
            quota: { type: "object" },
            message: { type: "string" },
          },
        },
      },
    },
  };
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
  const record = await currentSessionRecord(request, env);
  const session = record?.session ?? null;
  const liveInstallations = session
    ? await githubInstallations(session.accessToken).catch(() => null)
    : null;
  const acknowledgedInstallations = session
    ? fallbackInstallations(session, liveInstallations)
    : [];
  const installations = session
    ? await resolvedInstallations(env, session, liveInstallations, acknowledgedInstallations)
    : [];
  if (record && liveInstallations && liveInstallations.length > 0) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations,
      installationsUpdatedAt:
        acknowledgedInstallations.length > 0
          ? record.session.installationsUpdatedAt
          : new Date().toISOString(),
    });
  } else if (
    record &&
    installations.length > 0 &&
    JSON.stringify(record.session.installations ?? []) !== JSON.stringify(installations)
  ) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations,
      installationsUpdatedAt: new Date().toISOString(),
    });
  } else if (
    record &&
    liveInstallations &&
    installations.length === 0 &&
    (record.session.installations?.length ?? 0) > 0
  ) {
    await writeSessionRecord(env, record.id, {
      ...record.session,
      installations: [],
      installationsUpdatedAt: new Date().toISOString(),
    });
  }
  const coverage = session
    ? sourceCoverage(
        installations,
        currentReturnTo(url),
        url.origin,
        appTokenConfigured(env),
        session.user.login,
      )
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

async function githubAppInstallationsForSession(
  env: Env,
  session: StoredAuthSession,
): Promise<AuthInstallation[]> {
  if (!appTokenConfigured(env)) return [];
  const jwt = await githubAppJwt(env);
  const accountLogin = session.user.login.toLowerCase();
  const installations: AuthInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) break;
    const result = parseGitHubResponse(
      v.array(gitHubInstallationSchema),
      await response.json(),
      "app installation list",
    );
    const batch = result;
    for (const installation of batch) {
      const account = installation.account;
      if (!account || account.login.toLowerCase() !== accountLogin) continue;
      const repositories =
        installation.repository_selection === "selected"
          ? await githubAppInstallationRepositories(env, installation.id)
          : [];
      installations.push({
        id: installation.id,
        accountLogin,
        accountType: account.type === "Organization" ? "org" : "user",
        accountUrl: account.html_url,
        avatarUrl: account.avatar_url,
        repositorySelection: installation.repository_selection,
        repositories,
      });
    }
    if (batch.length < 100) break;
  }
  return installations;
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

function mergeInstallations(
  liveInstallations: AuthInstallation[],
  acknowledgedInstallations: AuthInstallation[] = [],
): AuthInstallation[] {
  const merged = new Map<number, AuthInstallation>();
  for (const installation of acknowledgedInstallations) {
    merged.set(installation.id, installation);
  }
  for (const installation of liveInstallations) {
    merged.set(installation.id, installation);
  }
  return [...merged.values()];
}

function fallbackInstallations(
  session: StoredAuthSession,
  liveInstallations: AuthInstallation[] | null,
): AuthInstallation[] {
  const acknowledged = session.installations ?? [];
  if (acknowledged.length === 0) return [];
  if (!liveInstallations) return acknowledged;
  const acknowledgedAt = Date.parse(session.installationsUpdatedAt ?? "");
  const recentlyAcknowledged =
    Number.isFinite(acknowledgedAt) &&
    Date.now() - acknowledgedAt <= installationAcknowledgementGraceMs;
  return recentlyAcknowledged
    ? acknowledged.filter(
        (installation) => !liveInstallations.some((live) => live.id === installation.id),
      )
    : [];
}

async function resolvedInstallations(
  env: Env,
  session: StoredAuthSession,
  liveInstallations: AuthInstallation[] | null,
  acknowledgedInstallations = fallbackInstallations(session, liveInstallations),
): Promise<AuthInstallation[]> {
  const appInstallations =
    liveInstallations &&
    liveInstallations.some(
      (installation) => installation.accountLogin === session.user.login.toLowerCase(),
    )
      ? []
      : await githubAppInstallationsForSession(env, session).catch(() => []);
  const installations = mergeInstallations(liveInstallations ?? [], [
    ...acknowledgedInstallations,
    ...appInstallations,
  ]);
  await writeInstallationRegistry(env, installations);
  return installations;
}

function inferredInstallation(
  installationId: number,
  returnTo: string,
  origin: string,
  session: StoredAuthSession,
): AuthInstallation {
  const sources = returnToSources(returnTo, origin);
  const accounts = sourceAccounts(sources);
  const accountLogin = (accounts[0] ?? session.user.login).toLowerCase();
  return {
    id: installationId,
    accountLogin,
    accountType: accountLogin === session.user.login.toLowerCase() ? "user" : "org",
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: accountLogin === session.user.login.toLowerCase() ? session.user.avatarUrl : "",
    repositorySelection: "selected",
    repositories: sources.repos.filter((repo) => repo.split("/")[0] === accountLogin),
  };
}

async function githubAppInstallation(
  env: Env,
  installationId: number,
): Promise<AuthInstallation | null> {
  if (!appTokenConfigured(env)) return null;
  const jwt = await githubAppJwt(env);
  const response = await workerFetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return null;
  const installation = parseGitHubResponse(
    gitHubInstallationSchema,
    await response.json(),
    "app installation",
  );
  const account = installation.account;
  if (!account) return null;
  const repositories =
    installation.repository_selection === "selected"
      ? await githubAppInstallationRepositories(env, installationId)
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
}

async function githubAppInstallationForAccount(
  env: Env,
  accountLogin: string,
): Promise<AuthInstallation | null> {
  if (!appTokenConfigured(env) || !env.DASHBOARD_CACHE) return null;
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  if (await env.DASHBOARD_CACHE.get(installationMissKey(account))) return null;
  const jwt = await githubAppJwt(env);
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) break;
    const result = parseGitHubResponse(
      v.array(gitHubInstallationSchema),
      await response.json(),
      "app installation list",
    );
    for (const installation of result) {
      const installationAccount = installation.account;
      if (!installationAccount || installationAccount.login.toLowerCase() !== account) continue;
      const repositories =
        installation.repository_selection === "selected"
          ? await githubAppInstallationRepositories(env, installation.id)
          : [];
      const record: AuthInstallation = {
        id: installation.id,
        accountLogin: account,
        accountType: installationAccount.type === "Organization" ? "org" : "user",
        accountUrl: installationAccount.html_url,
        avatarUrl: installationAccount.avatar_url,
        repositorySelection: installation.repository_selection,
        repositories,
      };
      await writeInstallationRegistry(env, [record]);
      return record;
    }
    if (result.length < 100) break;
  }
  await env.DASHBOARD_CACHE.put(installationMissKey(account), new Date().toISOString(), {
    expirationTtl: 10 * 60,
  });
  return null;
}

async function githubAppInstallationRepositories(
  env: Env,
  installationId: number,
): Promise<string[]> {
  const token = await cachedInstallationToken(env, installationId);
  if (!token) return [];
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) break;
    const result = parseGitHubResponse(
      gitHubInstallationRepositoryListSchema,
      await response.json(),
      "app installation repositories",
    );
    const batch = result.repositories ?? [];
    repositories.push(
      ...batch.filter(isPublicInstallationRepository).map((repo) => repo.full_name.toLowerCase()),
    );
    if (batch.length < 100) break;
  }
  return repositories;
}

async function writeSessionRecord(
  env: Env,
  id: string | null,
  session: StoredAuthSession,
): Promise<void> {
  if (!id || !env.DASHBOARD_CACHE) return;
  const ttl = Math.max(1, session.exp - Math.floor(Date.now() / 1000));
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

async function acknowledgedInstallations(
  request: Request,
  env: Env,
  returnTo: string,
  installationId: number | null,
): Promise<AuthInstallation[]> {
  const record = await currentSessionRecord(request, env);
  if (!record) return [];
  const liveInstallations = await githubInstallations(record.session.accessToken).catch(() => []);
  const acknowledged: AuthInstallation[] = [];
  if (
    installationId &&
    !liveInstallations.some((installation) => installation.id === installationId)
  ) {
    const appInstallation = await githubAppInstallation(env, installationId).catch(() => null);
    acknowledged.push(
      appInstallation ??
        inferredInstallation(installationId, returnTo, new URL(request.url).origin, record.session),
    );
  }
  const installations = mergeInstallations(liveInstallations, [
    ...(record.session.installations ?? []),
    ...acknowledged,
  ]);
  await writeInstallationRegistry(env, installations);
  await writeSessionRecord(env, record.id, {
    ...record.session,
    installations,
    installationsUpdatedAt: new Date().toISOString(),
  });
  return installations;
}

function appTokenConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

async function dashboardReleaseDataAllowed(
  request: Request,
  env: Env,
  sources: TokenSources,
  token: RequestToken | null | undefined,
): Promise<boolean> {
  if (!appTokenConfigured(env) || token?.quotaSource === "app") return true;
  if (sourceAccounts(sources).length <= 1) return false;
  return Boolean(await currentSession(request, env));
}

function authDependentDashboardHeaders(env: Env): Record<string, string> {
  return appTokenConfigured(env) ? { "cache-control": "private, no-store", vary: "cookie" } : {};
}

function authDependentAppShellHeaders(request: Request, env: Env): Record<string, string> {
  return appTokenConfigured(env) && parseCookies(request).has(sessionCookie)
    ? { "cache-control": "private, no-store", vary: "cookie" }
    : { "cache-control": "public, max-age=300" };
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
    console.log(
      JSON.stringify({
        event: "github_installation_token",
        installationId,
        status: response.status,
        ok: false,
      }),
    );
    throw new Error(result.message || `GitHub installation token failed: ${response.status}`);
  }
  console.log(
    JSON.stringify({
      event: "github_installation_token",
      installationId,
      status: response.status,
      ok: true,
    }),
  );
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

async function sourceInstallationToken(
  env: Env,
  sources: TokenSources,
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const accounts = sourceAccounts(sources);
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  let installation = await readInstallationRegistry(env, account);
  if (!installation) {
    installation = await githubAppInstallationForAccount(env, account).catch(() => null);
  }
  if (!installation || !installationCoversSources(installation, sources)) return null;
  const token = await cachedInstallationToken(env, installation.id);
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation.accountLogin,
      }
    : null;
}

async function requestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const session = await currentSession(request, env);
  if (!session) return null;
  const liveInstallations = await githubInstallations(session.accessToken).catch(() => null);
  const installations = await resolvedInstallations(env, session, liveInstallations);
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

async function bestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
): Promise<RequestToken | null> {
  return (
    (await requestInstallationToken(request, env, sources).catch(() => null)) ??
    (await sourceInstallationToken(env, sources).catch(() => null))
  );
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
  const pathRepo = repoFullNameFromPath(url.pathname);
  if (pathRepo) {
    return {
      owners: ownerListFromUrl(url),
      repos: [...new Set([pathRepo, ...repoListFromUrl(url)])],
    };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const rawOwner = slugOwner(parts[0] ?? "");
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
  viewerLogin?: string,
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
    const account = (uncoveredOwners[0] ?? uncoveredRepos[0]?.split("/")[0] ?? "").toLowerCase();
    if (uncoveredOwners.length === 0 && viewerLogin && account !== viewerLogin.toLowerCase()) {
      return {
        needed: false,
        reason: `This dashboard uses shared API quota unless ${target} installs the GitHub App.`,
      };
    }
    return {
      needed: true,
      reason: `Install the GitHub App for ${target} to use dedicated API quota.`,
    };
  }

  return { needed: false, reason: null };
}

async function storedSessionCookie(env: Env, session: StoredAuthSession): Promise<string> {
  if (!env.AUTH_COOKIE_SECRET) {
    throw new Error("missing auth cookie secret");
  }
  if (!env.DASHBOARD_CACHE) {
    throw new Error("missing auth session storage");
  }
  const id = randomNonce();
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(session), {
    expirationTtl: sessionMaxAgeSeconds,
  });
  const token = await signedJson(env.AUTH_COOKIE_SECRET, { id, exp: session.exp });
  return authCookie(token);
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
    const now = Math.floor(Date.now() / 1000);
    const session: StoredAuthSession = {
      user,
      accessToken,
      iat: now,
      exp: now + sessionMaxAgeSeconds,
    };
    const liveInstallations = await githubInstallations(accessToken).catch(() => null);
    const installations = await resolvedInstallations(env, session, liveInstallations);
    if (installations.length > 0) {
      session.installations = installations;
      session.installationsUpdatedAt = new Date().toISOString();
    }
    const sessionCookieValue = await storedSessionCookie(env, session);
    const coverage = sourceCoverage(
      installations,
      state.returnTo,
      url.origin,
      appTokenConfigured(env),
      user.login,
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
    const stateIsFresh =
      state !== null && Math.floor(Date.now() / 1000) - state.iat <= stateMaxAgeSeconds;
    const returnTo = stateIsFresh ? state.returnTo : "/";
    const installationId = Number(url.searchParams.get("installation_id"));
    if (stateIsFresh) {
      await acknowledgedInstallations(
        request,
        env,
        returnTo,
        Number.isFinite(installationId) ? installationId : null,
      );
    }
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
      ...(payload.cache?.progress ? { progress: payload.cache.progress } : {}),
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
    includeUnreleased: url.searchParams.get("unreleased") !== "false",
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
  const message = errorMessage(error);
  const githubStatus = message.match(/^GitHub API (\d+)/)?.[1];
  if (githubStatus === "404") return 404;
  return isGitHubRateLimit(error) ? 429 : 502;
}

async function readCached(env: Env, key: string): Promise<DashboardPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<DashboardPayload>(raw, `dashboard ${key}`) : null;
}

function cacheAgeMs(payload: DashboardPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function canDisplayCached(payload: DashboardPayload | null): payload is DashboardPayload {
  return cacheAgeMs(payload) <= maxDisplayStaleMs;
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
  ttlSeconds = dashboardStorageTtlSeconds,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: ttlSeconds,
  });
}

function progressKey(key: string): string {
  return `progress:v1:${key}`;
}

async function readProgress(env: Env, key: string): Promise<StoredBuildProgress | null> {
  const raw = await env.DASHBOARD_CACHE?.get(progressKey(key));
  if (!raw) return null;
  const parsed = tryJsonParse<StoredBuildProgress>(raw, `progress ${key}`);
  return parsed && Array.isArray(parsed.scannedRepos) && Array.isArray(parsed.projects)
    ? parsed
    : null;
}

async function writeProgress(env: Env, key: string, progress: StoredBuildProgress): Promise<void> {
  await env.DASHBOARD_CACHE?.put(progressKey(key), JSON.stringify(progress), {
    expirationTtl: progressTtlSeconds,
  });
}

async function deleteProgress(env: Env, key: string): Promise<void> {
  await env.DASHBOARD_CACHE?.delete?.(progressKey(key));
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
        includeReleaseData: dashboard.includeReleaseData,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
    ...dashboard.includeRepos.map((repo) =>
      dashboardCacheKey({
        owner: "custom",
        repos: [repo],
        ...options,
        includeReleaseData: dashboard.includeReleaseData,
        schemaVersion: dashboardSchemaVersion,
      }),
    ),
  ];
  const dashboards = (
    await Promise.all([...new Set(keys)].map((key) => readCached(env, key)))
  ).filter(
    (payload): payload is DashboardPayload =>
      canDisplayCached(payload) && payload.cache?.state !== "error" && payload.projects.length > 0,
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
    if (!canDisplayCached(payload)) continue;
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
  if (!payload.projects.some(canContributeToHotDashboard)) return;
  const keys = await readHotIndex(env);
  const next = [key, ...keys.filter((existing) => existing !== key)].slice(0, hotIndexLimit);
  await env.DASHBOARD_CACHE?.put(hotIndexKey, JSON.stringify(next), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function canContributeToHotDashboard(project: Project): boolean {
  return !project.archived && Boolean(project.releaseDate) && project.commitsSinceRelease !== null;
}

function hotDashboardPayload(
  dashboards: DashboardPayload[],
  env: Env,
  generatedAt = new Date().toISOString(),
): DashboardPayload {
  const candidates = new Map<string, Project>();
  for (const dashboard of dashboards) {
    for (const project of dashboard.projects) {
      if (!canContributeToHotDashboard(project)) {
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
  const ageMs = cacheAgeMs(cached);
  if (cached && canDisplayCached(cached) && ageMs < hotCacheTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  const payload = hotDashboardPayload(await readCachedDashboards(env), env);
  await writeCached(env, hotCacheKey, payload);
  return jsonResponse(payload);
}

async function cachedHotInitialData(env: Env): Promise<InitialPageData | null> {
  const cached = await readCached(env, hotCacheKey);
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  return {
    route: "dashboard",
    payload: withCacheState(cached, cacheAgeMs(cached) < hotCacheTtlMs ? "fresh" : "stale"),
  };
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

function discoverPageLanguage(url: URL): string {
  const raw = (url.searchParams.get("hotLang") ?? "").trim();
  return /^[a-z0-9+#.\-\s]{1,32}$/i.test(raw) ? raw : "";
}

function discoverCacheKey(period: DiscoverPeriod, language: string): string {
  return `discover:v${discoverCacheSchemaVersion}:${period}:${language.trim().toLowerCase() || "all"}`;
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

function isRateLimitResponse(response: Response, message: string): boolean {
  return (
    response.status === 429 ||
    /rate limit|secondary rate|abuse detection/i.test(message) ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  );
}

function quotaFromGitHubResponse(
  response: Response,
  source: ApiQuota["source"],
  account: string | null,
): ApiQuota {
  const quota = quotaFromResponse(response, {
    GITHUB_TOKEN: source === "anonymous" ? undefined : "token",
  } as Env);
  return { ...quota, source, account };
}

async function detailGitHubJson<TSchema extends GenericSchema>(
  path: string,
  schema: TSchema,
  context: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<InferOutput<TSchema>> {
  const { data } = await detailGitHubJsonWithHeaders(
    path,
    schema,
    context,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    acceptOrAuditArea,
    auditArea,
  );
  return data;
}

async function detailGitHubJsonWithHeaders<TSchema extends GenericSchema>(
  path: string,
  schema: TSchema,
  context: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<{ data: InferOutput<TSchema>; headers: Headers }> {
  const requestOptions = githubRequestOptions(acceptOrAuditArea, auditArea);
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: requestOptions.accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  auditGitHubTokenUse(requestOptions.auditArea, path, response.status, quota);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, message)) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(`GitHub API ${response.status} for ${path}: ${message}`);
  }
  return { data: parseGitHubResponse(schema, body, context), headers: response.headers };
}

async function detailGitHubStats<TSchema extends GenericSchema>(
  path: string,
  schema: TSchema,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<{
  state: "ready" | "warming" | "unavailable";
  data: InferOutput<TSchema> | null;
  message?: string;
}> {
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  auditGitHubTokenUse(auditArea, path, response.status, quota);
  if (response.status === 202) {
    return {
      state: "warming",
      data: null,
      message: "GitHub is preparing repository statistics.",
    };
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : undefined;
  if (response.status === 204 || response.status === 422) {
    return {
      state: "unavailable",
      data: null,
      ...(message ? { message } : {}),
    };
  }
  if (!response.ok) {
    const errorMessage = message ?? `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, errorMessage)) {
      throw new GitHubRateLimitError(
        errorMessage,
        parseHeaderInt(response.headers.get("retry-after")),
      );
    }
    return { state: "unavailable", data: null, message: errorMessage };
  }
  return { state: "ready", data: parseGitHubResponse(schema, body, path) };
}

async function detailGitHubCount(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<number> {
  const response = await workerFetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  auditGitHubTokenUse(auditArea, path, response.status, quota);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `GitHub API ${response.status}`;
    if (isRateLimitResponse(response, message)) {
      throw new GitHubRateLimitError(message, parseHeaderInt(response.headers.get("retry-after")));
    }
    throw new Error(`GitHub API ${response.status} for ${path}: ${message}`);
  }
  const lastPage = lastPageFromLink(response.headers.get("link"));
  if (lastPage !== null) return lastPage;
  return Array.isArray(body) ? body.length : 0;
}

async function detailGitHubSearchCount(
  query: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<number> {
  const result = await detailGitHubJson(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
    gitHubSearchCountSchema,
    "repository issue search",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
  );
  return result.total_count ?? 0;
}

async function buildWorkTrend(
  fullName: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-detail",
): Promise<RepoDetailWorkTrend> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const repoQuery = `repo:${fullName}`;
  const [issuesOpened30d, issuesClosed30d, pullRequestsOpened30d, pullRequestsClosed30d] =
    await Promise.all([
      detailGitHubSearchCount(
        `${repoQuery} is:issue created:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:issue closed:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:pr created:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
      ),
      detailGitHubSearchCount(
        `${repoQuery} is:pr closed:>=${since}`,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
        auditArea,
      ),
    ]);
  return {
    since,
    issuesOpened30d,
    issuesClosed30d,
    pullRequestsOpened30d,
    pullRequestsClosed30d,
  };
}

function activityRangeFromUrl(url: URL): ActivityRange {
  const value = url.searchParams.get("range")?.toLowerCase();
  return value === "day" || value === "month" ? value : "week";
}

function activityRangeMs(range: ActivityRange): number {
  if (range === "day") return 24 * 60 * 60 * 1000;
  if (range === "month") return 30 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function activityCacheTtlMs(range: ActivityRange): number {
  if (range === "day") return 10 * 60 * 1000;
  if (range === "month") return 6 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function ownerActivityCacheKey(owner: string, range: ActivityRange): string {
  return `owner-activity:v1:${slugOwner(owner)}:${range}`;
}

function ownerActivitySummaryCacheKey(
  owner: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `owner-activity-summary:v${activitySummaryPromptVersion}`,
    slugOwner(owner),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

function repoActivityCacheKey(owner: string, repo: string, range: ActivityRange): string {
  return `repo-activity:v1:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

function repoActivitySummaryCacheKey(
  fullName: string,
  range: ActivityRange,
  model: string,
  inputHash: string,
): string {
  return [
    `repo-activity-summary:v${activitySummaryPromptVersion}`,
    fullName.toLowerCase(),
    range,
    encodeURIComponent(model),
    inputHash,
  ].join(":");
}

function ownerActivityAgeMs(payload: OwnerActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readOwnerActivity(env: Env, key: string): Promise<OwnerActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivityPayload>(raw, `owner activity ${key}`) : null;
}

async function writeOwnerActivity(
  env: Env,
  key: string,
  payload: OwnerActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readRepoActivity(env: Env, key: string): Promise<RepoDetailActivityPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailActivityPayload>(raw, `repo activity ${key}`) : null;
}

async function writeRepoActivity(
  env: Env,
  key: string,
  payload: RepoDetailActivityPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readOwnerActivitySummary(
  env: Env,
  key: string,
): Promise<OwnerActivitySummary | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<OwnerActivitySummary>(raw, `owner activity summary ${key}`) : null;
}

async function writeOwnerActivitySummary(
  env: Env,
  key: string,
  summary: OwnerActivitySummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function payloadString(value: unknown, key: string): string | null {
  const result = payloadRecord(value)[key];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> {
  return payloadRecord(payloadRecord(value)[key]);
}

function nestedString(value: unknown, key: string, nestedKey: string): string | null {
  const result = nestedRecord(value, key)[nestedKey];
  return typeof result === "string" && result.trim() ? result.trim() : null;
}

function activityRepoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function normalizeActivityEvent(event: GitHubPublicEvent): OwnerActivityEvent | null {
  if (event.public === false) return null;
  const repo = event.repo.name;
  const payload = event.payload;
  const createdAt = event.created_at;
  const repoUrl = activityRepoUrl(repo);
  if (!repo || !createdAt) return null;

  if (event.type === "PushEvent") {
    const payloadData = payloadRecord(payload);
    const commits = payloadData.commits;
    const commitList = Array.isArray(commits) ? commits : [];
    const titles = commitList
      .map((commit) => commitTitle(payloadString(commit, "message") ?? ""))
      .filter(Boolean);
    const size = Number(payloadData.size ?? 0);
    const count = Math.max(1, titles.length, Number.isFinite(size) ? size : 0);
    return {
      id: event.id,
      kind: "commit",
      title:
        titles[0] && count > 1
          ? `${titles[0]} +${count - 1} commits`
          : (titles[0] ?? `${count} commit${count === 1 ? "" : "s"}`),
      repo,
      url: repoUrl,
      createdAt,
      count,
    };
  }

  if (event.type === "PullRequestEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} PR: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "PullRequestReviewEvent") {
    const action = payloadString(payload, "action") ?? "reviewed";
    const title = nestedString(payload, "pull_request", "title") ?? "pull request";
    return {
      id: event.id,
      kind: "pull_request",
      title: `${action} review: ${title}`,
      repo,
      url: nestedString(payload, "pull_request", "html_url") ?? `${repoUrl}/pulls`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssuesEvent") {
    const action = payloadString(payload, "action") ?? "updated";
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "issue",
      title: `${action} issue: ${title}`,
      repo,
      url: nestedString(payload, "issue", "html_url") ?? `${repoUrl}/issues`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "IssueCommentEvent") {
    const title = nestedString(payload, "issue", "title") ?? "issue";
    return {
      id: event.id,
      kind: "comment",
      title: `commented on: ${title}`,
      repo,
      url:
        nestedString(payload, "comment", "html_url") ?? nestedString(payload, "issue", "html_url"),
      createdAt,
      count: 1,
    };
  }

  if (event.type === "ReleaseEvent") {
    const action = payloadString(payload, "action") ?? "published";
    const tag = nestedString(payload, "release", "tag_name");
    const name = nestedString(payload, "release", "name");
    return {
      id: event.id,
      kind: "release",
      title: `${action} release: ${name || tag || repo}`,
      repo,
      url: nestedString(payload, "release", "html_url") ?? `${repoUrl}/releases`,
      createdAt,
      count: 1,
    };
  }

  if (event.type === "CreateEvent") {
    const refType = payloadString(payload, "ref_type") ?? "thing";
    const ref = payloadString(payload, "ref");
    return {
      id: event.id,
      kind: "repository",
      title: `created ${refType}${ref ? ` ${ref}` : ""}`,
      repo,
      url: repoUrl,
      createdAt,
      count: 1,
    };
  }

  return {
    id: event.id,
    kind: "other",
    title: event.type
      .replace(/Event$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase(),
    repo,
    url: repoUrl,
    createdAt,
    count: 1,
  };
}

async function fetchOwnerActivityEvents(
  owner: Owner,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  const base =
    owner.type === "org"
      ? `/orgs/${encodeURIComponent(owner.login)}/events`
      : `/users/${encodeURIComponent(owner.login)}/events/public`;
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${base}?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "owner public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "owner-activity",
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function fetchRepoActivityEvents(
  path: string,
  since: number,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<OwnerActivityEvent[]> {
  const events: OwnerActivityEvent[] = [];
  for (let page = 1; page <= activityEventPageLimit; page += 1) {
    const pageEvents = await detailGitHubJson(
      `${path}/events?per_page=100&page=${page}`,
      gitHubPublicEventListSchema,
      "repository public events",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "repo-activity",
    );
    if (pageEvents.length === 0) break;
    const normalized = pageEvents.map(normalizeActivityEvent).filter((event) => event !== null);
    events.push(
      ...normalized.filter((event) => {
        const time = Date.parse(event.createdAt);
        return Number.isFinite(time) && time >= since;
      }),
    );
    const oldest = pageEvents
      .map((event) => Date.parse(event.created_at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (oldest !== undefined && oldest < since) break;
  }
  return events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function activityRepositories(events: OwnerActivityEvent[]): OwnerActivityRepository[] {
  const repos = new Map<string, OwnerActivityRepository>();
  for (const event of events) {
    const existing = repos.get(event.repo) ?? {
      fullName: event.repo,
      url: activityRepoUrl(event.repo),
      events: 0,
      commits: 0,
      lastActiveAt: event.createdAt,
    };
    existing.events += 1;
    existing.commits += event.kind === "commit" ? event.count : 0;
    if (Date.parse(event.createdAt) > Date.parse(existing.lastActiveAt)) {
      existing.lastActiveAt = event.createdAt;
    }
    repos.set(event.repo, existing);
  }
  return [...repos.values()].sort(
    (a, b) =>
      b.events - a.events ||
      Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) ||
      a.fullName.localeCompare(b.fullName),
  );
}

function activityTotals(events: OwnerActivityEvent[]): OwnerActivityPayload["totals"] {
  return {
    events: events.reduce((sum, event) => sum + event.count, 0),
    commits: events
      .filter((event) => event.kind === "commit")
      .reduce((sum, event) => sum + event.count, 0),
    pullRequests: events.filter((event) => event.kind === "pull_request").length,
    issues: events.filter((event) => event.kind === "issue").length,
    comments: events.filter((event) => event.kind === "comment").length,
    releases: events.filter((event) => event.kind === "release").length,
    repositories: new Set(events.map((event) => event.repo)).size,
  };
}

function activitySummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

type ActivitySummaryPayload = Pick<OwnerActivityPayload, "events" | "repositories">;

function activitySummaryEvents(payload: ActivitySummaryPayload): OwnerActivityEvent[] {
  return payload.events.slice(0, activitySummaryInputLimit);
}

function activitySummaryInput(payload: ActivitySummaryPayload): string {
  const summaryEvents = activitySummaryEvents(payload);
  if (summaryEvents.length === 0) return "";
  const topRepos = payload.repositories
    .slice(0, 8)
    .map((repo) => `${repo.fullName} (${repo.events} events, ${repo.commits} commits)`)
    .join(", ");
  const events = summaryEvents
    .map((event, index) =>
      [
        `${index + 1}. ${event.kind}`,
        event.repo,
        event.createdAt,
        event.count > 1 ? `${event.count} items` : "1 item",
        event.title,
      ].join(" · "),
    )
    .join("\n");
  return [`Top repositories: ${topRepos || "none"}`, "", events].join("\n");
}

function unavailableActivitySummary(
  model: string | null,
  inputHash: string | null,
  message: string,
): OwnerActivitySummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed: 0,
    promptVersion: activitySummaryPromptVersion,
    message,
  };
}

async function activitySummaryState(
  payload: ActivitySummaryPayload & Pick<OwnerActivityPayload, "owner" | "range">,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = ownerActivitySummaryCacheKey(
    payload.owner.login,
    payload.range,
    model,
    inputHash,
  );
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

function activitySummaryInstructions(): string {
  return [
    "You write the working-on paragraph for ReleaseBar owner dashboards.",
    "The UI already says this is a GitHub dashboard, shows the selected time range, and lists commit/PR/issue totals, so do not restate those facts.",
    "Do not use filler like public GitHub activity, recent activity, events, commits, PRs, has been working on, centered on, or touched repositories.",
    "Start with concrete work: systems, fixes, releases, docs, integrations, repo names, and themes that are directly supported by the event titles.",
    "Write 2-3 useful sentences, no bullets, no markdown, no hype.",
    "Do not infer private work, intentions, employers, or impact beyond the event titles.",
  ].join(" ");
}

function polishActivitySummaryText(text: string): string {
  return text
    .replace(/\bpublic GitHub activity\b/gi, "work")
    .replace(/\bGitHub activity\b/gi, "work")
    .replace(/\bpublic activity\b/gi, "work")
    .replace(/\brecent activity\b/gi, "work")
    .replace(/\bActivity also touched\b/g, "Also touched")
    .replace(/\s+/g, " ")
    .trim();
}

async function summarizeOwnerActivity(
  payload: OwnerActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 420,
      instructions: activitySummaryInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Owner: @${payload.owner.login}`,
                `Owner type: ${payload.owner.type}`,
                `Range: ${payload.range}`,
                `Events included: ${eventsUsed}`,
                "",
                input,
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include activity summary text");
  const summary = {
    state: "ready",
    text: polishActivitySummaryText(text),
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    ownerActivitySummaryCacheKey(payload.owner.login, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

async function buildOwnerActivity(
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<OwnerActivityPayload> {
  const requestToken = await bestInstallationToken(request, env, {
    owners: [ownerSlug],
    repos: [],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const owner = await resolveOwnerType(ownerSlug, {
    token: token ?? undefined,
    fetch: auditGitHubFetch("owner-activity", quotaSource, quotaAccount),
  });
  if (!owner) {
    throw new Error(`owner not found: ${ownerSlug}`);
  }
  const since = Date.now() - activityRangeMs(range);
  const events = await fetchOwnerActivityEvents(
    owner,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await activitySummaryState(payload, env),
  };
}

async function repoActivitySummaryState(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash);
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

async function summarizeRepoActivity(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  if (!env.OPENAI_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 420,
      instructions: activitySummaryInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Repository: ${payload.fullName}`,
                `Range: ${payload.range}`,
                `Events included: ${eventsUsed}`,
                "",
                input,
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include activity summary text");
  const summary = {
    state: "ready",
    text: polishActivitySummaryText(text),
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

async function buildRepoActivity(
  owner: string,
  repoName: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<RepoDetailActivityPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository detail",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }
  const since = Date.now() - activityRangeMs(range);
  const events = await fetchRepoActivityEvents(
    path,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailActivityPayload = {
    fullName: repo.full_name,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await repoActivitySummaryState(payload, env),
  };
}

function withOwnerActivityState(
  payload: OwnerActivityPayload,
  state: OwnerActivityPayload["cache"]["state"],
  message = payload.cache.message,
): OwnerActivityPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

function ownerActivitySummaryNeedsRefresh(payload: OwnerActivityPayload | null, env: Env): boolean {
  return (
    payload?.summary?.state === "warming" ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

async function refreshOwnerActivitySummary(
  key: string,
  payload: OwnerActivityPayload,
  env: Env,
): Promise<void> {
  if (!ownerActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeOwnerActivity(payload, env);
    const latest = (await readOwnerActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeOwnerActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = (await readOwnerActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    await writeOwnerActivity(env, key, {
      ...latest,
      summary: {
        ...(latest.summary ?? payload.summary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function refreshOwnerActivity(
  key: string,
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await buildOwnerActivity(ownerSlug, range, request, env);
    await writeOwnerActivity(env, key, payload);
    if (ownerActivitySummaryNeedsRefresh(payload, env)) {
      await refreshOwnerActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

async function ownerActivityResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const ownerSlug = slugOwner(url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(ownerSlug)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }
  const range = activityRangeFromUrl(url);
  const key = ownerActivityCacheKey(ownerSlug, range);
  const cached = await readOwnerActivity(env, key);
  const age = ownerActivityAgeMs(cached);
  if (cached && age < activityCacheTtlMs(range)) {
    if (ownerActivitySummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshOwnerActivitySummary(key, cached, env).catch(() => undefined));
    }
    return jsonResponse(cached, cached.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    context.waitUntil(
      refreshOwnerActivity(key, ownerSlug, range, request, env).catch(() => undefined),
    );
    return jsonResponse(
      withOwnerActivityState(cached, "stale", "showing cached work while refreshing"),
      200,
      { "cache-control": "no-store" },
    );
  }

  try {
    const payload = await buildOwnerActivity(ownerSlug, range, request, env);
    await writeOwnerActivity(env, key, payload);
    if (ownerActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshOwnerActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withOwnerActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

function repoActivityAgeMs(payload: RepoDetailActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function withRepoActivityState(
  payload: RepoDetailActivityPayload,
  state: RepoDetailActivityPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailActivityPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

function repoActivitySummaryNeedsRefresh(
  payload: RepoDetailActivityPayload | null,
  env: Env,
): boolean {
  return (
    payload?.summary?.state === "warming" ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

async function refreshRepoActivitySummary(
  key: string,
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<void> {
  if (!repoActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeRepoActivity(payload, env);
    const latest = (await readRepoActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeRepoActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = (await readRepoActivity(env, key)) ?? payload;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    await writeRepoActivity(env, key, {
      ...latest,
      summary: {
        ...(latest.summary ?? payload.summary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function refreshRepoActivity(
  key: string,
  owner: string,
  repo: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (repoActivitySummaryNeedsRefresh(payload, env)) {
      await refreshRepoActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

async function repoActivityResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const range = activityRangeFromUrl(url);
  const key = repoActivityCacheKey(owner, repo, range);
  const cached = await readRepoActivity(env, key);
  const age = repoActivityAgeMs(cached);
  if (cached && age < activityCacheTtlMs(range)) {
    if (repoActivitySummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, cached, env).catch(() => undefined));
    }
    return jsonResponse(cached, cached.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    context.waitUntil(
      refreshRepoActivity(key, owner, repo, range, request, env).catch(() => undefined),
    );
    return jsonResponse(
      withRepoActivityState(cached, "stale", "showing cached work while refreshing"),
      200,
      { "cache-control": "no-store" },
    );
  }

  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (repoActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withRepoActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

function lastPageFromLink(link: string | null): number | null {
  if (!link) return null;
  const last = link
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel="last"/.test(part));
  const match = last?.match(/[?&]page=(\d+)/);
  if (!match?.[1]) return null;
  const page = Number.parseInt(match[1], 10);
  return Number.isFinite(page) ? page : null;
}

function releaseProject(repo: InferOutput<typeof gitHubRepositorySchema>): Project {
  return {
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    language: repo.language,
    topics: repo.topics ?? [],
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    openPullRequests: 0,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived ?? false,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "unreleased",
    releaseName: null,
    releaseUrl: repo.html_url,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  };
}

function audienceRangeFromUrl(url: URL): AudienceRange {
  return url.searchParams.get("range")?.toLowerCase() === "week" ? "week" : "month";
}

function audienceRangeMs(range: AudienceRange): number {
  return range === "week" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
}

function repoAudienceCacheKey(owner: string, repo: string, range: AudienceRange): string {
  return `repo-audience:v5:${slugOwner(owner)}/${repo.toLowerCase()}:${range}`;
}

function repoAudienceUserKey(login: string): string {
  return `audience-user:v1:${slugOwner(login)}`;
}

function repoAudienceUserOrgsKey(login: string): string {
  return `audience-user-orgs:v1:${slugOwner(login)}`;
}

function repoAudienceUserReposKey(login: string): string {
  return `audience-user-repos:v2:${slugOwner(login)}`;
}

function repoAudienceAgeMs(payload: RepoAudiencePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readRepoAudience(env: Env, key: string): Promise<RepoAudiencePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoAudiencePayload>(raw, `repo audience ${key}`) : null;
}

async function writeRepoAudience(
  env: Env,
  key: string,
  payload: RepoAudiencePayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readAudienceUser(env: Env, login: string): Promise<GitHubUserProfile | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserKey(login));
  return raw ? safeJsonParse(gitHubUserProfileSchema, raw, `audience user ${login}`) : null;
}

async function writeAudienceUser(env: Env, user: GitHubUserProfile): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserKey(user.login), JSON.stringify(user), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function readAudienceUserOrgs(
  env: Env,
  login: string,
): Promise<GitHubUserOrganization[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserOrgsKey(login));
  return raw
    ? safeJsonParse(gitHubUserOrganizationListSchema, raw, `audience user orgs ${login}`)
    : null;
}

async function writeAudienceUserOrgs(
  env: Env,
  login: string,
  orgs: GitHubUserOrganization[],
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserOrgsKey(login), JSON.stringify(orgs), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function readAudienceUserRepos(
  env: Env,
  login: string,
): Promise<GitHubUserRepository[] | null> {
  const raw = await env.DASHBOARD_CACHE?.get(repoAudienceUserReposKey(login));
  return raw
    ? safeJsonParse(gitHubUserRepositoryListSchema, raw, `audience user repos ${login}`)
    : null;
}

async function writeAudienceUserRepos(
  env: Env,
  login: string,
  repos: GitHubUserRepository[],
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(repoAudienceUserReposKey(login), JSON.stringify(repos), {
    expirationTtl: repoAudienceUserTtlSeconds,
  });
}

async function audienceUserProfile(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserProfile | null> {
  const cached = await readAudienceUser(env, login);
  if (cached) return cached;
  const user = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}`,
    gitHubUserProfileSchema,
    "audience user profile",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
  );
  await writeAudienceUser(env, user);
  return user;
}

async function recentRepoStargazers(
  owner: string,
  repo: string,
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<GitHubStargazer[]> {
  const graphql = await recentRepoStargazersGraphql(
    owner,
    repo,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  if (graphql) return graphql;
  return recentRepoStargazersRest(path, token, quotaSource, quotaAccount, onQuota);
}

async function recentRepoStargazersRest(
  path: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<GitHubStargazer[]> {
  const firstPath = `${path}/stargazers?per_page=${repoAudienceStargazerLimit}`;
  const firstPage = await detailGitHubJsonWithHeaders(
    firstPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
  );
  const lastPage = lastPageFromLink(firstPage.headers.get("link"));
  if (!lastPage || lastPage <= 1) return firstPage.data;
  const lastPath = `${firstPath}&page=${lastPage}`;
  const last = await detailGitHubJson(
    lastPath,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
  );
  if (last.length >= repoAudienceStargazerLimit) return last;
  const previous = await detailGitHubJson(
    `${firstPath}&page=${lastPage - 1}`,
    gitHubStargazerListSchema,
    "repository stargazers",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "application/vnd.github.v3.star+json",
  );
  return [...previous, ...last].slice(-repoAudienceStargazerLimit);
}

type GraphQLStargazerEdge = {
  starredAt: string | null;
  node: {
    login: string;
    avatarUrl: string;
    url: string;
  } | null;
};

type GraphQLStargazerResponse = {
  data?: {
    repository?: {
      stargazers?: {
        edges?: GraphQLStargazerEdge[];
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

const repoStargazersQuery = /* GraphQL */ `
  query ReleaseBarRepoStargazers($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      stargazers(first: $first, orderBy: { field: STARRED_AT, direction: DESC }) {
        edges {
          starredAt
          node {
            login
            avatarUrl
            url
          }
        }
      }
    }
  }
`;

async function recentRepoStargazersGraphql(
  owner: string,
  repo: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<GitHubStargazer[] | null> {
  if (!token) return null;
  const response = await workerFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "ReleaseBar",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      query: repoStargazersQuery,
      variables: { owner, name: repo, first: repoAudienceStargazerLimit },
    }),
  });
  const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
  onQuota(quota);
  auditGitHubTokenUse("repo-audience", "/graphql", response.status, quota);
  const body = (await response.json().catch(() => null)) as GraphQLStargazerResponse | null;
  const message = body?.errors
    ?.map((error) => error.message ?? error.type)
    .filter(Boolean)
    .join("; ");
  if (isRateLimitResponse(response, message ?? "")) {
    throw new GitHubRateLimitError(
      message ?? "GitHub GraphQL rate limit",
      parseHeaderInt(response.headers.get("retry-after")),
    );
  }
  if (!response.ok || body?.errors?.length) return null;
  const edges = body?.data?.repository?.stargazers?.edges ?? [];
  return edges
    .filter(
      (edge): edge is GraphQLStargazerEdge & { node: NonNullable<GraphQLStargazerEdge["node"]> } =>
        Boolean(edge.node?.login),
    )
    .map((edge) => ({
      starred_at: edge.starredAt,
      user: {
        login: edge.node.login,
        avatar_url: edge.node.avatarUrl,
        html_url: edge.node.url,
      },
    }));
}

async function audienceUserOrgs(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserOrganization[]> {
  const cached = await readAudienceUserOrgs(env, login);
  if (cached) return cached;
  const orgs = await detailGitHubJson(
    `/users/${encodeURIComponent(login)}/orgs?per_page=20`,
    gitHubUserOrganizationListSchema,
    "audience user orgs",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
  );
  await writeAudienceUserOrgs(env, login, orgs);
  return orgs;
}

async function audienceUserRepos(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<GitHubUserRepository[]> {
  const cached = await readAudienceUserRepos(env, login);
  if (cached) return cached;
  const reposPath =
    profileType === "Organization"
      ? `/orgs/${encodeURIComponent(login)}/repos?sort=updated&type=public&per_page=${repoAudienceUserRepoLimit}`
      : `/users/${encodeURIComponent(login)}/repos?sort=updated&type=owner&per_page=${repoAudienceUserRepoLimit}`;
  const repos = await detailGitHubJson(
    reposPath,
    gitHubUserRepositoryListSchema,
    "audience user repositories",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    auditArea,
  );
  const publicRepos = repos.filter(isPublicAudienceRepository);
  await writeAudienceUserRepos(env, login, publicRepos);
  return publicRepos;
}

function isPublicAudienceRepository(repo: GitHubUserRepository): boolean {
  if (repo.private === true) return false;
  if (repo.visibility && repo.visibility !== "public") return false;
  return true;
}

async function audienceUserInsights(
  login: string,
  env: Env,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  profileType: GitHubUserProfile["type"] = "User",
  auditArea: GitHubAuditArea = "repo-audience",
): Promise<{ orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] }> {
  const [orgs, repos] = await Promise.all([
    profileType === "Organization"
      ? Promise.resolve([])
      : audienceUserOrgs(login, env, token, quotaSource, quotaAccount, onQuota, auditArea).catch(
          (error) => {
            if (isGitHubRateLimit(error)) throw error;
            return [];
          },
        ),
    audienceUserRepos(
      login,
      env,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      profileType,
      auditArea,
    ).catch((error) => {
      if (isGitHubRateLimit(error)) throw error;
      return [];
    }),
  ]);
  return { orgs, repos };
}

function audienceOrgSignals(orgs: GitHubUserOrganization[]): AudienceOrgSignal[] {
  return orgs.slice(0, 8).map((org) => ({
    login: org.login,
    description: org.description,
  }));
}

function audienceRepoSignals(repos: GitHubUserRepository[]): AudienceRepoSignal[] {
  return repos
    .filter((repo) => !repo.archived && !repo.fork)
    .slice(0, repoAudienceUserRepoLimit)
    .map((repo) => ({
      fullName: repo.full_name,
      description: repo.description,
      url: repo.html_url,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      updatedAt: repo.updated_at,
      pushedAt: repo.pushed_at,
      topics: repo.topics ?? [],
    }));
}

function audienceUser(
  stargazer: GitHubStargazer,
  profile: GitHubUserProfile | null,
  insights: { orgs: GitHubUserOrganization[]; repos: GitHubUserRepository[] } | null,
  targetLanguage: string | null,
  targetTopics: string[],
): RepoAudienceUser {
  const login = profile?.login ?? stargazer.user.login;
  const orgs = audienceOrgSignals(insights?.orgs ?? []);
  const repos = audienceRepoSignals(insights?.repos ?? []);
  const score = calculateAudienceScore({
    login,
    followers: profile?.followers ?? 0,
    following: profile?.following ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    publicGists: profile?.public_gists ?? 0,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    blog: profile?.blog ?? null,
    twitterUsername: profile?.twitter_username ?? null,
    accountCreatedAt: profile?.created_at ?? null,
    accountUpdatedAt: profile?.updated_at ?? null,
    starredAt: stargazer.starred_at,
    targetLanguage,
    targetTopics,
    orgs,
    repos,
  });
  return {
    login,
    avatarUrl: profile?.avatar_url ?? stargazer.user.avatar_url,
    url: profile?.html_url ?? stargazer.user.html_url,
    name: profile?.name ?? null,
    company: profile?.company ?? null,
    bio: profile?.bio ?? null,
    location: profile?.location ?? null,
    followers: profile?.followers ?? 0,
    publicRepos: profile?.public_repos ?? 0,
    starredAt: stargazer.starred_at,
    score: score.score,
    tier: score.tier,
    reasons: score.reasons,
    dimensions: score.dimensions,
    factors: score.factors,
    orgs,
    topRepositories: repos
      .sort(
        (a, b) => b.stars - a.stars || b.forks - a.forks || a.fullName.localeCompare(b.fullName),
      )
      .slice(0, 3)
      .map((repo) => ({
        fullName: repo.fullName,
        url: repo.url,
        description: repo.description,
        language: repo.language,
        stars: repo.stars,
        forks: repo.forks,
        updatedAt: repo.pushedAt ?? repo.updatedAt,
      })),
    accountCreatedAt: profile?.created_at ?? null,
  };
}

function roundedPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function audienceTotals(
  users: RepoAudienceUser[],
  totalStargazers: number,
): RepoAudiencePayload["totals"] {
  const count = (tier: AudienceScoreTier) => users.filter((user) => user.tier === tier).length;
  const highSignal = count("high");
  const mediumSignal = count("medium");
  const lowSignal = count("low");
  const bots = count("bot");
  const scored = users.length;
  return {
    stargazers: totalStargazers,
    stargazersSampled: scored,
    highSignal,
    mediumSignal,
    lowSignal,
    bots,
    highSignalPercent: roundedPercent(highSignal, scored),
    mediumSignalPercent: roundedPercent(mediumSignal, scored),
    lowSignalPercent: roundedPercent(lowSignal, scored),
    botPercent: roundedPercent(bots, scored),
  };
}

function trustProfileCacheKey(login: string): string {
  return `trust-profile:v4:${slugOwner(login)}`;
}

function trustProfileAgeMs(payload: TrustProfilePayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

async function readTrustProfile(env: Env, key: string): Promise<TrustProfilePayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<TrustProfilePayload>(raw, `trust profile ${key}`) : null;
}

function userTrustSignal(profile: TrustProfilePayload | null): UserTrustSignal | null {
  if (!profile || profile.profileKind !== "user_trust") return null;
  return { score: profile.score, tier: profile.tier };
}

async function cachedUserTrustSignals(
  env: Env,
  logins: Array<string | null | undefined>,
): Promise<Map<string, UserTrustSignal>> {
  const signals = new Map<string, UserTrustSignal>();
  if (!env.DASHBOARD_CACHE) return signals;
  const slugs = Array.from(
    new Set(
      logins
        .filter((login): login is string => Boolean(login))
        .map(slugOwner)
        .filter(validOwnerSlug),
    ),
  );
  await Promise.all(
    slugs.map(async (login) => {
      const signal = userTrustSignal(await readTrustProfile(env, trustProfileCacheKey(login)));
      if (signal) signals.set(login, signal);
    }),
  );
  return signals;
}

async function withRepoAudienceTrustProfiles(
  payload: RepoAudiencePayload,
  env: Env,
): Promise<RepoAudiencePayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.users.map((user) => user.login),
  );
  return {
    ...payload,
    users: payload.users.map((user) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = user;
      const signal = signals.get(slugOwner(user.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

async function withRepoDetailContributorTrustProfiles(
  payload: RepoDetailPayload,
  env: Env,
): Promise<RepoDetailPayload> {
  const signals = await cachedUserTrustSignals(
    env,
    payload.contributors.map((contributor) => contributor.login),
  );
  return {
    ...payload,
    contributors: payload.contributors.map((contributor) => {
      const { trustScore: _trustScore, trustTier: _trustTier, ...base } = contributor;
      const signal = signals.get(slugOwner(contributor.login));
      return signal ? { ...base, trustScore: signal.score, trustTier: signal.tier } : base;
    }),
  };
}

async function writeTrustProfile(
  env: Env,
  key: string,
  payload: TrustProfilePayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function refreshTrustProfile(
  key: string,
  login: string,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await buildTrustProfile(login, request, env);
    await writeTrustProfile(env, key, payload);
  } finally {
    await lock.release();
  }
}

function signalCounts(
  values: Array<string | null | undefined>,
  limit = 5,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name = usefulSignalName(value);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function usefulSignalName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function topTrustRepositories(repos: AudienceRepoSignal[]): TrustProfilePayload["topRepositories"] {
  return repos
    .sort((a, b) => b.stars - a.stars || b.forks - a.forks || a.fullName.localeCompare(b.fullName))
    .slice(0, 5)
    .map((repo) => ({
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description,
      language: repo.language,
      stars: repo.stars,
      forks: repo.forks,
      updatedAt: repo.pushedAt ?? repo.updatedAt,
      topics: repo.topics,
    }));
}

function clampProfileScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreTier(score: number): AudienceScoreTier {
  return score >= 70 ? "high" : score >= 40 ? "medium" : "low";
}

function retitleFactor(
  factor: AudienceScoreFactor,
  label: string,
  detail: string,
  value = factor.value,
  maxValue = factor.maxValue,
): AudienceScoreFactor {
  const clamped = clampProfileScore(value);
  return {
    ...factor,
    label,
    detail,
    value: clamped,
    maxValue,
    weightedValue: Math.round(clamped * factor.weight * 100) / 100,
  };
}

function orgSignalScore(
  base: ReturnType<typeof calculateAudienceScore>,
  profile: GitHubUserProfile,
  repos: AudienceRepoSignal[],
  activeRepositories: number,
): ReturnType<typeof calculateAudienceScore> {
  const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
  const totalForks = repos.reduce((sum, repo) => sum + repo.forks, 0);
  const repoFootprint = clampProfileScore(
    Math.min(Math.log10(profile.public_repos + 1) * 18, 38) +
      Math.min(Math.log10(totalStars + totalForks + 1) * 18, 44) +
      Math.min(activeRepositories * 4, 18),
  );
  const profileFields = [
    profile.name,
    profile.company,
    profile.bio,
    profile.location,
    profile.blog,
    profile.twitter_username,
  ].filter((value) => typeof value === "string" && value.trim()).length;
  const orgCredibility = clampProfileScore(
    Math.min((daysSince(profile.created_at) ?? 0) / 90, 28) +
      Math.min(profileFields * 8, 32) +
      Math.min(Math.log10(profile.public_repos + 1) * 12, 24) +
      Math.min(Math.log10(totalStars + 1) * 8, 16),
  );
  const reach = clampProfileScore(
    Math.max(base.dimensions.influence, Math.min(Math.log10(totalStars + 1) * 20, 68)),
  );
  const dimensions = {
    trust: orgCredibility,
    influence: reach,
    builder: Math.max(base.dimensions.builder, repoFootprint),
    recency: base.dimensions.recency,
    risk: base.dimensions.risk,
  };
  const score = clampProfileScore(
    dimensions.trust * 0.24 +
      dimensions.builder * 0.34 +
      dimensions.influence * 0.28 +
      dimensions.risk * 0.14,
  );
  const factors = base.factors
    .filter((factor) => factor.key !== "orgs" && factor.key !== "recency")
    .map((factor) => {
      if (factor.key === "age") {
        return retitleFactor(
          factor,
          "organization age",
          profile.created_at
            ? `${daysSince(profile.created_at)?.toLocaleString("en")} days on GitHub`
            : "GitHub organization age unavailable",
        );
      }
      if (factor.key === "profile") {
        return retitleFactor(factor, "organization profile", factor.detail);
      }
      if (factor.key === "reach") {
        return retitleFactor(
          factor,
          "project reach",
          `${totalStars.toLocaleString("en")} stars, ${profile.followers.toLocaleString("en")} followers`,
          reach,
          100,
        );
      }
      if (factor.key === "builder") {
        return retitleFactor(
          factor,
          "repository footprint",
          `${profile.public_repos.toLocaleString("en")} public repos, ${activeRepositories.toLocaleString("en")} recently active`,
          repoFootprint,
          100,
        );
      }
      if (factor.key === "risk") {
        return retitleFactor(factor, "profile safety", factor.detail);
      }
      return factor;
    });
  const reasons = [
    "organization account",
    profile.public_repos > 0 ? `${profile.public_repos.toLocaleString("en")} public repos` : "",
    totalStars > 0 ? `${totalStars.toLocaleString("en")} public repo stars` : "",
    activeRepositories > 0
      ? `${activeRepositories.toLocaleString("en")} recently active repos`
      : "",
    ...base.reasons.filter(
      (reason) =>
        !/^\d+ public org/.test(reason) &&
        !reason.startsWith("notable org:") &&
        reason !== "active public builder",
    ),
  ].filter(Boolean);
  return {
    score,
    tier: scoreTier(score),
    reasons: reasons.length > 0 ? reasons : ["public organization signal is light"],
    dimensions,
    factors,
  };
}

async function buildTrustProfile(
  login: string,
  request: Request,
  env: Env,
): Promise<TrustProfilePayload> {
  const requestToken = await bestInstallationToken(request, env, {
    owners: [login],
    repos: [],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const profile = await audienceUserProfile(
    login,
    env,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    "trust-profile",
  );
  if (!profile) {
    throw new Error("GitHub profile not found");
  }
  const isOrg = profile.type === "Organization";
  const { orgs, repos } = await audienceUserInsights(
    profile.login,
    env,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    profile.type,
    "trust-profile",
  );
  const orgSignals = audienceOrgSignals(orgs);
  const repoSignals = audienceRepoSignals(repos);
  const activeRepositories = repoSignals.filter((repo) => {
    const ageDays = daysSince(repo.pushedAt ?? repo.updatedAt);
    return ageDays !== null && ageDays <= 180;
  }).length;
  const baseScore = calculateAudienceScore({
    login: profile.login,
    followers: profile.followers,
    following: profile.following,
    publicRepos: profile.public_repos,
    publicGists: profile.public_gists,
    company: profile.company,
    bio: profile.bio,
    location: profile.location,
    blog: profile.blog,
    twitterUsername: profile.twitter_username,
    accountCreatedAt: profile.created_at,
    accountUpdatedAt: profile.updated_at,
    starredAt: null,
    orgs: orgSignals,
    repos: repoSignals,
  });
  const score = isOrg
    ? orgSignalScore(baseScore, profile, repoSignals, activeRepositories)
    : baseScore;
  const generatedAt = new Date().toISOString();
  return {
    login: profile.login,
    type: isOrg ? "org" : "user",
    profileKind: isOrg ? "org_signal" : "user_trust",
    scoreLabel: isOrg ? "org signal" : "trust score",
    avatarUrl: profile.avatar_url,
    url: profile.html_url,
    name: profile.name,
    company: profile.company,
    bio: profile.bio,
    location: profile.location,
    blog: profile.blog,
    twitterUsername: profile.twitter_username,
    followers: profile.followers,
    following: profile.following,
    publicRepos: profile.public_repos,
    publicGists: profile.public_gists,
    accountCreatedAt: profile.created_at,
    accountUpdatedAt: profile.updated_at,
    accountAgeDays: daysSince(profile.created_at),
    score: score.score,
    tier: score.tier,
    reasons: score.reasons,
    dimensions: score.dimensions,
    factors: score.factors,
    orgs: orgSignals,
    topRepositories: topTrustRepositories(repoSignals),
    stats: {
      totalStars: repoSignals.reduce((sum, repo) => sum + repo.stars, 0),
      totalForks: repoSignals.reduce((sum, repo) => sum + repo.forks, 0),
      recentRepositories: repoSignals.length,
      activeRepositories,
      publicOrganizations: orgSignals.length,
      languages: signalCounts(repoSignals.map((repo) => repo.language)),
      topics: signalCounts(repoSignals.flatMap((repo) => repo.topics)),
    },
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: isOrg
        ? "bounded public GitHub organization signals"
        : "bounded public GitHub profile signals",
      ...(quota ? { quota } : {}),
    },
  };
}

function withTrustProfileState(
  payload: TrustProfilePayload,
  state: TrustProfilePayload["cache"]["state"],
  message = payload.cache.message,
): TrustProfilePayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

async function trustProfileResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const login = slugOwner(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
  if (!validOwnerSlug(login)) {
    return jsonResponse({ error: "invalid user" }, 400, { "cache-control": "no-store" });
  }
  const key = trustProfileCacheKey(login);
  const cached = await readTrustProfile(env, key);
  const ageMs = trustProfileAgeMs(cached);
  if (cached && ageMs < repoAudienceCacheTtlMs) {
    return jsonResponse(withTrustProfileState(cached, "fresh"));
  }
  if (cached && ageMs <= maxDisplayStaleMs) {
    context.waitUntil(refreshTrustProfile(key, login, request, env).catch(() => undefined));
    return jsonResponse(withTrustProfileState(cached, "stale", "refreshing trust profile"));
  }
  try {
    const payload = await buildTrustProfile(login, request, env);
    await writeTrustProfile(env, key, payload);
    return jsonResponse(payload, 200, { "cache-control": "public, max-age=60" });
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

function withRepoAudienceState(
  payload: RepoAudiencePayload,
  state: RepoAudiencePayload["cache"]["state"],
  message = payload.cache.message,
): RepoAudiencePayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

async function buildRepoAudience(
  owner: string,
  repoName: string,
  range: AudienceRange,
  request: Request,
  env: Env,
  tokenOverride?: RequestToken | null,
): Promise<RepoAudiencePayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken =
    tokenOverride ??
    (await requestInstallationToken(request, env, {
      owners: [],
      repos: [fullName],
    }).catch(() => null));
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository audience",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }
  const since = Date.now() - audienceRangeMs(range);
  const stargazers = (
    await recentRepoStargazers(owner, repoName, path, token, quotaSource, quotaAccount, onQuota)
  ).filter((stargazer) => {
    const starredAt = Date.parse(stargazer.starred_at ?? "");
    return Number.isFinite(starredAt) && starredAt >= since;
  });
  const profileEntries = await Promise.all(
    stargazers.map(async (stargazer) => {
      const profile = await audienceUserProfile(
        stargazer.user.login,
        env,
        token,
        quotaSource,
        quotaAccount,
        onQuota,
      ).catch((error) => {
        if (isGitHubRateLimit(error)) throw error;
        return null;
      });
      return { stargazer, profile };
    }),
  );
  const shallowUsers = profileEntries.map(({ stargazer, profile }) =>
    audienceUser(stargazer, profile, null, repo.language, repo.topics ?? []),
  );
  const deepLogins = new Set(
    shallowUsers
      .filter((user) => user.tier !== "bot")
      .sort(
        (a, b) =>
          b.score - a.score ||
          Date.parse(b.starredAt ?? "") - Date.parse(a.starredAt ?? "") ||
          a.login.localeCompare(b.login),
      )
      .slice(0, repoAudienceDeepUserLimit)
      .map((user) => user.login.toLowerCase()),
  );
  const users = (
    await Promise.all(
      profileEntries.map(async ({ stargazer, profile }) => {
        const login = (profile?.login ?? stargazer.user.login).toLowerCase();
        const insights = deepLogins.has(login)
          ? await audienceUserInsights(
              login,
              env,
              token,
              quotaSource,
              quotaAccount,
              onQuota,
              profile?.type ?? "User",
            )
          : null;
        return audienceUser(stargazer, profile, insights, repo.language, repo.topics ?? []);
      }),
    )
  ).sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.starredAt ?? "") - Date.parse(a.starredAt ?? "") ||
      a.login.localeCompare(b.login),
  );
  const generatedAt = new Date().toISOString();
  return {
    fullName: repo.full_name,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public stargazer profile signals only",
      ...(quota ? { quota } : {}),
    },
    totals: audienceTotals(users, repo.stargazers_count),
    users,
  };
}

async function refreshRepoAudience(
  key: string,
  owner: string,
  repo: string,
  range: AudienceRange,
  request: Request,
  env: Env,
  tokenOverride?: RequestToken | null,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await buildRepoAudience(owner, repo, range, request, env, tokenOverride);
    await writeRepoAudience(env, key, payload);
  } finally {
    await lock.release();
  }
}

async function repoAudienceResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const range = audienceRangeFromUrl(url);
  const key = repoAudienceCacheKey(owner, repo, range);
  const cached = await readRepoAudience(env, key);
  const ageMs = repoAudienceAgeMs(cached);
  if (cached && ageMs < repoAudienceCacheTtlMs) {
    return jsonResponse(
      withRepoAudienceState(await withRepoAudienceTrustProfiles(cached, env), "fresh"),
    );
  }
  const requestToken = appTokenConfigured(env)
    ? await requestInstallationToken(request, env, {
        owners: [],
        repos: [fullName],
      }).catch(() => null)
    : null;
  const canBuildAudience = !appTokenConfigured(env) || Boolean(requestToken);
  if (cached && ageMs <= maxDisplayStaleMs) {
    if (canBuildAudience) {
      context.waitUntil(refreshRepoAudience(key, owner, repo, range, request, env, requestToken));
    }
    return jsonResponse(
      withRepoAudienceState(
        await withRepoAudienceTrustProfiles(cached, env),
        "stale",
        canBuildAudience
          ? "refreshing repository audience signals"
          : "connect the GitHub App for this repository to refresh audience signals",
      ),
    );
  }
  if (!canBuildAudience) {
    return jsonResponse(
      { error: "connect the GitHub App for this repository before building audience caches" },
      403,
      { "cache-control": "no-store" },
    );
  }

  try {
    const payload = await buildRepoAudience(owner, repo, range, request, env, requestToken);
    await writeRepoAudience(env, key, payload);
    return jsonResponse(await withRepoAudienceTrustProfiles(payload, env), 200, {
      "cache-control": "public, max-age=60",
    });
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

async function repoAudienceBackfillResponse(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "backfill requires POST" }, 405, { allow: "POST" });
  }
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const requestToken = await requestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  if (!requestToken) {
    return jsonResponse(
      { error: "connect the GitHub App for this repository before backfilling audience caches" },
      403,
      { "cache-control": "no-store" },
    );
  }
  const force = url.searchParams.get("force") === "1";
  const ranges: Array<{
    range: AudienceRange;
    state: "busy" | "fresh" | "rebuilt";
    users: number;
    generatedAt: string;
  }> = [];
  for (const range of repoAudienceRanges) {
    const key = repoAudienceCacheKey(owner, repo, range);
    const cached = await readRepoAudience(env, key);
    const ageMs = repoAudienceAgeMs(cached);
    if (!force && cached && ageMs < repoAudienceCacheTtlMs) {
      ranges.push({
        range,
        state: "fresh",
        users: cached.users.length,
        generatedAt: cached.generatedAt,
      });
      continue;
    }
    const lock = await acquireBuildLock(env, `${key}:backfill`);
    if (!lock) {
      ranges.push({
        range,
        state: "busy",
        users: cached?.users.length ?? 0,
        generatedAt: cached?.generatedAt ?? new Date().toISOString(),
      });
      continue;
    }
    try {
      const payload = await buildRepoAudience(owner, repo, range, request, env, requestToken);
      await writeRepoAudience(env, key, payload);
      ranges.push({
        range,
        state: "rebuilt",
        users: payload.users.length,
        generatedAt: payload.generatedAt,
      });
    } finally {
      await lock.release();
    }
  }
  return jsonResponse(
    {
      fullName,
      ranges,
      quota: {
        source: requestToken.quotaSource,
        account: requestToken.quotaAccount,
      },
      message: "bounded stargazer trust caches backfilled with GitHub App quota",
    },
    200,
    { "cache-control": "no-store" },
  );
}

function repoDetailCacheKey(owner: string, repo: string): string {
  return `repo-detail:v4:${slugOwner(owner)}/${repo.toLowerCase()}`;
}

function releaseSummaryModel(env: Env): string {
  return env.OPENAI_SUMMARY_MODEL || "chat-latest";
}

function releaseSummaryCacheKey(project: Project, model: string): string | null {
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return null;
  }
  return [
    `release-summary:v${releaseSummaryPromptVersion}`,
    project.fullName.toLowerCase(),
    encodeURIComponent(project.version),
    project.latestCommitSha,
    encodeURIComponent(model),
  ].join(":");
}

async function readRepoDetail(env: Env, key: string): Promise<RepoDetailPayload | null> {
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailPayload>(raw, `repo detail ${key}`) : null;
}

async function writeRepoDetail(env: Env, key: string, payload: RepoDetailPayload): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

async function readReleaseSummary(
  env: Env,
  key: string | null,
): Promise<RepoDetailReleaseSummary | null> {
  if (!key) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailReleaseSummary>(raw, `release summary ${key}`) : null;
}

async function writeReleaseSummary(
  env: Env,
  key: string,
  summary: RepoDetailReleaseSummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function repoDetailAgeMs(payload: RepoDetailPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

function withRepoDetailState(
  payload: RepoDetailPayload,
  state: RepoDetailPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

async function optionalRepoDetail<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isGitHubRateLimit(error)) throw error;
    return fallback;
  }
}

function unavailableReleaseSummary(
  project: Project,
  model: string | null,
  message: string,
): RepoDetailReleaseSummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.releaseDate ? project.version : null,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message,
  };
}

async function releaseSummaryState(project: Project, env: Env): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!project.releaseDate || project.version === "unreleased") {
    return unavailableReleaseSummary(project, model, "No prior release to summarize.");
  }
  if (!project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "Latest commit is unavailable.");
  }
  if (project.commitsSinceRelease === null) {
    return unavailableReleaseSummary(project, model, "Commit comparison is unavailable.");
  }
  if (project.commitsSinceRelease === 0) {
    return {
      state: "ready",
      text: "No commits have landed since the latest release.",
      generatedAt: new Date().toISOString(),
      model,
      releaseTag: project.version,
      headSha: project.latestCommitSha,
      commitCount: 0,
      commitsUsed: 0,
    };
  }
  const key = releaseSummaryCacheKey(project, model);
  const cached = await readReleaseSummary(env, key);
  if (cached?.state === "ready") return cached;
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message: "Summarizing commits since the latest release.",
  };
}

function commitTitle(message: string): string {
  return message.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
}

async function compareCommitTitles(
  path: string,
  releaseTag: string,
  head: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
): Promise<{ titles: string[]; total: number | null }> {
  const titles: string[] = [];
  let total: number | null = null;
  for (let page = 1; titles.length < releaseSummaryCommitLimit; page += 1) {
    const compare = await detailGitHubJson(
      `${path}/compare/${encodeURIComponent(releaseTag)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      gitHubCompareSchema,
      "release summary compare",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "release-summary",
    );
    total = compare.total_commits ?? total;
    const pageTitles = (compare.commits ?? [])
      .map((commit) => commitTitle(commit.commit.message))
      .filter(Boolean);
    titles.push(...pageTitles);
    if (pageTitles.length === 0 || (total !== null && titles.length >= total)) break;
  }
  return { titles: titles.slice(0, releaseSummaryCommitLimit), total };
}

function openAIOutputText(body: unknown): string {
  if (body && typeof body === "object" && "output_text" in body) {
    const text = (body as { output_text?: unknown }).output_text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const output = body && typeof body === "object" ? (body as { output?: unknown }).output : null;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => {
      const content =
        item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function summarizeReleaseDelta(
  project: Project,
  path: string,
  request: Request,
  env: Env,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!env.OPENAI_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "No comparable release delta is available.");
  }
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [project.fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = () => undefined;
  const { titles, total } = await compareCommitTitles(
    path,
    project.version,
    project.latestCommitSha,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  if (titles.length === 0) {
    return unavailableReleaseSummary(
      project,
      model,
      "No commit titles were available to summarize.",
    );
  }
  const response = await workerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 450,
      instructions:
        "You summarize public GitHub commit titles for release dashboards. Write 2-4 concise sentences, past tense, no bullets, no hype, no markdown. Mention broad themes and user-visible changes when commit titles support them. Do not invent details beyond the commit titles.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Repository: ${project.fullName}`,
                `Latest release: ${project.version}`,
                `Default branch head: ${project.latestCommitSha}`,
                `Commit titles included: ${titles.length} of ${total ?? project.commitsSinceRelease ?? titles.length}`,
                "",
                titles.map((title, index) => `${index + 1}. ${title}`).join("\n"),
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: { message?: string } }).error?.message ?? "OpenAI API error")
        : `OpenAI API ${response.status}`;
    throw new Error(message);
  }
  const text = openAIOutputText(body);
  if (!text) throw new Error("OpenAI response did not include summary text");
  return {
    state: "ready",
    text,
    generatedAt: new Date().toISOString(),
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: total ?? project.commitsSinceRelease,
    commitsUsed: titles.length,
  };
}

type ContributorTrustSignal = UserTrustSignal;

async function cachedContributorTrustSignals(
  env: Env,
  contributors: Array<InferOutput<typeof gitHubContributorSchema>>,
): Promise<Map<string, ContributorTrustSignal>> {
  const logins = Array.from(
    new Set(
      contributors
        .map((contributor) => contributor.login)
        .filter((login): login is string => Boolean(login))
        .map(slugOwner),
    ),
  );
  return cachedUserTrustSignals(env, logins);
}

async function buildRepoDetail(
  owner: string,
  repoName: string,
  request: Request,
  env: Env,
): Promise<RepoDetailPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (next: ApiQuota) => {
    quota = next;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository detail",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
  );
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }

  const [releases, contributors, languages, latestCommit, openPullRequests] = await Promise.all([
    detailGitHubJson(
      `${path}/releases?per_page=100`,
      v.array(gitHubReleaseSchema),
      "repository releases",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
    ),
    optionalRepoDetail(
      detailGitHubJson(
        `${path}/contributors?per_page=12`,
        v.array(gitHubContributorSchema),
        "repository contributors",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
      ),
      [],
    ),
    optionalRepoDetail(
      detailGitHubJson(
        `${path}/languages`,
        gitHubLanguageSchema,
        "repository languages",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
      ),
      {},
    ),
    optionalRepoDetail(
      detailGitHubJson(
        `${path}/commits/${encodeURIComponent(repo.default_branch)}`,
        gitHubCommitSchema,
        "latest commit",
        token,
        quotaSource,
        quotaAccount,
        onQuota,
      ),
      null,
    ),
    detailGitHubCount(
      `${path}/pulls?state=open&per_page=1`,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
    ),
  ]);

  const latestRelease = releases.find((release) => !release.draft) ?? null;
  const compare = latestRelease
    ? await optionalRepoDetail(
        detailGitHubJson(
          `${path}/compare/${encodeURIComponent(latestRelease.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
          gitHubCompareSchema,
          "release compare",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
        ),
        null,
      )
    : null;
  const checks = latestCommit?.sha
    ? await optionalRepoDetail(
        detailGitHubJson(
          `${path}/commits/${encodeURIComponent(latestCommit.sha)}/check-runs?per_page=100`,
          gitHubCheckRunsSchema,
          "repository check runs",
          token,
          quotaSource,
          quotaAccount,
          onQuota,
        ),
        null,
      )
    : null;

  const [commitActivity, codeFrequency, workTrend] = await Promise.all([
    detailGitHubStats(
      `${path}/stats/commit_activity`,
      gitHubCommitActivitySchema,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
    ),
    detailGitHubStats(
      `${path}/stats/code_frequency`,
      gitHubCodeFrequencySchema,
      token,
      quotaSource,
      quotaAccount,
      onQuota,
    ),
    buildWorkTrend(repo.full_name, token, quotaSource, quotaAccount, onQuota).catch(() => null),
  ]);
  const statsWarming = [commitActivity, codeFrequency].some((stat) => stat.state === "warming");
  const project = releaseProject(repo);
  project.openPullRequests = openPullRequests;
  project.openIssues = Math.max(repo.open_issues_count - openPullRequests, 0);
  project.latestCommitSha = latestCommit?.sha.slice(0, 7) ?? null;
  project.latestCommitDate = latestCommit?.commit.committer?.date ?? null;
  project.version = latestRelease?.tag_name ?? "unreleased";
  project.releaseName = latestRelease?.name ?? null;
  project.releaseUrl = latestRelease?.html_url ?? repo.html_url;
  project.releaseDate = latestRelease?.published_at ?? null;
  project.commitsSinceRelease = compare?.total_commits ?? null;
  project.compareUrl = compare?.html_url ?? null;
  project.freshness = freshnessForDetail(project.commitsSinceRelease);
  const ci = detailCiDetails(checks?.check_runs ?? []);
  project.ciStatus = ci.ciStatus;
  project.ciConclusion = ci.ciConclusion;
  project.ciWorkflow = ci.ciWorkflow;
  project.ciUrl = ci.ciUrl;
  project.ciRunDate = ci.ciRunDate;
  project.ciState = ci.ciState;
  const [releaseSummary, contributorTrustSignals] = await Promise.all([
    releaseSummaryState(project, env),
    cachedContributorTrustSignals(env, contributors),
  ]);

  const generatedAt = new Date().toISOString();
  return {
    fullName: repo.full_name,
    generatedAt,
    cache: {
      state: statsWarming ? "warming" : "fresh",
      stale: statsWarming,
      generatedAt,
      ...(statsWarming ? { message: "GitHub is preparing repository statistics." } : {}),
      ...(quota ? { quota } : {}),
    },
    stats: {
      commitActivity: {
        state: commitActivity.state,
        ...(commitActivity.message ? { message: commitActivity.message } : {}),
      },
      codeFrequency: {
        state: codeFrequency.state,
        ...(codeFrequency.message ? { message: codeFrequency.message } : {}),
      },
    },
    releaseSummary,
    project,
    releases: releases
      .filter((release) => !release.draft)
      .map((release) => ({
        name: release.name,
        tagName: release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        prerelease: release.prerelease ?? false,
      })),
    contributors: contributors.map((contributor) => {
      const login = contributor.login ?? "anonymous";
      const trustSignal = contributorTrustSignals.get(slugOwner(login));
      return {
        login,
        avatarUrl: contributor.avatar_url ?? null,
        url: contributor.html_url ?? null,
        commits: contributor.contributions,
        ...(trustSignal ? { trustScore: trustSignal.score, trustTier: trustSignal.tier } : {}),
      };
    }),
    commitActivity: (commitActivity.data ?? []).map((week) => ({
      week: new Date(week.week * 1000).toISOString(),
      total: week.total,
      days: week.days,
    })),
    codeFrequency: (codeFrequency.data ?? []).map(([week, additions, deletions]) => ({
      week: new Date(week * 1000).toISOString(),
      additions,
      deletions: Math.abs(deletions),
    })),
    languages: Object.entries(languages)
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    workTrend,
  };
}

function freshnessForDetail(commits: number | null): Project["freshness"] {
  if (commits === 0) return "fresh";
  if (commits !== null && commits <= 5) return "warm";
  if (commits !== null && commits <= 25) return "busy";
  return "hot";
}

type DetailCheckRun = NonNullable<InferOutput<typeof gitHubCheckRunsSchema>["check_runs"]>[number];

function detailCiDetails(
  runs: DetailCheckRun[],
): Pick<Project, "ciState" | "ciStatus" | "ciConclusion" | "ciWorkflow" | "ciUrl" | "ciRunDate"> {
  if (runs.length === 0) {
    return {
      ciState: "unknown",
      ciStatus: null,
      ciConclusion: null,
      ciWorkflow: null,
      ciUrl: null,
      ciRunDate: null,
    };
  }

  const failure = runs.find((run) =>
    ["failure", "timed_out", "action_required"].includes(run.conclusion ?? ""),
  );
  const active = runs.find((run) => run.status && run.status !== "completed");
  const cancelled = runs.find((run) => run.conclusion === "cancelled");
  const successCount = runs.filter((run) => run.conclusion === "success").length;
  const neutralCount = runs.filter((run) => run.conclusion === "neutral").length;
  const skippedCount = runs.filter((run) => run.conclusion === "skipped").length;
  const selected = failure ?? active ?? cancelled ?? runs[0];

  let ciState: Project["ciState"] = "unknown";
  if (failure) {
    ciState = "failure";
  } else if (active) {
    ciState = active.status === "in_progress" ? "running" : "pending";
  } else if (cancelled) {
    ciState = "cancelled";
  } else if (successCount > 0) {
    ciState = "success";
  } else if (neutralCount > 0) {
    ciState = "neutral";
  } else if (skippedCount > 0) {
    ciState = "skipped";
  }

  return {
    ciState,
    ciStatus: selected.status ?? null,
    ciConclusion: selected.conclusion ?? null,
    ciWorkflow:
      ciState === "success" ? `${successCount}/${runs.length} checks` : (selected.name ?? null),
    ciUrl: selected.html_url ?? null,
    ciRunDate: selected.completed_at ?? selected.started_at ?? null,
  };
}

async function refreshRepoDetail(
  key: string,
  owner: string,
  repo: string,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, `${key}:refresh`);
  if (!lock) return;
  try {
    const payload = await buildRepoDetail(owner, repo, request, env);
    await writeRepoDetail(env, key, payload);
  } finally {
    await lock.release();
  }
}

function releaseSummaryNeedsRefresh(payload: RepoDetailPayload | null, env: Env): boolean {
  const hasComparableCommits =
    !!payload?.project.releaseDate &&
    payload.project.version !== "unreleased" &&
    !!payload.project.latestCommitSha &&
    payload.project.commitsSinceRelease !== null &&
    payload.project.commitsSinceRelease > 0;
  return (
    payload?.releaseSummary?.state === "warming" ||
    (hasComparableCommits &&
      !!payload?.releaseSummary &&
      payload.releaseSummary.model !== releaseSummaryModel(env))
  );
}

async function refreshReleaseSummary(
  key: string,
  owner: string,
  repo: string,
  payload: RepoDetailPayload,
  request: Request,
  env: Env,
): Promise<void> {
  if (!env.OPENAI_API_KEY || !releaseSummaryNeedsRefresh(payload, env)) return;
  const lock = await acquireBuildLock(env, `${key}:release-summary`);
  if (!lock) return;
  try {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const summary = await summarizeReleaseDelta(payload.project, path, request, env);
    const summaryKey = releaseSummaryCacheKey(
      payload.project,
      summary.model ?? releaseSummaryModel(env),
    );
    if (summaryKey && summary.state === "ready") {
      await writeReleaseSummary(env, summaryKey, summary);
    }
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: summary,
    });
  } catch (error) {
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: {
        ...(latest.releaseSummary ?? payload.releaseSummary),
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: releaseSummaryModel(env),
        releaseTag: latest.project.releaseDate ? latest.project.version : null,
        headSha: latest.project.latestCommitSha,
        commitCount: latest.project.commitsSinceRelease,
        commitsUsed: 0,
        message: errorMessage(error),
      },
    });
  } finally {
    await lock.release();
  }
}

async function repoDetailResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }

  const key = repoDetailCacheKey(owner, repo);
  const cached = await readRepoDetail(env, key);
  const ageMs = repoDetailAgeMs(cached);
  if (cached?.cache.state === "warming" && ageMs < repoDetailWarmingRefreshMs) {
    if (releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(await withRepoDetailContributorTrustProfiles(cached, env), 202, {
      "cache-control": "no-store",
    });
  }
  if (cached && ageMs < repoDetailCacheTtlMs && cached.cache.state !== "warming") {
    if (releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(await withRepoDetailContributorTrustProfiles(cached, env));
  }
  if (cached && ageMs <= maxDisplayStaleMs) {
    context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
    if (releaseSummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, cached, request, env));
    }
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(
        withRepoDetailState(cached, "stale", "refreshing repository statistics"),
        env,
      ),
    );
  }

  try {
    const payload = await buildRepoDetail(owner, repo, request, env);
    await writeRepoDetail(env, key, payload);
    if (releaseSummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshReleaseSummary(key, owner, repo, payload, request, env));
    }
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(payload, env),
      payload.cache.state === "warming" ? 202 : 200,
      {
        "cache-control": payload.cache.state === "warming" ? "no-store" : "public, max-age=60",
      },
    );
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

async function cachedRepoInitialData(env: Env, fullName: string): Promise<InitialPageData | null> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  const cached = await readRepoDetail(env, repoDetailCacheKey(owner, repo));
  if (!cached || repoDetailAgeMs(cached) > maxDisplayStaleMs) return null;
  const payload =
    repoDetailAgeMs(cached) < repoDetailCacheTtlMs
      ? cached
      : withRepoDetailState(cached, "stale", "refreshing repository statistics");
  return { route: "repo", payload };
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
    topics: repo.topics ?? [],
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

function isRepositorySearchProject(project: Project): boolean {
  return (
    project.version === "repo search" &&
    project.releaseDate === null &&
    project.commitsSinceRelease === null &&
    project.compareUrl === null
  );
}

function discoverNeedsHydration(payload: DashboardPayload): boolean {
  if (payload.cache?.progress?.done === true) return false;
  return payload.projects.slice(0, discoverHydrateLimit).some(isRepositorySearchProject);
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
  auditGitHubTokenUse(
    "discover",
    `${search.pathname}${search.search}`,
    response.status,
    quotaFromResponse(response, env),
  );
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
      state: "partial",
      stale: true,
      capped: total > projects.length,
      repoLimit: discoverLimit,
      generatedAt,
      quota: quotaFromResponse(response, env),
      progress: {
        scanned: 0,
        limit: Math.min(discoverHydrateLimit, projects.length),
        done: false,
      },
      message: "repository search loaded; scanning release data for all visible repositories",
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

async function hydrateDiscoverPayload(
  payload: DashboardPayload,
  env: Env,
): Promise<DashboardPayload> {
  const now = new Date().toISOString();
  const limit = Math.min(discoverHydrateLimit, payload.projects.length);
  const scannedBefore = Math.min(payload.cache?.progress?.scanned ?? 0, limit);
  const scanned = Math.min(scannedBefore + discoverHydrateBatchSize, limit);
  const repos = payload.projects.slice(scannedBefore, scanned).map((project) => project.fullName);
  if (repos.length === 0) {
    return {
      ...payload,
      generatedAt: now,
      cache: {
        ...(payload.cache ?? {
          capped: false,
          repoLimit: discoverLimit,
          generatedAt: now,
        }),
        state: "fresh",
        stale: false,
        generatedAt: now,
        progress: { scanned: limit, limit, done: true },
        message: "repository search loaded",
      },
    };
  }
  const hydrated = await buildDashboard({
    title: payload.title,
    subtitle: payload.subtitle,
    canonicalDomain: payload.canonicalDomain,
    owners: [],
    includeRepos: repos,
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    token: env.GITHUB_TOKEN,
    quotaSource: env.GITHUB_TOKEN ? "shared" : "anonymous",
    fetch: auditGitHubFetch("discover", env.GITHUB_TOKEN ? "shared" : "anonymous", null),
    projectCache: env.DASHBOARD_CACHE,
  });
  const hydratedProjects = new Map(
    hydrated.projects.map((project) => [project.fullName.toLowerCase(), project]),
  );
  const projects = payload.projects.map(
    (project) => hydratedProjects.get(project.fullName.toLowerCase()) ?? project,
  );
  const done = scanned >= limit;
  return {
    ...payload,
    generatedAt: now,
    cache: {
      ...(payload.cache ?? {
        capped: false,
        repoLimit: discoverLimit,
        generatedAt: now,
      }),
      state: done ? "fresh" : "partial",
      stale: !done,
      generatedAt: now,
      ...((hydrated.cache?.quota ?? payload.cache?.quota)
        ? { quota: hydrated.cache?.quota ?? payload.cache?.quota }
        : {}),
      progress: {
        scanned,
        limit,
        done,
      },
      message: done
        ? `release data scanned for ${scanned} repositories`
        : `release data scanned for ${scanned}/${limit} repositories`,
    },
    totals: dashboardTotals(projects),
    projects,
  };
}

async function hydrateDiscoverCache(
  key: string,
  payload: DashboardPayload,
  env: Env,
): Promise<void> {
  if (!discoverNeedsHydration(payload)) return;
  const lock = await acquireBuildLock(env, `hydrate:${key}`);
  if (!lock) return;
  const refresh = globalThis.setInterval(() => {
    void lock.refresh();
  }, buildLockRefreshMs);
  try {
    const hydrated = await hydrateDiscoverPayload(payload, env);
    await writeCached(env, key, hydrated);
  } catch (error) {
    await writeCached(env, key, {
      ...payload,
      cache: {
        ...(payload.cache ?? {
          capped: false,
          repoLimit: discoverLimit,
          generatedAt: payload.generatedAt,
        }),
        state: "fresh",
        stale: false,
        progress: {
          scanned: 0,
          limit: Math.min(discoverHydrateLimit, payload.projects.length),
          done: true,
        },
        message: `release scan skipped: ${dashboardErrorMessage(error)}`,
      },
    });
  } finally {
    globalThis.clearInterval(refresh);
    await lock.release();
  }
}

async function discoverResponse(env: Env, url: URL, context: ExecutionContext): Promise<Response> {
  const period = discoverPeriod(url);
  const language = discoverLanguage(url);
  const key = discoverCacheKey(period, language);
  const cached = await readCached(env, key);
  const ageMs = cacheAgeMs(cached);
  if (cached && canDisplayCached(cached) && ageMs < discoverCacheTtlMs) {
    if (discoverNeedsHydration(cached)) {
      context.waitUntil(hydrateDiscoverCache(key, cached, env).catch(() => undefined));
      return jsonResponse(
        withCacheState(cached, "partial", "scanning release data for all visible repositories"),
        200,
        { "cache-control": "no-store" },
      );
    }
    return jsonResponse(withCacheState(cached, "fresh"));
  }

  try {
    const payload = await discoverPayload(period, language, env);
    await writeCached(env, key, payload);
    context.waitUntil(hydrateDiscoverCache(key, payload, env).catch(() => undefined));
    return jsonResponse(payload, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (canDisplayCached(cached)) {
      return jsonResponse(
        withCacheState(cached, "stale", `${discoveryErrorMessage(error)} Showing cached search.`),
      );
    }
    const payload = discoverErrorPayload(period, language, env, error);
    return jsonResponse(payload, errorStatus(error), retryAfterHeaders(error));
  }
}

async function cachedDiscoverInitialData(env: Env, url: URL): Promise<InitialPageData | null> {
  const period = discoverPeriod(url);
  const language = discoverPageLanguage(url);
  const cached = await readCached(env, discoverCacheKey(period, language));
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  const state = discoverNeedsHydration(cached)
    ? "partial"
    : cacheAgeMs(cached) < discoverCacheTtlMs
      ? "fresh"
      : "stale";
  return {
    route: "dashboard",
    payload: withCacheState(cached, state),
  };
}

async function dashboardCacheKeyForPage(
  request: Request,
  url: URL,
  env: Env,
  primaryOwner: string | null,
): Promise<string | null> {
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return null;
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
    return null;
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return null;
  }
  const ownerSlugs =
    primaryOwner && !hiddenProfileOwners.has(primaryOwner)
      ? [primaryOwner, ...extraOwnerSlugs]
      : extraOwnerSlugs;
  const tokenSources = { owners: ownerSlugs, repos: includeRepos };
  const token = await bestInstallationToken(request, env, tokenSources).catch(() => null);
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token);
  return dashboardCacheKey({
    owner: primaryOwner ?? "custom",
    owners: extraOwnerSlugs,
    repos: includeRepos,
    salt: profile?.updatedAt,
    ...options,
    includeReleaseData,
    schemaVersion: dashboardSchemaVersion,
  });
}

async function cachedDashboardInitialData(
  request: Request,
  env: Env,
  url: URL,
  primaryOwner: string | null,
): Promise<InitialPageData | null> {
  const key = await dashboardCacheKeyForPage(request, url, env, primaryOwner);
  const cached = key ? await readCached(env, key) : null;
  if (!cached || !canDisplayCached(cached) || cached.cache?.state === "error") return null;
  const state =
    cached.cache?.progress?.done === false
      ? "partial"
      : cacheAgeMs(cached) < fullTtlMs
        ? "fresh"
        : "stale";
  return { route: "dashboard", payload: withCacheState(cached, state) };
}

async function dashboardEventParts(request: Request, env: Env): Promise<{ key: string } | null> {
  const url = new URL(request.url);
  const rawOwner =
    url.pathname
      .replace(/^\/api\//, "")
      .replace(/\/events$/, "")
      .split("/")[0] ?? "";
  const primaryOwner = rawOwner === "dashboard" ? null : slugOwner(rawOwner);
  if (primaryOwner !== null && !validOwnerSlug(primaryOwner)) {
    return null;
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
    return null;
  }
  if (!primaryOwner && extraOwnerSlugs.length === 0 && includeRepos.length === 0) {
    return null;
  }
  const ownerSlugs =
    primaryOwner && !hiddenProfileOwners.has(primaryOwner)
      ? [primaryOwner, ...extraOwnerSlugs]
      : extraOwnerSlugs;
  const tokenSources = { owners: ownerSlugs, repos: includeRepos };
  const token = await bestInstallationToken(request, env, tokenSources).catch(() => null);
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token);
  return {
    key: dashboardCacheKey({
      owner: primaryOwner ?? "custom",
      owners: extraOwnerSlugs,
      repos: includeRepos,
      salt: profile?.updatedAt,
      ...options,
      includeReleaseData,
      schemaVersion: dashboardSchemaVersion,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dashboardStreamState(
  payload: DashboardPayload,
): NonNullable<DashboardPayload["cache"]>["state"] {
  if (payload.cache?.progress?.done === false) return "partial";
  return cacheAgeMs(payload) < fullTtlMs ? "fresh" : "stale";
}

async function ownerEventsResponse(request: Request, env: Env): Promise<Response> {
  const parts = await dashboardEventParts(request, env);
  if (!parts) {
    return jsonResponse({ error: "invalid dashboard event stream" }, 400, {
      "cache-control": "no-store",
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      controller.enqueue(encoder.encode("retry: 5000\n\n"));
      let lastSignature = "";
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const payload = await readCached(env, parts.key);
        if (canDisplayCached(payload)) {
          const state = dashboardStreamState(payload);
          const next = withCacheState(payload, state);
          const signature = `${next.generatedAt}:${state}:${next.cache?.progress?.scanned ?? ""}:${next.projects.length}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            send("dashboard", next);
          }
          if (state === "fresh") break;
        } else {
          send("ping", { state: "waiting" });
        }
        await sleep(5000);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...corsHeaders,
    },
  });
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
    const storedProgress = await readProgress(env, dashboard.key);
    const scannedRepos = new Set(storedProgress?.scannedRepos ?? []);
    const progressProjects = storedProgress?.projects ?? [];
    let lastProgressWriteAt = 0;
    const saveProgress = async (payload: DashboardPayload, scannedRepo: string) => {
      if (scannedRepo) {
        scannedRepos.add(scannedRepo.toLowerCase());
      }
      const done = payload.cache?.progress?.done !== false;
      const now = Date.now();
      if (!done && now - lastProgressWriteAt < progressWriteIntervalMs) {
        return;
      }
      lastProgressWriteAt = now;
      const profiled = withProfile(payload, dashboard.profile);
      await writeCached(env, dashboard.key, profiled);
      await writeProgress(env, dashboard.key, {
        scannedRepos: [...scannedRepos],
        projects: profiled.projects,
        updatedAt: profiled.generatedAt,
      });
    };
    const payload = await buildDashboard({
      title: "ReleaseBar",
      subtitle: dashboard.subtitle,
      canonicalDomain: env.RELEASEDECK_CANONICAL_DOMAIN ?? "release.bar",
      owners: dashboard.owners,
      includeRepos: dashboard.includeRepos,
      excludeRepos: dashboard.profile?.hiddenRepos,
      ...optionsFromUrl(dashboard.url),
      repoLimit,
      repoScanLimit: repoScanBatchSize,
      repoScanTarget: repoLimit,
      initialProjects: progressProjects,
      skipRepos: [...scannedRepos],
      token: dashboard.token ?? env.GITHUB_TOKEN,
      includeReleaseData: dashboard.includeReleaseData,
      quotaSource:
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
      quotaAccount: dashboard.quotaAccount ?? null,
      fetch: auditGitHubFetch(
        "dashboard",
        dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
        dashboard.quotaAccount ?? null,
      ),
      projectCache: env.DASHBOARD_CACHE,
      onProgress: (partial, progress) => saveProgress(partial, progress.scannedRepo),
    });
    const profiled = withProfile(payload, dashboard.profile);
    await writeCached(env, dashboard.key, profiled);
    if (profiled.cache?.progress?.done === false) {
      await writeProgress(env, dashboard.key, {
        scannedRepos: [...scannedRepos],
        projects: profiled.projects,
        updatedAt: profiled.generatedAt,
      });
    } else {
      await deleteProgress(env, dashboard.key);
      await rememberHotDashboard(env, dashboard.key, profiled);
    }
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

async function continueProgressiveBuild(dashboard: DashboardRequest, env: Env): Promise<void> {
  const startedAt = Date.now();
  let payload = await rebuildWithBuildLock(dashboard, env);
  while (
    payload?.cache?.progress?.done === false &&
    Date.now() - startedAt < progressiveBuildBudgetMs
  ) {
    payload = await rebuildWithBuildLock(dashboard, env);
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
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    ownerSlugs.map((login) => ({ type: "user", login })),
    includeRepos,
    profile,
    key,
    url,
    includeReleaseData,
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
  const tokenSources = { owners: ownerSlugs, repos: includeRepos };
  const requestToken = () => bestInstallationToken(request, env, tokenSources);
  const token = await requestToken().catch(() => null);
  const includeReleaseData = await dashboardReleaseDataAllowed(request, env, tokenSources, token);
  const key = dashboardCacheKey({
    owner: primaryOwner ?? "custom",
    owners: extraOwnerSlugs,
    repos: includeRepos,
    salt: profile?.updatedAt,
    ...options,
    includeReleaseData,
    schemaVersion: dashboardSchemaVersion,
  });
  const cached = await readCached(env, key);
  const ageMs = cacheAgeMs(cached);
  const displayCached = canDisplayCached(cached);

  if (displayCached && cached.cache?.state === "error") {
    const dashboard = cachedDashboardRequest(
      cached,
      includeRepos,
      key,
      url,
      includeReleaseData,
      token,
    );
    context.waitUntil(
      rebuildWithBuildLock(dashboard, env).catch((error) => cacheBuildError(dashboard, env, error)),
    );
    return jsonResponse(cached, errorStatus(cached.cache.message ?? ""), {
      "cache-control": "no-store",
    });
  }

  if (displayCached && cached.cache?.progress?.done !== false && ageMs < fullTtlMs) {
    return jsonResponse(withCacheState(cached, "fresh"), 200, authDependentDashboardHeaders(env));
  }

  if (displayCached) {
    const dashboard = cachedDashboardRequest(
      cached,
      includeRepos,
      key,
      url,
      includeReleaseData,
      token,
    );
    context.waitUntil(continueProgressiveBuild(dashboard, env).catch(() => undefined));
    const state = cached.cache?.progress?.done === false ? "partial" : "stale";
    return jsonResponse(withCacheState(cached, state), 200, {
      "cache-control": "no-store",
    });
  }

  let owners: Owner[] | null;
  try {
    owners = await resolveOwners(
      ownerSlugs,
      env,
      token?.token,
      token?.quotaSource,
      token?.quotaAccount ?? null,
    );
  } catch (error) {
    const dashboard = unresolvedDashboardRequest(
      ownerSlugs,
      includeRepos,
      profile,
      key,
      url,
      includeReleaseData,
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

  const dashboard = dashboardRequest(
    owners,
    includeRepos,
    profile,
    key,
    url,
    includeReleaseData,
    token,
  );
  const build = rebuildWithBuildLock(dashboard, env);
  try {
    const payload = await Promise.race([
      build,
      new Promise<typeof buildPending>((resolve) => {
        setTimeout(() => resolve(buildPending), coldBuildWaitMs);
      }),
    ]);
    if (payload === buildPending || payload === null) {
      context.waitUntil(
        build
          .then((built) =>
            built?.cache?.progress?.done === false
              ? continueProgressiveBuild(dashboard, env)
              : undefined,
          )
          .catch((error) => cacheBuildError(dashboard, env, error)),
      );
      const progressive = await readCached(env, key);
      if (canDisplayCached(progressive) && progressive.projects.length) {
        return jsonResponse(withCacheState(progressive, "partial"), 200, {
          "cache-control": "no-store",
        });
      }
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
    if (payload.cache?.progress?.done === false) {
      context.waitUntil(continueProgressiveBuild(dashboard, env).catch(() => undefined));
      return jsonResponse(payload, 200, {
        "cache-control": "no-store",
      });
    }
    return jsonResponse(payload, 200, authDependentDashboardHeaders(env));
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
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return dashboardRequest(
    payload.owners,
    includeRepos,
    payload.profile ?? null,
    key,
    url,
    includeReleaseData,
    token,
  );
}

function dashboardRequest(
  owners: Owner[],
  includeRepos: string[],
  profile: DashboardProfile | null,
  key: string,
  url: URL,
  includeReleaseData: boolean,
  token?: RequestToken | null,
): DashboardRequest {
  return {
    owners,
    includeRepos,
    profile,
    subtitle: dashboardSubtitle(owners, includeRepos),
    key,
    url,
    includeReleaseData,
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
    const audienceBackfillWrite =
      isRepoAudienceBackfillApiPath(url.pathname) && request.method === "POST";
    if (request.method !== "GET" && !isHead && !profileWrite && !audienceBackfillWrite) {
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
    return socialImage(await socialCardForLabel(title, request, env, context));
  }
  if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
    return jsonResponse(openApiSpec(url.origin));
  }
  if (url.pathname === "/api/swagger.json") {
    return jsonResponse(openApiSpec(url.origin));
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
    return discoverResponse(env, url, context);
  }
  if (isOwnerActivityApiPath(url.pathname)) {
    return ownerActivityResponse(request, env, context);
  }
  if (isRepoActivityApiPath(url.pathname)) {
    return repoActivityResponse(request, env, context);
  }
  if (isTrustProfileApiPath(url.pathname)) {
    return trustProfileResponse(request, env, context);
  }
  if (isRepoAudienceBackfillApiPath(url.pathname)) {
    return repoAudienceBackfillResponse(request, env);
  }
  if (isRepoAudienceApiPath(url.pathname)) {
    return repoAudienceResponse(request, env, context);
  }
  if (isRepoDetailApiPath(url.pathname)) {
    return repoDetailResponse(request, env, context);
  }
  if (isOwnerEventsApiPath(url.pathname)) {
    return ownerEventsResponse(request, env);
  }
  if (isOwnerApiPath(url.pathname)) {
    return ownerResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
  }
  return assetResponse(request, env);
}
