import { slugOwner, validOwnerSlug } from "../scripts/lib/dashboard.js";
import type { AuthInstallation } from "../src/types.js";
import { recordAuthFunnelEvent } from "./auth-observability.js";
import {
  base64Url,
  base64UrlJson,
  pemToPkcs8ArrayBuffer,
  randomNonce,
  signedJson,
  timingSafeEqual,
  verifySignedJson,
} from "./crypto.js";
import { jsonResponse, redirectResponse, workerFetch } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { gitHubInstallationTokenSchema, parseGitHubResponse } from "./schemas.js";
import {
  appSlug,
  authConfigured,
  authCookie,
  cookie,
  currentSession,
  currentSessionRecord,
  installReturnCookieValue,
  oauthStateBinding,
  oauthStateCookieName,
  oauthStateCookieValue,
  ownerListFromUrl,
  parseCookies,
  repoFullNameFromPath,
  repoListFromUrl,
  safeReturnTo,
  type TokenSources,
} from "./app-shell.js";
import {
  acknowledgedInstallations,
  appTokenConfigured,
  exchangeCode,
  githubAppInstallation,
  githubAppInstallationForAccount,
  githubInstallations,
  githubUser,
  isAdminLogin,
  loginResponse,
  resolvedInstallations,
  sessionAccessToken,
} from "./auth-oauth.js";
import {
  type AuthSession,
  type AuthState,
  installationRegistryFastPathMaxAgeMs,
  installationTokenTtlSeconds,
  installReturnCookie,
  type RequestToken,
  sessionCookie,
  sessionMaxAgeSeconds,
  stateMaxAgeSeconds,
  type StoredAuthSession,
} from "./config.js";
import { isAbortError } from "./dashboard-cache.js";
import {
  installationMissKey,
  readInstallationRegistry,
  scheduleInstallationCacheWarm,
  writeInstallationRegistry,
} from "./installation-registry.js";
import { authInstallCallbackRateLimited } from "./refresh-targets.js";

export async function requireAdmin(
  request: Request,
  env: Env,
): Promise<StoredAuthSession | Response> {
  const session = await currentSession(request, env);
  if (!session) {
    return jsonResponse({ error: "login required" }, 401, { "cache-control": "no-store" });
  }
  if (!isAdminLogin(session.user.login)) {
    return jsonResponse({ error: "admin required" }, 403, { "cache-control": "no-store" });
  }
  return session;
}

export async function githubAppJwt(env: Env): Promise<string> {
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

export async function githubInstallationToken(
  env: Env,
  installationId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const jwt = await githubAppJwt(env);
  const response = await workerFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      signal,
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

export function installationCoversSources(
  installation: AuthInstallation,
  sources: TokenSources,
): boolean {
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

export function matchingInstallation(
  installations: AuthInstallation[],
  sources: TokenSources,
): AuthInstallation | null {
  return (
    installations.find((installation) => installationCoversSources(installation, sources)) ?? null
  );
}

export async function cachedInstallationToken(
  env: Env,
  installationId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const cacheKey = `auth:installation-token:${installationId}`;
  const cached = await env.DASHBOARD_CACHE?.get(cacheKey);
  if (cached) return cached;
  const token = await githubInstallationToken(env, installationId, signal);
  if (token) {
    await env.DASHBOARD_CACHE?.put(cacheKey, token, {
      expirationTtl: installationTokenTtlSeconds,
    });
  }
  return token;
}

export async function sourceInstallationToken(
  env: Env,
  sources: TokenSources,
  options: { discover?: boolean; maxRegistryAgeMs?: number; signal?: AbortSignal } = {},
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const accounts = sourceAccounts(sources);
  if (accounts.length !== 1) return null;
  const account = accounts[0]!;
  const registryInstallation = await readInstallationRegistry(env, account);
  let installation = registryInstallation;
  let registryStale = false;
  if (installation && options.maxRegistryAgeMs !== undefined) {
    const updatedAt = Date.parse(installation.updatedAt ?? "");
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > options.maxRegistryAgeMs) {
      registryStale = true;
      installation = null;
    }
  }
  if (!installation && options.discover !== false) {
    installation =
      (await nullOnNonAbortError(githubAppInstallationForAccount(env, account, options.signal))) ??
      null;
    if (
      !installation &&
      registryStale &&
      registryInstallation &&
      !(await env.DASHBOARD_CACHE?.get(installationMissKey(account)))
    ) {
      installation = registryInstallation;
    }
  }
  if (!installation || !installationCoversSources(installation, sources)) return null;
  const token = await cachedInstallationToken(env, installation.id, options.signal);
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation.accountLogin,
      }
    : null;
}

export async function sourceInstallationRegistryCovers(
  env: Env,
  sources: TokenSources,
): Promise<boolean> {
  if (!appTokenConfigured(env)) return false;
  const accounts = sourceAccounts(sources);
  if (accounts.length === 0) return false;
  const installations = await Promise.all(
    accounts.map((account) => readInstallationRegistry(env, account)),
  );
  return accounts.every((account, index) => {
    const installation = installations[index];
    return Boolean(
      installation && installationCoversSources(installation, sourcesForAccount(sources, account)),
    );
  });
}

export async function requestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
  signal?: AbortSignal,
): Promise<RequestToken | null> {
  if (!appTokenConfigured(env)) return null;
  const record = await currentSessionRecord(request, env);
  if (!record) return null;
  const accessToken = await sessionAccessToken(env, record);
  const liveInstallations =
    (await nullOnNonAbortError(githubInstallations(accessToken, signal))) ?? null;
  const installations = await resolvedInstallations(
    env,
    record.session,
    liveInstallations,
    undefined,
    signal,
  );
  const installation = matchingInstallation(installations, sources);
  const token = installation ? await cachedInstallationToken(env, installation.id, signal) : null;
  return token
    ? {
        token,
        quotaSource: "app",
        quotaAccount: installation?.accountLogin ?? null,
      }
    : null;
}

