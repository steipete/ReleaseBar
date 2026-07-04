import type { AudienceScoreTier } from "../scripts/lib/audience.js";
import { buildDashboard, type OwnerRepoCount } from "../scripts/lib/dashboard.js";
import type {
  ApiQuota,
  AudienceRange,
  AuthInstallation,
  AuthUser,
  DashboardProfile,
  Owner,
  Project,
  RefreshTarget,
  RepoDetailPayload,
} from "../src/types.js";

export type UserTrustSignal = {
  score: number;
  tier: AudienceScoreTier;
};

export const fullTtlMs = 60 * 60 * 1000;
export const dashboardStorageTtlSeconds = 90 * 24 * 60 * 60;
export const progressTtlSeconds = 7 * 24 * 60 * 60;
export const maxDisplayStaleMs = 30 * 24 * 60 * 60 * 1000;
export const installationTokenTtlSeconds = 50 * 60;
export const installationAcknowledgementGraceMs = 15 * 60 * 1000;
export const installationRegistryFastPathMaxAgeMs = 15 * 60 * 1000;
export const coldBuildWaitMs = 15 * 1000;
export const initialMetadataRepoLimit = 25;
export const authenticatedReleaseOwnerPageSize = 50;
export const progressiveBuildBudgetMs = 25 * 1000;
export const queuedProgressiveBuildBudgetMs = 12 * 60 * 1000;
export const progressWriteIntervalMs = 1100;
export const buildLockTtlMs = 2 * 60 * 1000;
export const buildLockRefreshMs = 30 * 1000;
export const buildLockRetrySeconds = 60;
export const refreshJobReservationTtlMs = 2 * 60 * 60 * 1000;
export const incompleteBuildRetrySeconds = 2;
export const refreshQueueDeliveryDelaySeconds = 2;
export const refreshQueueMaxRetries = 10;
// Push consumers receive one initial delivery plus max_retries redeliveries.
export const refreshQueueMaxAttempts = refreshQueueMaxRetries + 1;
export const refreshJobActiveGraceMs = 60 * 1000;
export const repoLimit = 200;
export const repoScanBatchSize = 12;
export const hotLimit = 50;
export const hotOwnerLimit = 3;
export const hotSourceLimit = 24;
export const hotReadConcurrency = 8;
export const hotIndexLimit = 100;
export const hotCacheTtlMs = 5 * 60 * 1000;
export const localBuildLocks = new Map<string, StoredBuildLock>();
export const localRepoDetailBuilds = new Map<string, Promise<RepoDetailPayload | null>>();
export const localRefreshReservationFallbackScope = {};
export const localRefreshJobReservations = new WeakMap<
  object,
  Map<string, StoredRefreshJobReservation>
>();
export const localRefreshDirtyMarkers = new WeakMap<object, Map<string, StoredRefreshDirty>>();
export const discoverLimit = 40;
export const discoverHydrateLimit = 24;
export const discoverHydrateBatchSize = 8;
export const discoverCacheTtlMs = 60 * 60 * 1000;
export const repoDetailCacheTtlMs = 24 * 60 * 60 * 1000;
export const repoDetailWarmingRefreshMs = 30 * 1000;
export const repoDetailAuxCacheVersion = 2;
export const repoDetailAuxTtlSeconds = 30 * 24 * 60 * 60;
export const repoDetailReleaseCacheTtlMs = 24 * 60 * 60 * 1000;
export const repoDetailLiveProbeCacheTtlMs = 60 * 60 * 1000;
export const repoDetailSearchCountCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
export const repoDetailStatsCacheTtlMs = 24 * 60 * 60 * 1000;
export const repoDetailStatsBackoffTtlSeconds = 10 * 60;
export const repoAudienceCacheTtlMs = 6 * 60 * 60 * 1000;
export const repoAudienceUserTtlSeconds = 7 * 24 * 60 * 60;
export const repoAudienceStargazerLimit = 30;
export const repoAudienceDeepUserLimit = 12;
export const repoAudienceRanges: AudienceRange[] = ["week", "month"];
export const repoAudienceUserRepoLimit = 8;
export const releaseSummaryPromptVersion = 1;
export const releaseSummaryCommitLimit = 500;
export const activitySummaryPromptVersion = 4;
export const activityEventPageLimit = 3;
export const activitySummaryInputLimit = 180;
export const activityRepositorySummaryLimit = 30;
export const activitySummaryRepositoryEventLimit = 4;
export const activityForkLookupBatchSize = 50;
export const ownerActivityCacheVersion = 2;
export const maxCustomSources = 8;
export const dashboardSchemaVersion = 6;
export const auxiliaryCacheSchemaVersion = 3;
export const discoverCacheSchemaVersion = 4;
export const dashboardCachePrefix = `dashboard:v${dashboardSchemaVersion}:`;
export const dashboardCachePrefixes = [dashboardCachePrefix];
export const hotCacheKey = `hot:v${auxiliaryCacheSchemaVersion}`;
export const hotInvalidatedAtKey = `${hotCacheKey}:invalidated-at`;
export const hotIndexKey = `hot:index:v${auxiliaryCacheSchemaVersion}`;
export const socialRepoCachePrefix = `social-repo:v${auxiliaryCacheSchemaVersion}:`;
export const ownerCachePrefix = `owner:v1:`;
export const ownerCacheTtlSeconds = 7 * 24 * 60 * 60;
export const githubGraphqlOwnerCountsOperation = "ReleaseBarOwnerCounts";
export const githubGraphqlRepoDetailsOperation = "ReleaseBarRepoDetails";
export const githubGraphqlRepoDetailCoreOperation = "ReleaseBarRepoDetailCore";
export const githubGraphqlRepoStargazersOperation = "ReleaseBarRepoStargazers";
export const githubGraphqlRepoWorkTrendOperation = "ReleaseBarRepoWorkTrend";
export const crawlerUserAgentPattern =
  /(ahrefsbot|applebot|baiduspider|bingbot|bot|bytespider|ccbot|claudebot|crawler|duckduckbot|facebookexternalhit|googlebot|googleother|gptbot|linkedinbot|mediapartners|perplexitybot|preview|semrushbot|slackbot|slurp|spider|telegrambot|twitterbot|yandexbot)/i;
