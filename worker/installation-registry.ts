import {
  dashboardCacheKey,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import type {
  AuthInstallation,
  DashboardPayload,
  DashboardProfile,
  RefreshTarget,
} from "../src/types.js";
import { type StoredInstallationRecord, storedInstallationSchema } from "./auth-observability.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { type GitHubInstallationRepository, safeJsonParse } from "./schemas.js";
import { uniqueSorted } from "./app-shell.js";
import { appTokenConfigured } from "./auth-oauth.js";
import { sourceInstallationRegistryCovers } from "./auth-tokens.js";
import {
  dashboardSchemaVersion,
  dashboardStorageTtlSeconds,
  fullTtlMs,
  maxCustomSources,
} from "./config.js";
import {
  cacheAgeMs,
  canDisplayCached,
  errorMessage,
  readCached,
  readProfile,
} from "./dashboard-cache.js";
import { safeIso } from "./owner-metadata-write.js";
import { enqueueRefreshJob, refreshTargetBackoffActive } from "./refresh-queue.js";
import { auditSyncEvent, rememberRefreshTarget } from "./refresh-targets.js";

export function isPublicInstallationRepository(repo: GitHubInstallationRepository): boolean {
  if (repo.private === true) {
    return false;
  }
  return repo.private === false || repo.visibility === "public";
}

export function installationRegistryKey(accountLogin: string): string {
  return `auth:installation:v1:${slugOwner(accountLogin)}`;
}

export function installationMissKey(accountLogin: string): string {
  return `auth:installation-miss:v1:${slugOwner(accountLogin)}`;
}

export function normalizedInstallation(installation: AuthInstallation): StoredInstallationRecord {
  return {
    ...installation,
    accountLogin: slugOwner(installation.accountLogin),
    repositories: installation.repositories.map((repo) => repo.toLowerCase()).filter(validRepoSlug),
    updatedAt: new Date().toISOString(),
  };
}

export async function installationRefreshTargetInput(
  env: Env,
  accountLogin: string,
): Promise<
  | (Pick<
      RefreshTarget,
      "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
    > & { profile: DashboardProfile | null })
  | null
> {
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  const profile = await readProfile(env, account);
  const hiddenOwners = new Set(profile?.hiddenOwners ?? []);
  const hiddenRepos = new Set(profile?.hiddenRepos ?? []);
  const extraOwners = uniqueSorted(profile?.includeOwners ?? []).filter(
    (owner) => owner !== account && !hiddenOwners.has(owner),
  );
  const repos = uniqueSorted(profile?.includeRepos ?? []).filter(
    (repo) => !hiddenOwners.has(repo.split("/")[0] ?? "") && !hiddenRepos.has(repo),
  );
  if (extraOwners.length + repos.length > maxCustomSources) return null;
  const owners = hiddenOwners.has(account) ? extraOwners : [account, ...extraOwners];
  const registryCovered = await sourceInstallationRegistryCovers(env, { owners, repos }).catch(
    () => false,
  );
  const includeReleaseData = !appTokenConfigured(env) || registryCovered;
  return {
    key: dashboardCacheKey({
      owner: account,
      owners: extraOwners,
      repos,
      salt: profile?.updatedAt,
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      includeReleaseData,
      schemaVersion: dashboardSchemaVersion,
    }),
    owner: account,
    owners,
    repos,
    profile,
    includeReleaseData,
    path: `/${account}`,
    priority: 80,
  };
}

// Skip rewrites of registry entries that already hold the same content and were
// refreshed recently, so bursts of /api/me calls (multiple tabs, browser restart)
// stay under Workers KV's one-write-per-key-per-second limit.
const installationRegistryRewriteMinAgeMs = 5 * 60 * 1000;

async function installationRegistryEntryFresh(
  env: Env,
  installation: StoredInstallationRecord,
): Promise<boolean> {
  const existing = await readInstallationRegistry(env, installation.accountLogin).catch(() => null);
  if (!existing) return false;
  const updatedAt = Date.parse(existing.updatedAt ?? "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > installationRegistryRewriteMinAgeMs) {
    return false;
  }
  const { updatedAt: _existingUpdatedAt, ...existingContent } = existing;
  const { updatedAt: _nextUpdatedAt, ...nextContent } = installation;
  return JSON.stringify(existingContent) === JSON.stringify(nextContent);
}

export async function writeInstallationRegistry(
  env: Env,
  installations: AuthInstallation[],
): Promise<void> {
  if (!env.DASHBOARD_CACHE) return;
  const normalized = installations.map(normalizedInstallation);
  const stale = (
    await Promise.all(
      normalized.map(async (installation) =>
        (await installationRegistryEntryFresh(env, installation)) ? null : installation,
      ),
    )
  ).filter((installation): installation is StoredInstallationRecord => installation !== null);
  await Promise.all(
    stale.map((installation) => {
      return env.DASHBOARD_CACHE!.put(
        installationRegistryKey(installation.accountLogin),
        JSON.stringify(installation),
        { expirationTtl: dashboardStorageTtlSeconds },
      );
    }),
  );
  await Promise.all(
    stale
      .filter((installation) => installation.repositorySelection === "all")
      .map(async (installation) => {
        const input = await installationRefreshTargetInput(env, installation.accountLogin);
        return input ? rememberRefreshTarget(env, input) : null;
      }),
  );
}

export async function warmInstallationCaches(
  env: Env,
  context: ExecutionContext,
  installations: AuthInstallation[],
): Promise<void> {
  const accounts = [
    ...new Set(
      installations
        .filter((installation) => installation.repositorySelection === "all")
        .map((installation) => slugOwner(installation.accountLogin))
        .filter(validOwnerSlug),
    ),
  ];
  await Promise.all(
    accounts.map(async (account) => {
      const input = await installationRefreshTargetInput(env, account);
      if (!input) return;
      const target = await rememberRefreshTarget(env, input);
      if (!target) return;
      const cached = await readCached(env, target.key);
      if (!installationCacheNeedsWarm(target, cached)) return;
      await enqueueRefreshJob(env, context, target, "installation-warm", 0);
    }),
  );
}

export function installationCacheNeedsWarm(
  target: RefreshTarget,
  cached: DashboardPayload | null,
  now = Date.now(),
): boolean {
  if (refreshTargetBackoffActive(target, now)) return false;
  if (target.failureCount > 0 && now < safeIso(target.nextDueAt)) return false;
  if (!cached || !canDisplayCached(cached)) return true;
  if (
    cached.cache?.state === "error" ||
    cached.cache?.state === "stale" ||
    cached.cache?.progress?.done === false
  ) {
    return true;
  }
  return cacheAgeMs(cached) >= fullTtlMs || now >= safeIso(target.nextDueAt);
}

export function scheduleInstallationCacheWarm(
  env: Env,
  context: ExecutionContext,
  installations: AuthInstallation[],
): void {
  if (!env.DASHBOARD_CACHE || installations.length === 0) return;
  context.waitUntil(
    warmInstallationCaches(env, context, installations).catch((error) =>
      auditSyncEvent(env, {
        event: "installation_warm_failed",
        status: "failed",
        reason: errorMessage(error),
      }),
    ),
  );
}

export async function readInstallationRegistry(
  env: Env,
  accountLogin: string,
): Promise<StoredInstallationRecord | null> {
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  const raw = await env.DASHBOARD_CACHE?.get(installationRegistryKey(account));
  if (!raw) return null;
  return safeJsonParse(storedInstallationSchema, raw, `app installation ${account}`);
}