export async function bestInstallationToken(
  request: Request,
  env: Env,
  sources: TokenSources,
  options: { discoverSourceInstallations?: boolean; signal?: AbortSignal } = {},
): Promise<RequestToken | null> {
  return (
    (await nullOnNonAbortError(
      sourceInstallationToken(env, sources, {
        discover: false,
        maxRegistryAgeMs: installationRegistryFastPathMaxAgeMs,
        signal: options.signal,
      }),
    )) ??
    (await nullOnNonAbortError(requestInstallationToken(request, env, sources, options.signal))) ??
    (options.discoverSourceInstallations === false
      ? null
      : await nullOnNonAbortError(
          sourceInstallationToken(env, sources, {
            discover: true,
            maxRegistryAgeMs: installationRegistryFastPathMaxAgeMs,
            signal: options.signal,
          }),
        ))
  );
}

export async function nullOnNonAbortError<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

export function sourceAccounts(sources: TokenSources): string[] {
  return [
    ...new Set([
      ...sources.owners,
      ...sources.repos.map((repo) => repo.split("/")[0] ?? "").filter(Boolean),
    ]),
  ];
}

export function sourcesForAccount(sources: TokenSources, account: string): TokenSources {
  const login = slugOwner(account);
  return {
    owners: sources.owners.filter((owner) => slugOwner(owner) === login),
    repos: sources.repos.filter((repo) => slugOwner(repo.split("/")[0] ?? "") === login),
  };
}

export function installationsCoverSources(
  installations: AuthInstallation[],
  sources: TokenSources,
): boolean {
  const accounts = sourceAccounts(sources);
  return (
    accounts.length > 0 &&
    accounts.every((account) => {
      const accountSources = sourcesForAccount(sources, account);
      return installations.some((installation) =>
        installationCoversSources(installation, accountSources),
      );
    })
  );
}

