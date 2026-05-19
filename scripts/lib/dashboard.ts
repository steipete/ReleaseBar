import type {
  ApiQuota,
  CiState,
  DashboardPayload,
  Freshness,
  Owner,
  Project,
  ReleaseBarConfig,
} from "../../src/types.js";

export type DashboardBuildOptions = {
  title: string;
  subtitle: string;
  canonicalDomain: string;
  owners: Owner[];
  includeForks: boolean;
  includeArchived: boolean;
  includeUnreleased?: boolean;
  includeReleaseData?: boolean;
  excludeRepos?: string[];
  includeRepos?: string[];
  initialProjects?: Project[];
  skipRepos?: string[];
  repoLimit?: number;
  repoScanLimit?: number;
  repoScanTarget?: number;
  token?: string;
  quotaSource?: ApiQuota["source"];
  quotaAccount?: string | null;
  fetch?: typeof fetch;
  projectCache?: ProjectCache;
  onProgress?: (
    payload: DashboardPayload,
    progress: { scannedRepo: string; scanned: number; done: boolean },
  ) => Promise<void> | void;
  log?: (message: string) => void;
};

type ProjectCache = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type GitHubOwner = {
  login: string;
  type?: "User" | "Organization";
  avatar_url?: string;
  html_url?: string;
};

type GitHubRepo = {
  owner: GitHubOwner;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  archived: boolean;
  pushed_at: string | null;
  updated_at: string | null;
  fork: boolean;
  private: boolean;
  latest_release?: GitHubRelease | null;
  open_issues_total?: number;
  open_pull_requests_total?: number;
};

type GitHubRelease = {
  tag_name: string;
  name: string | null;
  html_url: string;
  draft?: boolean;
  published_at: string | null;
};

type GitHubCommit = {
  sha: string;
  commit?: {
    committer?: {
      date?: string;
    };
  };
};

type GitHubCompare = {
  total_commits?: number;
  html_url?: string;
};

type GitHubCheckRun = {
  name: string | null;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  completed_at: string | null;
  started_at: string | null;
};

type GitHubCheckRuns = {
  check_runs?: GitHubCheckRun[];
};

type CiDetails = {
  state: CiState;
  status: string | null;
  conclusion: string | null;
  workflow: string | null;
  url: string | null;
  runDate: string | null;
};

type GitHubClient = {
  fetch: typeof fetch;
  headers: Record<string, string>;
  graphqlCursors: Map<string, Array<string | null | undefined>>;
  quota: ApiQuota;
};

type GraphQLRepoNode = {
  owner: {
    login: string;
    __typename?: string;
  };
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  defaultBranchRef: null | {
    name: string;
  };
  primaryLanguage: null | {
    name: string;
  };
  repositoryTopics?: {
    nodes: Array<{
      topic?: {
        name?: string | null;
      } | null;
    } | null>;
  };
  stargazerCount: number;
  forkCount: number;
  issues: {
    totalCount: number;
  };
  pullRequests: {
    totalCount: number;
  };
  isArchived: boolean;
  isFork: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  releases?: {
    nodes: Array<{
      tagName: string;
      name: string | null;
      url: string;
      isDraft?: boolean;
      publishedAt: string | null;
    } | null>;
  } | null;
};

type GraphQLRepoPage = {
  data?: {
    repositoryOwner?: null | {
      __typename?: string;
      repositories: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<GraphQLRepoNode | null>;
      };
    };
  };
  errors?: Array<{ message?: string; type?: string }>;
};

type ProjectCacheEntry = {
  signature: string;
  project: Omit<Project, "freshness">;
};

const repoFragmentTtlSeconds = 30 * 60;

export class GitHubRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function rateLimitFromResponse(response: Response, pathname: string): GitHubRateLimitError | null {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const isRateLimited =
    response.status === 429 ||
    (response.status === 403 && remaining === "0") ||
    retryAfter !== null;
  if (!isRateLimited) return null;
  const reset = response.headers.get("x-ratelimit-reset");
  const retryAfterSeconds = retryAfter
    ? Number(retryAfter)
    : reset
      ? Math.max(0, Number(reset) - Math.floor(Date.now() / 1000))
      : null;
  return new GitHubRateLimitError(
    `GitHub rate limit hit for ${pathname}`,
    Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
  );
}

function numberHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetAtHeader(headers: Headers): string | null {
  const reset = numberHeader(headers, "x-ratelimit-reset");
  return reset === null ? null : new Date(reset * 1000).toISOString();
}