export const refreshTargetPrefix = `refresh:target:v1:`;
export const refreshTargetIndexPrefix = `refresh:target-index:v1:`;
export const refreshTargetIndexReadyKey = `refresh:target-index:v1:ready`;
export const refreshTargetIndexVersion = 2;
export const refreshTargetIndexBackfillLimit = 50;
export const refreshProfileSnapshotPrefix = `refresh:profile-snapshot:v1:`;
export const refreshJobPrefix = `refresh:job:v1:`;
export const refreshJobIndexPrefix = `refresh:jobs:v2:`;
export const refreshJobDeliveryPrefix = `refresh:job-deliveries:v1:`;
export const legacyRefreshJobIndexKey = `refresh:jobs:index:v1`;
export const refreshAuditPrefix = `refresh:audit:v2:`;
export const refreshStateKey = `refresh:state:v1`;
export const refreshOwnerCountCursorKey = `refresh:owner-count-cursor:v1`;
export const ownerMetadataPrefix = `owner-metadata:v1:`;
export const ownerMetadataTtlSeconds = 90 * 24 * 60 * 60;
export const githubWebhookDeliveryTtlMs = 24 * 60 * 60 * 1000;
export const githubWebhookDeliveryLimit = 2000;
export const githubWebhookProcessingLeaseMs = 12 * 60 * 1000;
export const githubWebhookBodyLimitBytes = 2 * 1024 * 1024;
export const githubWebhookRequeueLimit = 48;
export const githubWebhookCoalescingWaitMs = 250;
export const githubWebhookCoalescingBatchSize = 8;
export const githubWebhookPendingLimit = 256;
export const githubWebhookPendingLimitBytes = 96 * 1024;
export const manualRefreshCooldownPrefix = `refresh:manual:v1:`;
export const manualRefreshCooldownSeconds = 10 * 60;
export const refreshTargetSourceLimit = 512;
export const durableRefreshTargetIndexLimit = refreshTargetSourceLimit;
export const durableRefreshTargetEntryLimitBytes = 8 * 1024;
export const durableRefreshTargetIndexLimitBytes = 1024 * 1024;
export const webhookTargetPageSize = 200;
export const webhookTargetBatchSize = 50;
export const webhookTargetConcurrency = 8;
export const webhookPriorityTargetLimit = 25;
export const webhookPriorityFanoutWaitMs = 2 * 60 * 1000;
export const webhookPriorityFanoutRetrySeconds = 20;
export const webhookRecentTargetMs = 24 * 60 * 60 * 1000;
export const refreshJobListLimit = 80;
export const refreshAuditListLimit = 80;
export const schedulerBatchLimit = 20;
export const schedulerTargetPageLimit = 120;
export const adminTargetListLimit = 120;
export const schedulerSharedDormantRefreshMs = 7 * 24 * 60 * 60 * 1000;
export const schedulerSharedDormantAfterMs = 24 * 60 * 60 * 1000;
export const schedulerRecentViewMs = 7 * 24 * 60 * 60 * 1000;
export const schedulerCountRefreshMs = 15 * 60 * 1000;
export const schedulerCountOwnerLimit = 20;
export const schedulerCountConcurrency = 4;
export const schedulerActiveRefreshMs = 6 * 60 * 60 * 1000;
export const schedulerDormantRefreshMs = 24 * 60 * 60 * 1000;
export const schedulerRetryBaseMs = 30 * 60 * 1000;
export const sessionCookie = "rd_session";
export const installReturnCookie = "rd_install_return";
export const oauthStateCookiePrefix = "rd_oauth_state_";
export const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
export const accessTokenRefreshLeewaySeconds = 5 * 60;
export const stateMaxAgeSeconds = 10 * 60;
export const oauthReturnToMaxLength = 1024;
export const buildPending = Symbol("build-pending");
export type DashboardRequest = {
  owners: Owner[];
  includeRepos: string[];
  profile: DashboardProfile | null;
  subtitle: string;
  key: string;
  url: URL;
  includeReleaseData: boolean;
  hydrateSort?: "issues" | "prs" | null;
  hydrateDirection?: "asc" | "desc";
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
};

