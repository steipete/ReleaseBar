import { slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type {
  AuthInstallation,
  AuthInstallationRecord,
  AuthPayload,
  AuthUser,
} from "../src/types.js";
import { listStoredInstallations, recordAuthFunnelEvent } from "./auth-observability.js";
import { randomNonce, signedJson } from "./crypto.js";
import { jsonResponse, redirectResponse, workerFetch } from "./http.js";
import type { Env } from "./runtime.js";
import {
  gitHubInstallationListSchema,
  gitHubInstallationRepositoryListSchema,
  gitHubInstallationSchema,
  gitHubOAuthTokenSchema,
  gitHubOAuthUserSchema,
  parseGitHubResponse,
  safeJsonParse,
  storedAuthSessionSchema,
} from "./schemas.js";
import * as v from "valibot";
import type { GenericSchema, InferOutput } from "valibot";
import {
  authConfigured,
  authUrls,
  currentSession,
  currentSessionRecord,
  oauthStateBinding,
  oauthStateCookieValue,
  parseCookies,
  safeReturnTo,
  type TokenSources,
} from "./app-shell.js";
import {
  cachedInstallationToken,
  githubAppJwt,
  nullOnNonAbortError,
  returnToSources,
  sourceAccounts,
  sourceCoverage,
} from "./auth-tokens.js";
import {
  accessTokenRefreshLeewaySeconds,
  installationAcknowledgementGraceMs,
  oauthReturnToMaxLength,
  type RequestToken,
  sessionCookie,
  type StoredAuthSession,
} from "./config.js";
import {
  installationMissKey,
  installationRegistryKey,
  isPublicInstallationRepository,
  writeInstallationRegistry,
} from "./installation-registry.js";

export async function meResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const record = await currentSessionRecord(request, env);
  const session = record?.session ?? null;
  // A valid session must never look logged out because GitHub or ancillary KV
  // cache writes hiccuped; fall back to the stored installation list instead.
  let installations = session?.installations ?? [];
  if (record && session) {
    try {
      const accessToken = await sessionAccessToken(env, record);
      const liveInstallations = await githubInstallations(accessToken).catch(() => null);
      const acknowledged = fallbackInstallations(session, liveInstallations);
      installations = await resolvedInstallations(env, session, liveInstallations, acknowledged);
      const changed = JSON.stringify(session.installations ?? []) !== JSON.stringify(installations);
      if (changed && (liveInstallations !== null || installations.length > 0)) {
        await bestEffortWriteSessionRecord(env, record.id, {
          ...session,
          installations,
          installationsUpdatedAt:
            liveInstallations && liveInstallations.length > 0 && acknowledged.length > 0
              ? session.installationsUpdatedAt
              : new Date().toISOString(),
        });
      }
    } catch (error) {
      installations = session.installations ?? [];
      console.log(
        JSON.stringify({
          event: "auth_me_degraded",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
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

export function currentReturnTo(url: URL): string {
  const value = url.searchParams.get("returnTo");
  return safeReturnTo(value, url.origin) || "/";
}

export async function loginResponse(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET || !env.GITHUB_APP_CLIENT_ID) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  const requestedReturnTo = safeReturnTo(url.searchParams.get("returnTo"), url.origin);
  // Keep the GitHub authorize request below common request-line limits.
  const returnTo = requestedReturnTo.length <= oauthReturnToMaxLength ? requestedReturnTo : "/";
  const nonce = randomNonce();
  const state = await signedJson(env.AUTH_COOKIE_SECRET, {
    returnTo,
    iat: Math.floor(Date.now() / 1000),
    nonce,
  });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
  github.searchParams.set("state", state);
  return redirectResponse(github.toString(), {
    "set-cookie": oauthStateCookieValue(
      nonce,
      await oauthStateBinding(env.AUTH_COOKIE_SECRET, nonce),
    ),
  });
}

export type OAuthUserGrant = {
  accessToken: string;
  accessTokenExp?: number;
  refreshToken?: string;
  refreshTokenExp?: number;
};

function oauthUserGrant(
  token: v.InferOutput<typeof gitHubOAuthTokenSchema>,
): OAuthUserGrant | null {
  if (!token.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: token.access_token,
    ...(token.expires_in ? { accessTokenExp: now + token.expires_in } : {}),
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.refresh_token && token.refresh_token_expires_in
      ? { refreshTokenExp: now + token.refresh_token_expires_in }
      : {}),
  };
}

export async function exchangeCode(url: URL, env: Env): Promise<OAuthUserGrant> {
  const code = url.searchParams.get("code");
  if (!code) throw new Error("missing OAuth code");
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
  const grant = oauthUserGrant(token);
  if (!response.ok || !grant) {
    throw new Error(token.error_description || token.error || "GitHub OAuth exchange failed");
  }
  return grant;
}

export async function refreshedUserGrant(
  env: Env,
  refreshToken: string,
): Promise<OAuthUserGrant | null> {
  const response = await workerFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) return null;
  const token = parseGitHubResponse(
    gitHubOAuthTokenSchema,
    await response.json(),
    "oauth refresh token",
  );
  return oauthUserGrant(token);
}

export async function githubUser(accessToken: string): Promise<AuthUser> {
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

export async function githubJson<TSchema extends GenericSchema>(
  accessToken: string,
  pathname: string,
  schema: TSchema,
  context: string,
  signal?: AbortSignal,
): Promise<InferOutput<TSchema>> {
  const response = await workerFetch(`https://api.github.com${pathname}`, {
    signal,
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

export async function githubInstallations(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  const result = await githubJson(
    accessToken,
    "/user/installations?per_page=100",
    gitHubInstallationListSchema,
    "installation list",
    signal,
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
            ? await githubInstallationRepositories(accessToken, installation.id, signal)
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

export async function githubAppInstallations(
  env: Env,
  accountFilter: string | null = null,
  strict = false,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  if (!appTokenConfigured(env)) {
    if (strict) throw new Error("GitHub App credentials are not configured");
    return [];
  }
  const jwt = await githubAppJwt(env);
  const normalizedAccountFilter = accountFilter ? slugOwner(accountFilter) : null;
  const installations: AuthInstallation[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      if (strict) throw new Error(`GitHub App installation list failed: ${response.status}`);
      break;
    }
    const result = parseGitHubResponse(
      v.array(gitHubInstallationSchema),
      await response.json(),
      "app installation list",
    );
    const batch = result;
    for (const installation of batch) {
      const account = installation.account;
      const accountLogin = account ? slugOwner(account.login) : "";
      if (!account || !validOwnerSlug(accountLogin)) continue;
      if (normalizedAccountFilter && accountLogin !== normalizedAccountFilter) continue;
      const repositories =
        installation.repository_selection === "selected"
          ? await githubAppInstallationRepositories(env, installation.id, strict, signal)
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
    if (strict && page === 10) {
      throw new Error("GitHub App installation list exceeded sync page limit");
    }
  }
  return installations;
}

export async function githubAppInstallationsForSession(
  env: Env,
  session: StoredAuthSession,
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  return githubAppInstallations(env, session.user.login, false, signal);
}

export async function syncGithubAppInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  const installations = await githubAppInstallations(env, null, true);
  const freshAccounts = new Set(installations.map((installation) => installation.accountLogin));
  const existing = await listStoredInstallations(env);
  await Promise.all(
    existing
      .filter((installation) => !freshAccounts.has(installation.accountLogin))
      .map(async (installation) => {
        await env.DASHBOARD_CACHE?.delete?.(installationRegistryKey(installation.accountLogin));
        await recordAuthFunnelEvent(env, {
          event: "install_removed",
          account: installation.accountLogin,
          installationId: installation.id,
          repositorySelection: installation.repositorySelection,
          status: "sync_absent",
          detail: null,
        });
      }),
  );
  await writeInstallationRegistry(env, installations);
  await recordAuthFunnelEvent(env, {
    event: "install_sync",
    account: null,
    installationId: null,
    repositorySelection: null,
    status: "ok",
    detail: `installations=${installations.length}`,
  });
  return listStoredInstallations(env);
}

export async function githubInstallationRepositories(
  accessToken: string,
  installationId: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubJson(
      accessToken,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      gitHubInstallationRepositoryListSchema,
      "installation repositories",
      signal,
    );
    const batch = result.repositories ?? [];
    repositories.push(
      ...batch.filter(isPublicInstallationRepository).map((repo) => repo.full_name.toLowerCase()),
    );
    if (batch.length < 100) break;
  }
  return repositories;
}

export function mergeInstallations(
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

export function fallbackInstallations(
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

export async function resolvedInstallations(
  env: Env,
  session: StoredAuthSession,
  liveInstallations: AuthInstallation[] | null,
  acknowledgedInstallations = fallbackInstallations(session, liveInstallations),
  signal?: AbortSignal,
): Promise<AuthInstallation[]> {
  const appInstallations =
    liveInstallations &&
    liveInstallations.some(
      (installation) => installation.accountLogin === session.user.login.toLowerCase(),
    )
      ? []
      : ((await nullOnNonAbortError(githubAppInstallationsForSession(env, session, signal))) ?? []);
  const installations = mergeInstallations(liveInstallations ?? [], [
    ...acknowledgedInstallations,
    ...appInstallations,
  ]);
  await writeInstallationRegistry(env, installations);
  return installations;
}

export function inferredInstallation(
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

export async function githubAppInstallation(
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

export async function githubAppInstallationForAccount(
  env: Env,
  accountLogin: string,
  signal?: AbortSignal,
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
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub App installation discovery failed: ${response.status}`);
    }
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
          ? await githubAppInstallationRepositories(env, installation.id, false, signal)
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
  await Promise.all([
    env.DASHBOARD_CACHE.delete?.(installationRegistryKey(account)),
    env.DASHBOARD_CACHE.put(installationMissKey(account), new Date().toISOString(), {
      expirationTtl: 10 * 60,
    }),
  ]);
  return null;
}

export async function githubAppInstallationRepositories(
  env: Env,
  installationId: number,
  strict = false,
  signal?: AbortSignal,
): Promise<string[]> {
  const token = await cachedInstallationToken(env, installationId, signal);
  if (!token) {
    if (strict) throw new Error(`GitHub App installation token unavailable: ${installationId}`);
    return [];
  }
  const repositories: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await workerFetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "ReleaseBar",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      if (strict) {
        throw new Error(`GitHub App installation repositories failed: ${response.status}`);
      }
      break;
    }
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
    if (strict && page === 10) {
      throw new Error("GitHub App installation repositories exceeded sync page limit");
    }
  }
  return repositories;
}

export async function writeSessionRecord(
  env: Env,
  id: string | null,
  session: StoredAuthSession,
): Promise<void> {
  if (!id || !env.DASHBOARD_CACHE) return;
  // KV rejects expirationTtl below 60s; a session that close to expiry is not worth rewriting.
  const ttl = session.exp - Math.floor(Date.now() / 1000);
  if (ttl < 60) return;
  await env.DASHBOARD_CACHE.put(`auth:session:${id}`, JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

// KV allows only one write per key per second; concurrent /api/me calls (e.g. a browser
// restart reopening several tabs) must not turn a failed rewrite into a logged-out response.
export async function bestEffortWriteSessionRecord(
  env: Env,
  id: string | null,
  session: StoredAuthSession,
): Promise<void> {
  try {
    await writeSessionRecord(env, id, session);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "auth_session_write_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function readStoredSession(env: Env, id: string): Promise<StoredAuthSession | null> {
  const stored = await env.DASHBOARD_CACHE?.get(`auth:session:${id}`);
  if (!stored) return null;
  return safeJsonParse(storedAuthSessionSchema, stored, "auth session");
}

// Refresh tokens are single-use: once GitHub rotates a grant, losing the KV write would
// strand the stored session on a spent refresh token. Retry past the 1-write/sec/key limit.
async function persistRotatedSession(
  env: Env,
  id: string | null,
  session: StoredAuthSession,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeSessionRecord(env, id, session);
      return;
    } catch (error) {
      if (attempt === 2) {
        console.log(
          JSON.stringify({
            event: "auth_session_rotation_write_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1100 * (attempt + 1)));
    }
  }
}

export async function sessionAccessToken(
  env: Env,
  record: { id: string | null; session: StoredAuthSession },
): Promise<string> {
  const session = record.session;
  const now = Math.floor(Date.now() / 1000);
  if (!session.accessTokenExp || session.accessTokenExp - now > accessTokenRefreshLeewaySeconds) {
    return session.accessToken;
  }
  if (
    !session.refreshToken ||
    (session.refreshTokenExp !== undefined && session.refreshTokenExp <= now)
  ) {
    return session.accessToken;
  }
  const grant = await refreshedUserGrant(env, session.refreshToken).catch(() => null);
  if (!grant) {
    // Refresh tokens are single-use: a parallel request may have rotated first. Pick up its result.
    const latest = record.id ? await readStoredSession(env, record.id) : null;
    if (latest && latest.accessToken !== session.accessToken) {
      Object.assign(session, latest);
    }
    return session.accessToken;
  }
  session.accessToken = grant.accessToken;
  session.accessTokenExp = grant.accessTokenExp;
  if (grant.refreshToken) session.refreshToken = grant.refreshToken;
  if (grant.refreshTokenExp) session.refreshTokenExp = grant.refreshTokenExp;
  await persistRotatedSession(env, record.id, session);
  return session.accessToken;
}

export async function acknowledgedInstallations(
  request: Request,
  env: Env,
  returnTo: string,
  installationId: number | null,
): Promise<AuthInstallation[]> {
  const record = await currentSessionRecord(request, env);
  const acknowledged: AuthInstallation[] = [];
  const appInstallation = installationId
    ? await githubAppInstallation(env, installationId).catch(() => null)
    : null;
  if (!record) {
    if (appInstallation) {
      await writeInstallationRegistry(env, [appInstallation]);
      return [appInstallation];
    }
    return [];
  }
  const accessToken = await sessionAccessToken(env, record);
  const liveInstallations = await githubInstallations(accessToken).catch(() => []);
  if (
    installationId &&
    !liveInstallations.some((installation) => installation.id === installationId)
  ) {
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
  await bestEffortWriteSessionRecord(env, record.id, {
    ...record.session,
    installations,
    installationsUpdatedAt: new Date().toISOString(),
  });
  return installations;
}

export function appTokenConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

export async function dashboardReleaseDataAllowed(
  request: Request,
  env: Env,
  sources: TokenSources,
  token: RequestToken | null | undefined,
  options: { sourceAppCovered?: boolean } = {},
): Promise<boolean> {
  if (!appTokenConfigured(env) || token?.quotaSource === "app" || options.sourceAppCovered) {
    return true;
  }
  if (sourceAccounts(sources).length <= 1) return false;
  return Boolean(await currentSession(request, env));
}

export function authDependentDashboardHeaders(env: Env): Record<string, string> {
  return appTokenConfigured(env) ? { "cache-control": "private, no-store", vary: "cookie" } : {};
}

export function authDependentAppShellHeaders(request: Request, env: Env): Record<string, string> {
  return appTokenConfigured(env) && parseCookies(request).has(sessionCookie)
    ? { "cache-control": "private, no-store", vary: "cookie" }
    : { "cache-control": "public, max-age=300" };
}

export function isAdminLogin(login: string): boolean {
  return login.toLowerCase() === "steipete";
}