export function returnToSources(
  returnTo: string,
  origin: string,
): { owners: string[]; repos: string[] } {
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

export function sourceCoverage(
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
  if (installationsCoverSources(installations, sources)) {
    return { needed: false, reason: null };
  }
  if (sources.owners.length === 0 && sources.repos.length === 0) {
    return installations.length === 0
      ? { needed: true, reason: "Install the GitHub App for dedicated API quota." }
      : { needed: false, reason: null };
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

export async function storedSessionCookie(env: Env, session: StoredAuthSession): Promise<string> {
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

export async function callbackResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  if (!authConfigured(env) || !env.AUTH_COOKIE_SECRET) {
    return jsonResponse({ error: "GitHub login is not configured" }, 503, {
      "cache-control": "no-store",
    });
  }
  const url = new URL(request.url);
  let validatedState = false;
  let stateCookieName: string | null = null;
  try {
    const stateToken = url.searchParams.get("state") ?? "";
    const state = await verifySignedJson<AuthState>(env.AUTH_COOKIE_SECRET, stateToken);
    const stateNow = Math.floor(Date.now() / 1000);
    if (
      !state ||
      typeof state.returnTo !== "string" ||
      typeof state.iat !== "number" ||
      typeof state.nonce !== "string" ||
      state.iat > stateNow ||
      stateNow - state.iat > stateMaxAgeSeconds
    ) {
      throw new Error("invalid OAuth state");
    }
    stateCookieName = oauthStateCookieName(state.nonce);
    const browserBinding = parseCookies(request).get(stateCookieName);
    const expectedBinding = await oauthStateBinding(env.AUTH_COOKIE_SECRET, state.nonce);
    if (!browserBinding || !timingSafeEqual(browserBinding, expectedBinding)) {
      throw new Error("invalid OAuth state");
    }
    validatedState = true;
    const grant = await exchangeCode(url, env);
    const user = await githubUser(grant.accessToken);
    const now = Math.floor(Date.now() / 1000);
    const session: StoredAuthSession = {
      user,
      accessToken: grant.accessToken,
      ...(grant.accessTokenExp !== undefined ? { accessTokenExp: grant.accessTokenExp } : {}),
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.refreshTokenExp !== undefined ? { refreshTokenExp: grant.refreshTokenExp } : {}),
      iat: now,
      exp: now + sessionMaxAgeSeconds,
    };
    const liveInstallations = await githubInstallations(grant.accessToken).catch(() => null);
    // Login must not fail because installation cache writes hit KV write limits.
    const installations = await resolvedInstallations(env, session, liveInstallations).catch(
      () => liveInstallations ?? [],
    );
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
    await recordAuthFunnelEvent(env, {
      event: "login_success",
      account: user.login,
      installationId: null,
      repositorySelection: null,
      status: installations.length > 0 ? "installed" : "no_install",
      detail: `installations=${installations.length}`,
    });
    scheduleInstallationCacheWarm(env, context, installations);
    if (coverage.needed) {
      const installReturn = await signedJson(env.AUTH_COOKIE_SECRET, {
        returnTo: state.returnTo,
        iat: Math.floor(Date.now() / 1000),
        nonce: randomNonce(),
      });
      return redirectResponse(`https://github.com/apps/${appSlug(env)}/installations/new`, {
        "set-cookie": [
          sessionCookieValue,
          installReturnCookieValue(installReturn),
          oauthStateCookieValue(state.nonce, "", 0),
        ],
      });
    }
    return redirectResponse(state.returnTo, {
      "set-cookie": [sessionCookieValue, oauthStateCookieValue(state.nonce, "", 0)],
    });
  } catch (error) {
    if (validatedState) {
      await recordAuthFunnelEvent(env, {
        event: "login_failed",
        account: null,
        installationId: null,
        repositorySelection: null,
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400, {
      "cache-control": "no-store",
      ...(stateCookieName ? { "set-cookie": cookie(stateCookieName, "", 0) } : {}),
    });
  }
}

export async function logoutResponse(request: Request, env: Env): Promise<Response> {
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

export async function installResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
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
    const validInstallationId = Number.isFinite(installationId) ? installationId : null;
    const canVerifyCallback = stateIsFresh || !(await authInstallCallbackRateLimited(request, env));
    const appInstallation =
      validInstallationId && canVerifyCallback
        ? await githubAppInstallation(env, validInstallationId).catch(() => null)
        : null;
    if (stateIsFresh || appInstallation) {
      await recordAuthFunnelEvent(env, {
        event: "install_callback",
        account: appInstallation?.accountLogin ?? null,
        installationId: validInstallationId,
        repositorySelection: appInstallation?.repositorySelection ?? null,
        status: stateIsFresh ? "fresh_state" : state ? "stale_state" : "missing_state",
        detail: returnTo,
      });
    }
    if (appInstallation) {
      await writeInstallationRegistry(env, [appInstallation]);
      scheduleInstallationCacheWarm(env, context, [appInstallation]);
      await recordAuthFunnelEvent(env, {
        event: "install_recorded",
        account: appInstallation.accountLogin,
        installationId: appInstallation.id,
        repositorySelection: appInstallation.repositorySelection,
        status: stateIsFresh ? "fresh_state" : "server_verified",
        detail:
          appInstallation.repositorySelection === "selected"
            ? `repos=${appInstallation.repositories.length}`
            : "repos=all",
      });
    }
    if (stateIsFresh) {
      await acknowledgedInstallations(request, env, returnTo, validInstallationId);
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

export async function authResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/login") return loginResponse(request, env);
  if (url.pathname === "/api/auth/callback") return callbackResponse(request, env, context);
  if (url.pathname === "/api/auth/logout") return logoutResponse(request, env);
  if (url.pathname === "/api/auth/install") {
    return installResponse(request, env, context);
  }
  return jsonResponse({ error: "not found" }, 404);
}