export type DashboardOwnerCredentials = NonNullable<
  Parameters<typeof buildDashboard>[0]["ownerCredentials"]
>;

export type OwnerMetadataSnapshot = {
  owner: string;
  generatedAt: string;
  metadataUpdatedAt: string;
  countsUpdatedAt: string | null;
  countsAttemptedAt: string | null;
  releaseDataComplete: boolean;
  knownRepos: string[] | null;
  privateRepos: Record<string, string>;
  removedRepos: Record<string, string>;
  projectMetadataUpdatedAt: Record<string, string>;
  projectCountsUpdatedAt: Record<string, string>;
  countOverlays: Record<string, OwnerRepoCount>;
  projects: Project[];
};

export type RequestToken = {
  token: string;
  quotaSource: "app";
  quotaAccount: string | null;
};

export type ProfileInput = {
  includeOwners?: unknown;
  includeRepos?: unknown;
  hiddenOwners?: unknown;
  hiddenRepos?: unknown;
};

export type BuildLock = {
  refresh(): Promise<void>;
  release(): Promise<void>;
};

export type StoredBuildLock = {
  token: string;
  expiresAt: number;
};

export type StoredRefreshJobReservation = {
  jobId: string;
  expiresAt: number;
};

export type StoredRefreshDirty = {
  observedAt: string;
  reason: string;
};

export type StoredWebhookDelivery = {
  id: string;
  processedAt: number;
};

export type StoredWebhookProcessing = {
  jobId?: string;
  leaseId?: string;
  delivery: string;
  expiresAt: number;
};

export type OwnerMetadataMutation =
  | {
      kind: "merge";
      generatedAt: string;
      observedAt: string;
      countsUpdatedAt: string | null;
      countsComplete: boolean;
      releaseDataComplete: boolean;
      mode: "metadata" | "hydrated";
      projects: Project[];
      removedRepos: string[];
    }
  | {
      kind: "counts";
      updatedAt: string;
      counts: OwnerRepoCount[];
      complete: boolean;
    }
  | {
      kind: "visibility";
      fullName: string;
      archived: boolean;
      observedAt: string;
      repositoryUpdatedAt: string | null;
    }
  | {
      kind: "remove";
      fullName: string;
      observedAt: string;
    }
  | {
      kind: "restore";
      fullName: string;
      observedAt: string;
    };

export type RefreshTargetMutation =
  | {
      kind: "observe";
      input: Pick<
        RefreshTarget,
        "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
      >;
      observedAt: string;
      profileProvided: boolean;
      profileSnapshotKey?: string | null;
    }
  | {
      kind: "defer";
      at: string;
      nextDueAt: string;
      message: string;
    }
  | {
      kind: "success";
      at: string;
      message?: string;
    }
  | {
      kind: "failure";
      at: string;
      message: string;
      terminal: boolean;
    };

export type StoredBuildProgress = {
  scannedRepos: string[];
  projects: Project[];
  generationStartedAt?: string;
  countsUpdatedAt?: string | null;
  projectCountsUpdatedAt?: Record<string, string>;
  releasesUpdatedAt?: string | null;
  ciUpdatedAt?: string | null;
  updatedAt: string;
  durableFallback?: true;
};

export type StoredBuildProgressTombstone = {
  clearedAt: string;
};

export type StoredSocialRepo = {
  generatedAt: string;
  project: Project;
};

export type AuthState = {
  returnTo: string;
  iat: number;
  nonce: string;
};

export type AuthSession = {
  id: string;
  exp: number;
};

export type StoredAuthSession = {
  user: AuthUser;
  accessToken: string;
  accessTokenExp?: number;
  refreshToken?: string;
  refreshTokenExp?: number;
  iat: number;
  exp: number;
  installations?: AuthInstallation[];
  installationsUpdatedAt?: string;
};