function recordRateLimit(client: GitHubClient, response: Response): void {
  const limit = numberHeader(response.headers, "x-ratelimit-limit");
  const remaining = numberHeader(response.headers, "x-ratelimit-remaining");
  const resetAt = resetAtHeader(response.headers);
  const resource = response.headers.get("x-ratelimit-resource");
  if (limit === null && remaining === null && resetAt === null && resource === null) {
    return;
  }

  const replaceBucket =
    remaining !== null && (client.quota.remaining === null || remaining <= client.quota.remaining);
  client.quota = {
    ...client.quota,
    limit: replaceBucket ? (limit ?? client.quota.limit) : (client.quota.limit ?? limit),
    remaining: replaceBucket ? remaining : client.quota.remaining,
    resetAt: replaceBucket ? (resetAt ?? client.quota.resetAt) : (client.quota.resetAt ?? resetAt),
    resource: replaceBucket
      ? (resource ?? client.quota.resource)
      : (client.quota.resource ?? resource),
  };
}

export function normalizeBuildOptions(
  config: ReleaseBarConfig,
  overrides: Partial<DashboardBuildOptions> = {},
): DashboardBuildOptions {
  return {
    ...config,
    includeUnreleased: config.includeUnreleased ?? false,
    ...overrides,
    owners: overrides.owners ?? config.owners,
    excludeRepos: overrides.excludeRepos ?? config.excludeRepos,
  };
}

export function slugOwner(login: string): string {
  return login.trim().replace(/^@/, "").toLowerCase();
}

export function validOwnerSlug(login: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login);
}

export function validRepoSlug(repo: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d._-]{1,100}$/i.test(repo);
}

function cacheHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

export function dashboardCacheKey(options: {
  owner: string;
  owners?: string[];
  repos?: string[];
  salt?: string;
  includeForks?: boolean;
  includeArchived?: boolean;
  includeUnreleased?: boolean;
  includeReleaseData?: boolean;
  schemaVersion?: number;
}): string {
  const schemaVersion = options.schemaVersion ?? 1;
  const flags = [
    options.includeForks ? "forks" : "noforks",
    options.includeArchived ? "archived" : "noarchived",
    options.includeUnreleased ? "unreleased" : "released",
    options.includeReleaseData === false ? "metadata" : "release",
  ].join("-");
  const owners = (options.owners ?? []).map(slugOwner).sort().join(",");
  const repos = (options.repos ?? [])
    .map((repo) => repo.toLowerCase())
    .sort()
    .join(",");
  const sourceText = options.salt
    ? `${owners}\n${repos}\n${options.salt}`
    : owners || repos
      ? `${owners}\n${repos}`
      : "";
  const sources = sourceText ? `:sources-${cacheHash(sourceText)}` : "";
  return `dashboard:v${schemaVersion}:${slugOwner(options.owner)}:${flags}${sources}`;
}

export function filterRepo(
  repo: Pick<GitHubRepo, "archived" | "fork" | "full_name" | "private">,
  options: Pick<DashboardBuildOptions, "excludeRepos" | "includeArchived" | "includeForks">,
): boolean {
  if (!options.includeForks && repo.fork) {
    return false;
  }
  if (!options.includeArchived && repo.archived) {
    return false;
  }
  if (
    (options.excludeRepos || [])
      .map((value) => value.toLowerCase())
      .includes(repo.full_name.toLowerCase())
  ) {
    return false;
  }
  return !repo.private;
}

export function freshness(project: Pick<Project, "commitsSinceRelease">): Freshness {
  if (project.commitsSinceRelease === 0) {
    return "fresh";
  }
  if (project.commitsSinceRelease !== null && project.commitsSinceRelease <= 5) {
    return "warm";
  }
  if (project.commitsSinceRelease !== null && project.commitsSinceRelease <= 25) {
    return "busy";
  }
  return "hot";
}

function repoSearchProject(repo: GitHubRepo): Project {
  const openPullRequests = repo.open_pull_requests_total ?? 0;
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
    openIssues: repo.open_issues_total ?? Math.max(repo.open_issues_count - openPullRequests, 0),
    openPullRequests,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `${repo.html_url}/releases`,
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

function isRepoSearchProject(project: Project): boolean {
  return (
    project.version === "repo search" &&
    project.releaseDate === null &&
    project.commitsSinceRelease === null &&
    project.compareUrl === null
  );
}

function githubClient(
  token = "",
  fetcher: typeof fetch = fetch,
  quotaSource: ApiQuota["source"] = token ? "shared" : "anonymous",
  quotaAccount: string | null = null,
): GitHubClient {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ReleaseBar",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return {
    fetch: fetcher,
    headers,
    graphqlCursors: new Map(),
    quota: {
      source: quotaSource,
      account: quotaAccount,
      remaining: null,
      limit: null,
      resetAt: null,
      resource: null,
    },
  };
}

async function github<T>(
  client: GitHubClient,
  pathname: string,
  ignoreStatuses: number[] = [404],
): Promise<T | null> {
  const response = await client.fetch(`https://api.github.com${pathname}`, {
    headers: client.headers,
  });
  recordRateLimit(client, response);
  const rateLimit = rateLimitFromResponse(response, pathname);
  if (rateLimit) throw rateLimit;
  if (ignoreStatuses.includes(response.status)) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

async function githubPage<T>(client: GitHubClient, pathname: string, page: number): Promise<T[]> {
  const joiner = pathname.includes("?") ? "&" : "?";
  return (await github<T[]>(client, `${pathname}${joiner}per_page=100&page=${page}`)) ?? [];
}

async function githubPages<T>(client: GitHubClient, pathname: string): Promise<T[]> {
  let page = 1;
  const items: T[] = [];
  while (true) {
    const result = await githubPage<T>(client, pathname, page);
    if (result.length === 0) {
      break;
    }
    items.push(...result);
    if (result.length < 100) {
      break;
    }
    page += 1;
  }
  return items;
}

async function githubGraphql<T>(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  if (!client.headers.Authorization) {
    return null;
  }
  const response = await client.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...client.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  recordRateLimit(client, response);
  const rateLimit = rateLimitFromResponse(response, "/graphql");
  if (rateLimit) throw rateLimit;
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as GraphQLRepoPage;
  if (body.errors?.length) {
    const message = body.errors.map((error) => error.message ?? error.type).join("; ");
    if (/rate limit|secondary rate|api rate limit/i.test(message)) {
      throw new GitHubRateLimitError(`GitHub rate limit hit for /graphql`, null);
    }
    return null;
  }
  return body as T;
}

const ownerReposQuery = /* GraphQL */ `
  query ReleaseBarOwnerRepos(
    $login: String!
    $first: Int!
    $after: String
    $includeReleases: Boolean!
  ) {
    repositoryOwner(login: $login) {
      __typename
      repositories(
        first: $first
        after: $after
        orderBy: { field: PUSHED_AT, direction: DESC }
        ownerAffiliations: OWNER
        privacy: PUBLIC
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          owner {
            login
            __typename
          }
          name
          nameWithOwner
          description
          url
          defaultBranchRef {
            name
          }
          primaryLanguage {
            name
          }
          repositoryTopics(first: 6) {
            nodes {
              topic {
                name
              }
            }
          }
          stargazerCount
          forkCount
          issues(states: OPEN) {
            totalCount
          }
          pullRequests(states: OPEN) {
            totalCount
          }
          isArchived
          isFork
          isPrivate
          pushedAt
          updatedAt
          releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC })
            @include(if: $includeReleases) {
            nodes {
              tagName
              name
              url
              isDraft
              publishedAt
            }
          }
        }
      }
    }
  }
`;

function graphQlRepo(node: GraphQLRepoNode): GitHubRepo {
  const latestRelease = node.releases?.nodes.find(
    (release) => release?.tagName && !release.isDraft && release.publishedAt,
  );
  return {
    owner: {
      login: node.owner.login,
      type: node.owner.__typename === "Organization" ? "Organization" : "User",
    },
    name: node.name,
    full_name: node.nameWithOwner,
    description: node.description,
    html_url: node.url,
    default_branch: node.defaultBranchRef?.name ?? "main",
    language: node.primaryLanguage?.name ?? null,
    topics:
      node.repositoryTopics?.nodes
        .map((topicNode) => topicNode?.topic?.name)
        .filter((name): name is string => Boolean(name)) ?? [],
    stargazers_count: node.stargazerCount,
    forks_count: node.forkCount,
    open_issues_count: node.issues.totalCount + node.pullRequests.totalCount,
    archived: node.isArchived,
    pushed_at: node.pushedAt,
    updated_at: node.updatedAt,
    fork: node.isFork,
    private: node.isPrivate,
    latest_release: latestRelease
      ? {
          tag_name: latestRelease.tagName,
          name: latestRelease.name,
          html_url: latestRelease.url,
          draft: latestRelease.isDraft,
          published_at: latestRelease.publishedAt,
        }
      : null,
    open_issues_total: node.issues.totalCount,
    open_pull_requests_total: node.pullRequests.totalCount,
  };
}

async function ownerReposGraphqlPage(
  client: GitHubClient,
  owner: Owner,
  page: number,
  includeReleaseData: boolean,
): Promise<GitHubRepo[] | null> {
  const cursorKey = `${owner.type}:${slugOwner(owner.login)}`;
  const cursors = client.graphqlCursors.get(cursorKey) ?? [null];
  const after = cursors[page - 1];
  if (after === undefined) {
    return null;
  }
  const body = await githubGraphql<GraphQLRepoPage>(client, ownerReposQuery, {
    login: owner.login,
    first: 100,
    after,
    includeReleases: includeReleaseData,
  });
  const repositoryOwner = body?.data?.repositoryOwner;
  if (!repositoryOwner) {
    return null;
  }
  const repos = repositoryOwner.repositories.nodes
    .filter((node): node is GraphQLRepoNode => Boolean(node))
    .map(graphQlRepo);
  cursors[page] = repositoryOwner.repositories.pageInfo.hasNextPage
    ? repositoryOwner.repositories.pageInfo.endCursor
    : undefined;
  client.graphqlCursors.set(cursorKey, cursors);
  return repos;
}

async function githubCount(client: GitHubClient, pathname: string): Promise<number> {
  const joiner = pathname.includes("?") ? "&" : "?";
  const response = await client.fetch(`https://api.github.com${pathname}${joiner}per_page=1`, {
    headers: client.headers,
  });
  recordRateLimit(client, response);
  if (response.status === 404) {
    return 0;
  }
  if (!response.ok) {
    const rateLimit = rateLimitFromResponse(response, pathname);
    if (rateLimit) throw rateLimit;
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${pathname}: ${body.slice(0, 500)}`);
  }

  const link = response.headers.get("link");
  const lastPage = link?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
  if (lastPage) {
    return Number(lastPage);
  }

  const items = (await response.json()) as unknown[];
  return items.length;
}

async function ownerRepos(
  client: GitHubClient,
  owner: Owner,
  includeReleaseData: boolean,
  page?: number,
): Promise<GitHubRepo[]> {
  if (page) {
    const graphqlRepos = await ownerReposGraphqlPage(client, owner, page, includeReleaseData);
    if (graphqlRepos) {
      return graphqlRepos;
    }
  }
  const base = owner.type === "org" ? `/orgs/${owner.login}/repos` : `/users/${owner.login}/repos`;
  const path = `${base}?type=public&sort=pushed&direction=desc`;
  return page ? githubPage<GitHubRepo>(client, path, page) : githubPages<GitHubRepo>(client, path);
}

async function repoByFullName(client: GitHubClient, fullName: string): Promise<GitHubRepo | null> {
  return github<GitHubRepo>(client, `/repos/${fullName}`, [404]);
}

async function latestRelease(
  client: GitHubClient,
  repo: GitHubRepo,
): Promise<GitHubRelease | null> {
  if (repo.latest_release !== undefined) {
    const release = repo.latest_release;
    return release?.tag_name && !release.draft && release.published_at ? release : null;
  }
  const releases = await github<GitHubRelease[]>(
    client,
    `/repos/${repo.full_name}/releases?per_page=10`,
  );
  return (
    releases?.find((release) => release.tag_name && !release.draft && release.published_at) ?? null
  );
}

async function checkRuns(
  client: GitHubClient,
  repo: GitHubRepo,
  ref: string,
): Promise<GitHubCheckRun[]> {
  const runs = await github<GitHubCheckRuns>(
    client,
    `/repos/${repo.full_name}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    [404, 403, 409],
  );
  return runs?.check_runs ?? [];
}

function ciDetails(runs: GitHubCheckRun[]): CiDetails {
  if (runs.length === 0) {
    return {
      state: "unknown",
      status: null,
      conclusion: null,
      workflow: null,
      url: null,
      runDate: null,
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

  let state: CiState = "unknown";
  if (failure) {
    state = "failure";
  } else if (active) {
    state = active.status === "in_progress" ? "running" : "pending";
  } else if (cancelled) {
    state = "cancelled";
  } else if (successCount > 0) {
    state = "success";
  } else if (neutralCount > 0) {
    state = "neutral";
  } else if (skippedCount > 0) {
    state = "skipped";
  }

  return {
    state,
    status: selected.status,
    conclusion: selected.conclusion,
    workflow: state === "success" ? `${successCount}/${runs.length} checks` : selected.name,
    url: selected.html_url,
    runDate: selected.completed_at ?? selected.started_at,
  };
}

async function repoSummary(
  client: GitHubClient,
  repo: GitHubRepo,
  includeUnreleased: boolean,
): Promise<Omit<Project, "freshness"> | null> {
  const release = await latestRelease(client, repo);
  if (!release?.tag_name) {
    if (!includeUnreleased) {
      return null;
    }
  }

  let commitsSinceRelease: number | null = null;
  let compareUrl: string | null = null;
  const latestCommit = await github<GitHubCommit>(
    client,
    `/repos/${repo.full_name}/commits/${repo.default_branch}`,
    [404, 409],
  );
  const latestRef = latestCommit?.sha ?? repo.default_branch;
  const [compare, openPullRequests, checks] = await Promise.all([
    release?.tag_name
      ? github<GitHubCompare>(
          client,
          `/repos/${repo.full_name}/compare/${encodeURIComponent(release.tag_name)}...${encodeURIComponent(repo.default_branch)}`,
        )
      : Promise.resolve(null),
    repo.open_pull_requests_total ??
      githubCount(client, `/repos/${repo.full_name}/pulls?state=open`),
    checkRuns(client, repo, latestRef),
  ]);
  commitsSinceRelease = compare?.total_commits ?? null;
  compareUrl = compare?.html_url ?? null;
  const ci = ciDetails(checks);

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
    openIssues: repo.open_issues_total ?? Math.max(repo.open_issues_count - openPullRequests, 0),
    openPullRequests,
    issuesUrl: `${repo.html_url}/issues`,
    pullRequestsUrl: `${repo.html_url}/pulls`,
    archived: repo.archived,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestCommitSha: latestCommit?.sha?.slice(0, 7) ?? null,
    latestCommitDate: latestCommit?.commit?.committer?.date ?? null,
    version: release?.tag_name ?? "unreleased",
    releaseName: release?.name ?? null,
    releaseUrl: release?.html_url ?? repo.html_url,
    releaseDate: release?.published_at ?? null,
    commitsSinceRelease,
    compareUrl,
    ciState: ci.state,
    ciStatus: ci.status,
    ciConclusion: ci.conclusion,
    ciWorkflow: ci.workflow,
    ciUrl: ci.url,
    ciRunDate: ci.runDate,
  };
}

function projectCacheKey(
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
): string {
  return `repo:v1:${repo.full_name.toLowerCase()}:${includeUnreleased ? "unreleased" : "released"}:${includeReleaseData ? "release" : "metadata"}`;
}

function projectCacheSignature(repo: GitHubRepo): string {
  return [
    repo.default_branch,
    repo.pushed_at ?? "",
    repo.updated_at ?? "",
    (repo.topics ?? []).join(","),
    repo.latest_release?.tag_name ?? "",
    repo.latest_release?.published_at ?? "",
  ].join("|");
}

async function readProjectCache(
  cache: ProjectCache | undefined,
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
): Promise<Omit<Project, "freshness"> | null> {
  const raw = await cache?.get(projectCacheKey(repo, includeUnreleased, includeReleaseData));
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as ProjectCacheEntry;
    return cached.signature === projectCacheSignature(repo) ? cached.project : null;
  } catch {
    return null;
  }
}

async function writeProjectCache(
  cache: ProjectCache | undefined,
  repo: GitHubRepo,
  includeUnreleased: boolean,
  includeReleaseData: boolean,
  project: Omit<Project, "freshness">,
): Promise<void> {
  await cache?.put(
    projectCacheKey(repo, includeUnreleased, includeReleaseData),
    JSON.stringify({
      signature: projectCacheSignature(repo),
      project,
    } satisfies ProjectCacheEntry),
    { expirationTtl: repoFragmentTtlSeconds },
  );
}

export async function resolveOwnerType(
  login: string,
  options: Pick<DashboardBuildOptions, "fetch" | "token"> = {},
): Promise<Owner | null> {
  const owner = slugOwner(login);
  if (!validOwnerSlug(owner)) {
    return null;
  }
  const client = githubClient(options.token, options.fetch);
  const result = await github<GitHubOwner>(client, `/users/${encodeURIComponent(owner)}`);
  if (!result?.login) {
    return null;
  }
  return {
    login: result.login,
    type: result.type === "Organization" ? "org" : "user",
    avatarUrl: result.avatar_url,
    url: result.html_url ?? `https://github.com/${result.login}`,
  };
}

export async function buildDashboard(options: DashboardBuildOptions): Promise<DashboardPayload> {
  const includeReleaseData = options.includeReleaseData ?? true;
  const client = githubClient(
    options.token,
    options.fetch,
    options.quotaSource,
    options.quotaAccount ?? null,
  );
  const projects: Project[] = [...(options.initialProjects ?? [])];
  let capped = false;
  let scanIncomplete = false;
  let scannedThisRun = 0;
  const seen = new Set<string>();
  const skippedRepos = new Set((options.skipRepos ?? []).map((repo) => repo.toLowerCase()));
  for (const project of projects) {
    seen.add(project.fullName.toLowerCase());
  }

  function payload(state: NonNullable<DashboardPayload["cache"]>["state"]): DashboardPayload {
    const sortedProjects = [...projects].sort((a, b) => {
      const aDate = a.pushedAt ? Date.parse(a.pushedAt) : 0;
      const bDate = b.pushedAt ? Date.parse(b.pushedAt) : 0;
      return bDate - aDate;
    });
    const generatedAt = new Date().toISOString();
    const released = projects.filter((project) => project.releaseDate).length;
    const scanned = skippedRepos.size + scannedThisRun;
    const progress = options.repoScanTarget
      ? {
          scanned,
          limit: options.repoScanTarget,
          done: state !== "partial" && !scanIncomplete,
        }
      : undefined;
    return {
      title: options.title,
      subtitle: options.subtitle,
      canonicalDomain: options.canonicalDomain,
      generatedAt,
      owners: options.owners,
      options: {
        includeForks: options.includeForks,
        includeArchived: options.includeArchived,
        includeUnreleased: Boolean(options.includeUnreleased),
        repoLimit: options.repoLimit ?? null,
      },
      cache: {
        state,
        stale: state !== "fresh",
        capped,
        repoLimit: options.repoLimit ?? null,
        generatedAt,
        quota: client.quota,
        ...(progress ? { progress } : {}),
        ...(!includeReleaseData
          ? {
              message: "release scan skipped until this account is synced with GitHub App quota",
            }
          : progress && !progress.done
            ? {
                message: `scanned ${progress.scanned}${progress.limit ? `/${progress.limit}` : ""} recently pushed repos; still updating`,
              }
            : capped && options.repoScanLimit
              ? {
                  message: `scanned ${options.repoScanLimit} recently pushed repos per owner`,
                }
              : {}),
      },
      totals: {
        repos: sortedProjects.length,
        released,
        unreleased: sortedProjects.length - released,
        commitsSinceRelease: sortedProjects.reduce(
          (sum, project) => sum + (project.commitsSinceRelease || 0),
          0,
        ),
      },
      projects: sortedProjects,
    };
  }

  if (!includeReleaseData && !options.includeUnreleased) {
    projects.splice(0, projects.length);
    return payload("fresh");
  }

  async function addRepo(repo: GitHubRepo, countLabel: string, force = false): Promise<boolean> {
    const existingIndex = projects.findIndex(
      (project) => project.fullName.toLowerCase() === repo.full_name.toLowerCase(),
    );
    if (existingIndex >= 0 && !isRepoSearchProject(projects[existingIndex]!)) {
      return true;
    }
    if (
      (!force && existingIndex < 0 && seen.has(repo.full_name.toLowerCase())) ||
      !filterRepo(repo, options)
    ) {
      return false;
    }
    seen.add(repo.full_name.toLowerCase());
    options.log?.(`fetch ${countLabel} ${repo.full_name}`);
    const includeUnreleased = Boolean(options.includeUnreleased);
    const cached = await readProjectCache(
      options.projectCache,
      repo,
      includeUnreleased,
      includeReleaseData,
    );
    const project =
      cached ??
      (includeReleaseData
        ? await repoSummary(client, repo, includeUnreleased)
        : includeUnreleased
          ? repoSearchProject(repo)
          : null);
    if (!project) {
      if (existingIndex >= 0) {
        projects.splice(existingIndex, 1);
      }
      options.log?.(`skip ${repo.full_name}: no releases`);
      return false;
    }
    if (!cached) {
      await writeProjectCache(
        options.projectCache,
        repo,
        includeUnreleased,
        includeReleaseData,
        project,
      );
    }
    const hydrated = { ...project, freshness: freshness(project) };
    if (existingIndex >= 0) {
      projects[existingIndex] = hydrated;
    } else {
      projects.push(hydrated);
    }
    return true;
  }

  if (options.repoLimit) {
    for (const owner of options.owners) {
      const ownerExisting = projects.filter(
        (project) => project.owner.toLowerCase() === owner.login.toLowerCase(),
      ).length;
      let ownerVisible = ownerExisting;
      let hydratedThisOwner = 0;
      let page = 1;
      const scanLimit = includeReleaseData
        ? (options.repoScanLimit ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
      while (ownerVisible < options.repoLimit || hydratedThisOwner < scanLimit) {
        const repos = await ownerRepos(client, owner, includeReleaseData, page);
        if (repos.length === 0) {
          break;
        }
        let exhaustedPage = false;
        let visibleAddedThisPage = 0;
        for (const [index, repo] of repos.entries()) {
          const fullName = repo.full_name.toLowerCase();
          if (!filterRepo(repo, options)) {
            continue;
          }
          const existingIndex = projects.findIndex(
            (project) => project.fullName.toLowerCase() === fullName,
          );
          let seededVisibleRow = false;
          if (existingIndex < 0 && options.includeUnreleased) {
            if (ownerVisible >= options.repoLimit) {
              capped = true;
              exhaustedPage = true;
              break;
            }
            projects.push(repoSearchProject(repo));
            seen.add(fullName);
            ownerVisible += 1;
            visibleAddedThisPage += 1;
            seededVisibleRow = true;
          }
          if (skippedRepos.has(fullName)) {
            continue;
          }
          if (hydratedThisOwner >= scanLimit) {
            capped = true;
            if (options.repoScanTarget) {
              scanIncomplete = true;
            }
            if (ownerVisible >= options.repoLimit) {
              exhaustedPage = true;
              break;
            }
            continue;
          }
          hydratedThisOwner += 1;
          scannedThisRun += 1;
          const added = await addRepo(repo, `${owner.login} ${ownerVisible}/${options.repoLimit}`);
          if (added && !seededVisibleRow && existingIndex < 0) {
            ownerVisible += 1;
            visibleAddedThisPage += 1;
            if (ownerVisible >= options.repoLimit) {
              if (index < repos.length - 1 || repos.length === 100) {
                capped = true;
              }
              exhaustedPage = true;
            }
          }
          const progressPayload = payload("partial");
          if (progressPayload.cache?.progress) {
            progressPayload.cache.progress.done = false;
          }
          await options.onProgress?.(progressPayload, {
            scannedRepo: repo.full_name,
            scanned: skippedRepos.size + scannedThisRun,
            done: false,
          });
          if (exhaustedPage) {
            break;
          }
        }
        if (repos.length < 100) {
          break;
        }
        if (exhaustedPage) {
          break;
        }
        if (hydratedThisOwner >= scanLimit && visibleAddedThisPage === 0) {
          break;
        }
        page += 1;
      }
    }
  } else {
    const repos: GitHubRepo[] = [];
    for (const owner of options.owners) {
      repos.push(...(await ownerRepos(client, owner, includeReleaseData)));
    }

    const uniqueRepos = [
      ...new Map(
        repos.filter((repo) => filterRepo(repo, options)).map((repo) => [repo.full_name, repo]),
      ).values(),
    ];

    for (const [index, repo] of uniqueRepos.entries()) {
      await addRepo(repo, `${index + 1}/${uniqueRepos.length}`);
    }
  }

  for (const fullName of options.includeRepos ?? []) {
    const repo = await repoByFullName(client, fullName);
    if (repo) {
      await addRepo(repo, `custom`, true);
    }
  }

  await options.onProgress?.(payload(scanIncomplete ? "partial" : "fresh"), {
    scannedRepo: "",
    scanned: skippedRepos.size + scannedThisRun,
    done: !scanIncomplete,
  });
  return payload(scanIncomplete ? "partial" : "fresh");
}
