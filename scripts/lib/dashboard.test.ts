import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateAudienceScore, isLikelyBot } from "./audience.js";
import {
  buildDashboard,
  dashboardCacheKey,
  filterRepo,
  freshness,
  GitHubRateLimitError,
  normalizeBuildOptions,
  resolveOwnerType,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard.js";
import {
  dashboardRoute,
  ownerDashboardPath,
  optionsFromSearch,
  ownerFromPath,
  fallbackApiOrigin,
  repoDetailPath,
  repoFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../src/routing.js";
import {
  attentionReasons,
  matchesProjectSearch,
  needsAttention,
  parseViewState,
  showCodeChurn,
  sortProjects,
  viewStateSearch,
  type DashboardViewState,
} from "../../src/dashboard-view.js";
import type {
  DashboardPayload,
  OwnerActivityPayload,
  Project,
  AudienceRange,
  RepoAudiencePayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
  RefreshJob,
  RefreshTarget,
  SchedulerAdminPayload,
  SchedulerAuditEvent,
  TrustProfilePayload,
} from "../../src/types.js";
import worker, { DashboardBuildLock, dashboardStreamSignature } from "../../worker/index.js";

const textEncoder = new TextEncoder();

async function socialRenderAsset(request: Request, paths?: string[]): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  paths?.push(pathname);
  const assets: Record<string, string> = {
    "/resvg.wasm": "node_modules/@resvg/resvg-wasm/index_bg.wasm",
    "/jetbrains-mono-latin-400-normal.woff2":
      "node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
    "/jetbrains-mono-latin-700-normal.woff2":
      "node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2",
  };
  const file = assets[pathname];
  return file
    ? new Response(await readFile(file))
    : new Response("not found", {
        status: 404,
      });
}

function kvStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const names = [...values.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .sort();
      return {
        keys: names.map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

async function refreshAuditEvents(
  cache: ReturnType<typeof kvStore>,
): Promise<SchedulerAuditEvent[]> {
  const current = await cache.list({ prefix: "refresh:audit:v2:" });
  return (
    await Promise.all(
      current.keys.map(
        async (key) => JSON.parse((await cache.get(key.name)) ?? "{}") as SchedulerAuditEvent,
      ),
    )
  )
    .filter((event) => event.event)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

async function githubAccessRouteRecords(cache: ReturnType<typeof kvStore>): Promise<
  Array<{
    area?: string;
    route?: string;
    source?: string;
    resource?: string | null;
    status?: number;
  }>
> {
  const accessKeys = await cache.list({ prefix: "github:access:v1:" });
  const records = await Promise.all(
    accessKeys.keys.map(async (key) => JSON.parse((await cache.get(key.name)) ?? "{}")),
  );
  return records.flatMap((record) =>
    record.routes && typeof record.routes === "object" ? Object.values(record.routes) : [record],
  );
}

test("worker records client dashboard timing beacons in audit log", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const response = await worker.fetch(
    new Request("https://release.bar/api/_client-timing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: "dashboard",
        source: "fetch",
        path: "/steipete",
        apiPath: "/api/steipete",
        attempt: 0,
        httpStatus: 200,
        cacheState: "stale",
        headerMs: 42.4,
        bodyMs: 3.2,
        renderMs: 17.8,
        totalMs: 63.4,
        navigationTtfbMs: 91.2,
        projects: 58,
        scanned: 12,
        limit: 200,
        done: false,
      }),
    }),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );

  assert.equal(response.status, 202);
  await Promise.all(waits);
  const [event] = await refreshAuditEvents(cache);
  assert.equal(event?.event, "client_dashboard_timing");
  assert.equal(event?.source, "browser");
  assert.equal(event?.reason, "fetch");
  assert.equal(event?.status, "stale");
  assert.equal(event?.durationMs, 63);
  assert.equal(event?.projects, 58);
  assert.equal(event?.scanned, 12);
  assert.equal(event?.limit, 200);
  assert.equal(event?.done, false);
  assert.match(event?.detail ?? "", /path=\/steipete/);
  assert.match(event?.detail ?? "", /headerMs=42/);
  assert.match(event?.detail ?? "", /navTtfbMs=91/);
});

test("worker stores GitHub access counters and cached owner identity", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/owner") {
        return Response.json(
          {
            login: "owner",
            type: "User",
            avatar_url: "https://github.com/owner.png",
            html_url: "https://github.com/owner",
          },
          {
            headers: {
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-resource": "core",
            },
          },
        );
      }
      if (url.pathname === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "token" },
      { waitUntil: (promise) => waits.push(promise) },
    );

    assert.equal(response.status, 200);
    await Promise.all(waits);
    const owner = JSON.parse((await cache.get("owner:v1:owner")) ?? "{}") as {
      login?: string;
    };
    assert.equal(owner.login, "owner");
    const records = await githubAccessRouteRecords(cache);
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" &&
          record.source === "shared" &&
          record.route === "users/:owner",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" && record.source === "shared" && record.route === "graphql",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signedJson(secret: string, value: unknown): Promise<string> {
  const payload = base64Url(textEncoder.encode(JSON.stringify(value)));
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

function crawlerRequest(
  url: string,
  userAgent = "Mozilla/5.0 (Linux; Android 6.0.1) AppleWebKit/537.36 Chrome/148.0 Mobile Safari/537.36 (compatible; GoogleOther)",
  cf: Record<string, unknown> | null = { verifiedBotCategory: "AI Crawler" },
): Request {
  const request = new Request(url, {
    headers: {
      "user-agent": userAgent,
    },
  });
  if (cf) {
    Object.defineProperty(request, "cf", {
      value: cf,
    });
  }
  return request;
}

function testProject(overrides: Partial<Project> & Pick<Project, "owner" | "name">): Project {
  const { owner, name, ...rest } = overrides;
  const fullName = `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    description: null,
    url: `https://github.com/${fullName}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 1,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/${fullName}/issues`,
    pullRequestsUrl: `https://github.com/${fullName}/pulls`,
    archived: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    latestCommitSha: "abcdef1",
    latestCommitDate: "2026-05-15T00:00:00Z",
    version: "v1.0.0",
    releaseName: null,
    releaseUrl: `https://github.com/${fullName}/releases/tag/v1.0.0`,
    releaseDate: "2026-05-01T00:00:00Z",
    commitsSinceRelease: 0,
    compareUrl: `https://github.com/${fullName}/compare/v1.0.0...main`,
    ciState: "success",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "fresh",
    ...rest,
  };
}

function testDashboard(owner: string, projects: Project[]): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: `Release freshness for @${owner}.`,
    canonicalDomain: "release.bar",
    generatedAt: "2026-05-15T12:00:00Z",
    owners: [{ type: "user", login: owner }],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: false,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: "2026-05-15T12:00:00Z",
    },
    totals: {
      repos: projects.length,
      released: projects.filter((project) => project.releaseDate).length,
      unreleased: projects.filter((project) => !project.releaseDate).length,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease ?? 0),
        0,
      ),
    },
    projects,
  };
}

test("owner route parsing keeps root hot board and owners API-backed", () => {
  assert.equal(ownerFromPath("/"), null);
  assert.equal(ownerFromPath("/index.html"), null);
  assert.equal(ownerFromPath("/OpenClaw"), "OpenClaw");
  assert.equal(ownerFromPath("/bad_owner"), null);
  assert.equal(ownerDashboardPath("@Steipete"), "/steipete");
  assert.deepEqual(repoFromPath("/OpenClaw/Peekaboo"), {
    owner: "openclaw",
    repo: "peekaboo",
    fullName: "openclaw/peekaboo",
    apiPath: `${workerApiOrigin}/api/repos/openclaw/peekaboo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/openclaw/peekaboo`,
  });
  assert.equal(repoFromPath("/openclaw"), null);
  assert.equal(repoDetailPath("OpenClaw/Peekaboo"), "/openclaw/peekaboo");
  assert.equal(repoDetailPath("OpenClaw/react.dev"), "/-/openclaw/react.dev");
  assert.deepEqual(repoFromPath("/-/og/foo"), {
    owner: "og",
    repo: "foo",
    fullName: "og/foo",
    apiPath: `${workerApiOrigin}/api/repos/og/foo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/og/foo`,
  });
  assert.equal(repoDetailPath("og/foo"), "/-/og/foo");

  assert.deepEqual(dashboardRoute("/", "").isDefault, true);
  assert.equal(dashboardRoute("/", "").apiPath, `${workerApiOrigin}/api/_discover`);
  assert.equal(dashboardRoute("/", "").fallbackApiPath, `${workersDevApiOrigin}/api/_discover`);
  assert.equal(dashboardRoute("/", "").discoverPeriod, "week");
  assert.equal(
    dashboardRoute("/", "?period=day&hotLang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_discover?period=day&lang=TypeScript`,
  );
  assert.equal(
    dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_hot`,
  );
  assert.equal(dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").discoverLanguage, "");
  assert.equal(
    dashboardRoute("/", "?period=day&lang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_discover?period=day`,
  );
  assert.equal(dashboardRoute("/openclaw", "").apiPath, `${workerApiOrigin}/api/openclaw`);
  assert.equal(
    dashboardRoute("/openclaw", "?forks=true&archived=true&unreleased=true").apiPath,
    `${workerApiOrigin}/api/openclaw?forks=true&archived=true`,
  );
  assert.equal(
    dashboardRoute("/openclaw", "?unreleased=false").apiPath,
    `${workerApiOrigin}/api/openclaw?unreleased=false`,
  );
  assert.equal(
    dashboardRoute("/openclaw", "?owners=steipete,openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/openclaw?owners=steipete&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw&repos=steipete/oracle").apiPath,
    `${workerApiOrigin}/api/dashboard?owners=openclaw&repos=steipete%2Foracle`,
  );
  assert.equal(
    dashboardRoute("/", "?owners=openclaw").fallbackApiPath,
    `${workersDevApiOrigin}/api/dashboard?owners=openclaw`,
  );
  assert.equal(
    fallbackApiOrigin({ protocol: "http:", hostname: "127.0.0.1", port: "5174" }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    fallbackApiOrigin({ protocol: "http:", hostname: "localhost", port: "8787" }),
    workersDevApiOrigin,
  );
  assert.equal(
    dashboardRoute(
      "/openclaw",
      "?q=codex&lang=Swift&filter=attention&sort=issues&dir=desc&dev=true",
    ).apiPath,
    `${workerApiOrigin}/api/openclaw`,
  );
});

test("dashboard view state restores search, filters, sorting, and dev columns", () => {
  assert.deepEqual(
    parseViewState("?q=CodexBar&lang=Swift&filter=attention&sort=issues&dir=asc", false),
    {
      query: "CodexBar",
      language: "Swift",
      filter: "attention",
      sortKey: "issues",
      sortDirection: "asc",
      devMode: true,
    },
  );
  assert.deepEqual(parseViewState("?filter=nope&sort=nope&dir=sideways", true), {
    query: "",
    language: "",
    filter: "all",
    sortKey: "since",
    sortDirection: "desc",
    devMode: false,
  });
  assert.deepEqual(parseViewState("?sort=version&dir=asc", false), {
    query: "",
    language: "",
    filter: "all",
    sortKey: "activity",
    sortDirection: "desc",
    devMode: false,
  });

  const state: DashboardViewState = {
    query: "repo",
    language: "Go",
    filter: "hot",
    sortKey: "prs",
    sortDirection: "desc",
    devMode: true,
  };
  assert.equal(
    viewStateSearch("?owners=openclaw&q=old", state, false),
    "?owners=openclaw&q=repo&lang=Go&filter=hot&sort=prs&dir=desc&dev=true",
  );
  assert.equal(
    viewStateSearch(
      "?owners=openclaw&q=repo&filter=all&sort=activity&dir=desc&dev=true",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
    "?owners=openclaw",
  );
  assert.equal(
    viewStateSearch(
      "?period=day&hotLang=TypeScript&lang=Swift",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
    "?period=day&hotLang=TypeScript",
  );
});

test("dashboard project sorting handles dev issue and pull request counts numerically", () => {
  const projects = [
    testProject({ owner: "owner", name: "zero", openIssues: 0, openPullRequests: 0 }),
    testProject({ owner: "owner", name: "many", openIssues: 37, openPullRequests: 3 }),
    testProject({ owner: "owner", name: "some", openIssues: 4, openPullRequests: 12 }),
  ];

  assert.deepEqual(
    sortProjects(projects, "issues", "desc").map((project) => project.name),
    ["many", "some", "zero"],
  );
  assert.deepEqual(
    sortProjects(projects, "prs", "desc").map((project) => project.name),
    ["some", "many", "zero"],
  );
  assert.deepEqual(
    sortProjects(
      [
        testProject({ owner: "owner", name: "small", stars: 10 }),
        testProject({ owner: "owner", name: "large", stars: 1000 }),
      ],
      "stars",
      "desc",
    ).map((project) => project.name),
    ["large", "small"],
  );
});

test("dashboard project search matches independent metadata terms", () => {
  const project = testProject({
    owner: "owner",
    name: "releasebar",
    description: "Manual refresh dashboard",
    language: "TypeScript",
    topics: ["cloudflare", "worker"],
    version: "v1.2.3",
    releaseName: "Ship dashboard search",
    ciState: "failure",
    ciWorkflow: "CI",
  });

  assert.equal(matchesProjectSearch(project, ""), true);
  assert.equal(matchesProjectSearch(project, "typescript v1.2.3"), true);
  assert.equal(matchesProjectSearch(project, "owner worker ci"), true);
  assert.equal(matchesProjectSearch(project, "ship failure"), true);
  assert.equal(matchesProjectSearch(project, "typescript swift"), false);
});

test("dashboard stream signature changes when dev sort counts change", () => {
  const payload = testDashboard("owner", [
    testProject({ owner: "owner", name: "one", openIssues: 1, openPullRequests: 2 }),
  ]);
  payload.generatedAt = "2026-05-22T00:00:00.000Z";
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 16, limit: 200, done: false },
  };
  const next = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  next.projects[0]!.openPullRequests = 9;

  assert.notEqual(
    dashboardStreamSignature(payload, "partial"),
    dashboardStreamSignature(next, "partial"),
  );
});

test("repository detail hides unavailable code churn", () => {
  const base: RepoDetailPayload = {
    fullName: "owner/repo",
    generatedAt: "2026-05-18T00:00:00Z",
    cache: {
      state: "fresh",
      stale: false,
      generatedAt: "2026-05-18T00:00:00Z",
    },
    stats: {
      commitActivity: { state: "ready" },
      codeFrequency: {
        state: "unavailable",
        message: "repository must have fewer than 10000 commits",
      },
    },
    project: testProject({ owner: "owner", name: "repo" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };

  assert.equal(showCodeChurn(base), false);
  assert.equal(
    showCodeChurn({
      ...base,
      stats: {
        commitActivity: base.stats?.commitActivity ?? { state: "ready" },
        codeFrequency: { state: "warming", message: "GitHub is preparing repository statistics." },
      },
    }),
    true,
  );
  assert.equal(
    showCodeChurn({
      ...base,
      codeFrequency: [{ week: "2026-05-18T00:00:00Z", additions: 10, deletions: 3 }],
    }),
    true,
  );
});

test("audience scoring uses only public profile and stargazer signals", () => {
  assert.equal(isLikelyBot("dependabot"), true);
  const bot = calculateAudienceScore({
    login: "github-actions[bot]",
    followers: 100000,
    following: 0,
    publicRepos: 100,
    publicGists: 0,
    company: "GitHub",
    bio: "Automation",
    location: "CI",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2018-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  assert.equal(bot.score, 0);
  assert.equal(bot.tier, "bot");
  assert.deepEqual(bot.reasons, ["automation account"]);
  assert.deepEqual(bot.dimensions, {
    trust: 0,
    influence: 0,
    builder: 0,
    recency: 0,
    risk: 0,
  });
  assert.equal(bot.factors[0]?.key, "risk");
  assert.equal(bot.factors[0]?.label, "account safety");
  assert.equal(bot.factors[0]?.sentiment, "negative");

  const high = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: new Date().toISOString(),
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  assert.equal(high.tier, "high");
  assert.ok(high.score >= 70);
  assert.ok(high.reasons.includes("known tech company"));
  assert.ok(high.reasons.includes("notable org: github"));
  assert.ok(high.dimensions.trust >= 80);
  assert.equal(high.dimensions.risk, 100);
  assert.equal(high.factors.find((factor) => factor.key === "age")?.label, "account age");
  assert.deepEqual(
    high.factors.map((factor) => factor.key),
    ["age", "profile", "orgs", "reach", "builder", "recency", "risk"],
  );
  assert.ok((high.factors.find((factor) => factor.key === "builder")?.weightedValue ?? 0) > 0);
  const profileOnly = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: null,
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  assert.equal(profileOnly.factors.find((factor) => factor.key === "recency")?.weight, 0);
  assert.equal(profileOnly.tier, "high");
  assert.equal(
    Math.round(profileOnly.factors.reduce((sum, factor) => sum + factor.weightedValue, 0)),
    profileOnly.score,
  );

  const low = calculateAudienceScore({
    login: "quiet-user",
    followers: 2,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    company: null,
    bio: null,
    location: null,
    starredAt: null,
  });
  assert.equal(low.tier, "low");
  assert.ok(low.score < 40);
  assert.equal(low.factors.find((factor) => factor.key === "risk")?.sentiment, "negative");
});

test("isLikelyBot flags automation without misclassifying human logins ending in bot", () => {
  // Real automation accounts are still detected.
  for (const login of [
    "dependabot",
    "renovate",
    "github-actions[bot]",
    "my-bot",
    "foo[bot]",
    "gpt4bot",
    "bot",
  ]) {
    assert.equal(isLikelyBot(login), true, `${login} should be detected as a bot`);
  }

  // Ordinary human logins that merely end in the letters "bot" are not.
  for (const login of ["cabot", "talbot", "abbot", "wilbot", "arbot"]) {
    assert.equal(isLikelyBot(login), false, `${login} should not be treated as a bot`);
  }

  // A strong human profile whose login ends in "bot" is scored, not zeroed out.
  const human = calculateAudienceScore({
    login: "cabot",
    followers: 5000,
    following: 50,
    publicRepos: 80,
    publicGists: 2,
    company: "GitHub",
    bio: "Principal engineer",
    location: "SF",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2015-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  assert.notEqual(human.tier, "bot");
  assert.ok(human.score > 0);
});

test("need attention explains release debt, stale releases, CI, and open work", () => {
  const stale = testProject({
    owner: "owner",
    name: "stale",
    releaseDate: "2026-01-01T00:00:00Z",
  });
  const pressured = testProject({
    owner: "owner",
    name: "pressure",
    commitsSinceRelease: 42,
    freshness: "hot",
    ciState: "failure",
    openPullRequests: 12,
    openIssues: 120,
  });
  const releaseDebt = testProject({
    owner: "owner",
    name: "release-debt",
    commitsSinceRelease: 201,
    freshness: "hot",
    releaseDate: "2026-05-01T00:00:00Z",
  });

  assert.equal(needsAttention(stale), true);
  assert.deepEqual(attentionReasons(stale, Date.parse("2026-05-15T00:00:00Z")), [
    "last release 134 days ago",
  ]);
  assert.equal(needsAttention(pressured), true);
  assert.deepEqual(attentionReasons(pressured), ["CI failing", "12 open PRs", "120 open issues"]);
  assert.equal(needsAttention(releaseDebt), true);
  assert.deepEqual(attentionReasons(releaseDebt, Date.parse("2026-05-15T00:00:00Z")), [
    "201 commits since release",
  ]);
  assert.equal(
    attentionReasons(
      testProject({ owner: "owner", name: "fresh" }),
      Date.parse("2026-05-15T00:00:00Z"),
    ).length,
    0,
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "warm",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "hot-placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
  assert.deepEqual(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "unreleased",
        version: "unreleased",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
    [],
  );
});

test("worker builds root hot dashboard from cached dashboards", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 5 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 5 });
  const forksKey = dashboardCacheKey({ owner: "forks", includeForks: true, schemaVersion: 5 });
  const env = {
    DASHBOARD_CACHE: kvStore({
      "hot:index:v3": JSON.stringify([alphaKey]),
      [alphaKey]: JSON.stringify(
        testDashboard("alpha", [
          testProject({
            owner: "alpha",
            name: "hot",
            commitsSinceRelease: 100,
            freshness: "hot",
          }),
          testProject({ owner: "alpha", name: "second", commitsSinceRelease: 80 }),
          testProject({ owner: "alpha", name: "third", commitsSinceRelease: 60 }),
          testProject({ owner: "alpha", name: "fourth", commitsSinceRelease: 40 }),
          testProject({
            owner: "alpha",
            name: "archived",
            archived: true,
            commitsSinceRelease: 120,
          }),
        ]),
      ),
      [betaKey]: JSON.stringify(
        testDashboard("beta", [
          testProject({
            owner: "beta",
            name: "popular",
            stars: 500,
            commitsSinceRelease: 20,
          }),
          testProject({
            owner: "beta",
            name: "unreleased",
            releaseDate: null,
            commitsSinceRelease: null,
          }),
        ]),
      ),
      [forksKey]: JSON.stringify({
        ...testDashboard("forks", [
          testProject({
            owner: "forks",
            name: "cached-fork",
            commitsSinceRelease: 500,
            freshness: "hot",
          }),
        ]),
        options: {
          includeForks: true,
          includeArchived: false,
          includeUnreleased: false,
          repoLimit: 200,
        },
      }),
      [dashboardCacheKey({ owner: "gamma", schemaVersion: 5 })]: JSON.stringify(
        testDashboard("gamma", [
          testProject({
            owner: "gamma",
            name: "from-list",
            commitsSinceRelease: 30,
          }),
        ]),
      ),
    }),
  };

  const response = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.title, "ReleaseBar Hot");
  assert.deepEqual(body.owners, []);
  assert.equal(body.projects[0]?.fullName, "alpha/hot");
  assert.equal(
    body.projects.some((project) => project.fullName === "alpha/archived"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "beta/unreleased"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "forks/cached-fork"),
    false,
  );
  assert.equal(
    body.projects.some((project) => project.fullName === "gamma/from-list"),
    true,
  );
  assert.equal(body.projects.filter((project) => project.owner === "alpha").length <= 3, true);
  assert.match(body.cache?.message ?? "", /cached dashboards/);

  const cachedResponse = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });
  const cachedBody = (await cachedResponse.json()) as DashboardPayload;
  assert.equal(cachedBody.cache?.repoLimit, null);
  assert.match(cachedBody.cache?.message ?? "", /cached dashboards/);
});

test("worker keeps hot owner route distinct from root hot API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/hot") {
      return Response.json({ login: "hot", type: "User" });
    }
    if (url.pathname === "/users/hot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/hot"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    const body = (await response.json()) as DashboardPayload;
    assert.equal(response.status, 200);
    assert.equal(body.owners[0]?.login, "hot");
    assert.notEqual(body.title, "ReleaseBar Hot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves escaped dotted repository detail paths as app shell", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/-/openclaw/react.dev"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ReleaseBar release freshness dashboard for openclaw\/react\.dev/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
});

test("worker embeds cached public dashboard data in the app shell", async () => {
  const payload = testDashboard("hot", [testProject({ owner: "acme", name: "releasebar" })]);
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"dashboard"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for ReleaseBar Hot"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/ReleaseBar%20Hot\.png"/,
  );
  assert.ok(html.indexOf('id="releasebar-initial-data"') < html.indexOf('<script type="module"'));
});

test("worker embeds cached metadata-only owner dashboard data in the app shell", async () => {
  const payload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.options = { ...payload.options!, includeUnreleased: true };
  payload.cache = {
    ...payload.cache!,
    message: "release scan skipped until GitHub App quota is available",
  };
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 5,
  });
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        [key]: JSON.stringify(payload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "cookie");
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /owner\\u002frepo|owner\/repo/);
  assert.match(html, /release scan skipped/);
});

test("worker embeds cached crawler dashboard shells without discovering app installs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 5,
  });
  let installationListCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([]);
    }
    throw new Error(`crawler shell should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/owner", "Googlebot/2.1", null),
      {
        ASSETS: {
          fetch: async (request: Request) => {
            assert.equal(new URL(request.url).pathname, "/index.html");
            return new Response(
              '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
              { headers: { "content-type": "text/html" } },
            );
          },
        },
        DASHBOARD_CACHE: kvStore({
          [key]: JSON.stringify(payload),
        }),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );

    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="releasebar-initial-data"/);
    assert.match(html, /owner\\u002frepo|owner\/repo/);
    assert.equal(installationListCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached language-filtered discover data in the app shell", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&hotLang=TypeScript"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /typedbar/);
  assert.doesNotMatch(html, /allbar/);
});

test("worker preserves partial discover state in embedded app shell data", async () => {
  const payload = testDashboard("all", [
    testProject({
      owner: "acme",
      name: "placeholder",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 0, limit: 1, done: false },
  };
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"state":"partial"/);
  assert.match(html, /"done":false/);
});

test("worker does not treat view language filters as discover cache selectors", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&lang=TypeScript"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /allbar/);
  assert.doesNotMatch(html, /typedbar/);
});

test("worker embeds cached public repository detail data in the app shell", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({ owner: "acme", name: "releasebar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const response = await worker.fetch(
    new Request("https://release.bar/acme/releasebar"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          assert.equal(new URL(request.url).pathname, "/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="releasebar-initial-data"/);
  assert.match(html, /"route":"repo"/);
  assert.match(html, /acme\\u002freleasebar|acme\/releasebar/);
  assert.match(
    html,
    /property="og:title" content="ReleaseBar release freshness dashboard for acme\/releasebar"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/release\.bar\/og\/acme%2Freleasebar\.png"/,
  );
});

test("worker social cards include owner avatars and repository release metrics", async () => {
  const generatedAt = new Date().toISOString();
  const repoPayload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      description: "Release freshness for maintainers",
      version: "v2.0.0",
      commitsSinceRelease: 42,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "repo-detail:v4:acme/releasebar": JSON.stringify(repoPayload),
    }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && ["/acme.png", "/openclaw.png"].includes(url.pathname)) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };

  try {
    const repoResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.svg"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoResponse.status, 200);
    const repoSvg = await repoResponse.text();
    assert.match(repoSvg, /acme\/releasebar/);
    assert.match(repoSvg, /v2\.0\.0 · 42 commits since release/);
    assert.match(repoSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(repoSvg, /https:\/\/github\.com\/acme\.png\?size=240/);

    const ownerResponse = await worker.fetch(
      new Request("https://release.bar/og/openclaw.svg"),
      env,
      { waitUntil: () => undefined },
    );
    const ownerSvg = await ownerResponse.text();
    assert.match(ownerSvg, /@openclaw/);
    assert.match(ownerSvg, /data:image\/png;base64,AQID/);
    assert.doesNotMatch(ownerSvg, /https:\/\/github\.com\/openclaw\.png\?size=240/);

    const pngAssetPaths: string[] = [];
    const pngResponse = await worker.fetch(
      new Request("https://release.bar/og/acme%2Freleasebar.png"),
      {
        ...env,
        ASSETS: {
          fetch: (request: Request) => socialRenderAsset(request, pngAssetPaths),
        },
      },
      { waitUntil: () => undefined },
    );
    assert.equal(pngResponse.status, 200);
    assert.equal(pngResponse.headers.get("content-type"), "image/png");
    const pngBytes = new Uint8Array(await pngResponse.arrayBuffer());
    assert.deepEqual(Array.from(pngBytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(pngBytes.byteLength > 1_000);
    assert.deepEqual(pngAssetPaths, [
      "/resvg.wasm",
      "/jetbrains-mono-latin-400-normal.woff2",
      "/jetbrains-mono-latin-700-normal.woff2",
    ]);
    assert.notEqual(pngAssetPaths[0], "/og-card.png");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const coldStore = kvStore();
  const coldCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/cold.png") {
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/png" },
      });
    }
    coldCalls.push(url.pathname);
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
    if (url.pathname === "/repos/cold/repo") {
      return Response.json({
        owner: { login: "cold" },
        name: "repo",
        full_name: "cold/repo",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/cold/repo",
        description: "Cold social repository",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/repos/cold/repo/releases") {
      return Response.json([
        {
          tag_name: "v3.0.0",
          name: "v3",
          html_url: "https://github.com/cold/repo/releases/tag/v3.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-16T12:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/repos/cold/repo/compare/v3.0.0...main") {
      return Response.json({
        total_commits: 9,
        html_url: "https://github.com/cold/repo/compare/v3.0.0...main",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/og/cold%2Frepo.svg"),
      { DASHBOARD_CACHE: coldStore, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const coldSvg = await coldResponse.text();
    assert.match(coldSvg, /v3\.0\.0 · 9 commits since release/);
    assert.match(coldSvg, /data:image\/png;base64,BAUG/);
    assert.deepEqual(coldCalls, [
      "/repos/cold/repo",
      "/repos/cold/repo/releases",
      "/repos/cold/repo/compare/v3.0.0...main",
    ]);
    assert.notEqual(await coldStore.get("social-repo:v3:cold/repo"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stalePayload: RepoDetailPayload = {
    ...repoPayload,
    fullName: "stale/repo",
    generatedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    project: testProject({
      owner: "stale",
      name: "repo",
      version: "v9.9.9",
      commitsSinceRelease: 7,
    }),
  };
  const queued: Promise<unknown>[] = [];
  let backgroundCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/stale.png") {
      return new Response("not an image", { headers: { "content-type": "text/plain" } });
    }
    backgroundCalls += 1;
    throw new Error("queued refresh only");
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/og/stale%2Frepo.svg"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:stale/repo": JSON.stringify(stalePayload),
        }),
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    const staleSvg = await staleResponse.text();
    assert.match(staleSvg, /v9\.9\.9 · 7 commits since release/);
    assert.match(staleSvg, />SR<\/text>/);
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    assert.equal(backgroundCalls > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cached GitHub discovery dashboards from repository search", async () => {
  const originalFetch = globalThis.fetch;
  const searchItems = Array.from({ length: 13 }, (_, index) => {
    const name = index === 0 ? "releasebar" : `releasebar-${index + 1}`;
    return {
      name,
      full_name: `acme/${name}`,
      private: false,
      fork: false,
      archived: false,
      html_url: `https://github.com/acme/${name}`,
      description: "Release dashboard",
      default_branch: "main",
      language: "TypeScript",
      topics: ["releases", "dashboard"],
      stargazers_count: 1200 - index,
      forks_count: 42,
      open_issues_count: 7,
      pushed_at: "2026-05-16T12:00:00Z",
      updated_at: "2026-05-16T12:00:00Z",
      owner: { login: "acme" },
    };
  });
  let searchCalls = 0;
  const hydratedPaths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      searchCalls += 1;
      assert.match(url.searchParams.get("q") ?? "", /language:"TypeScript"/);
      assert.match(url.searchParams.get("q") ?? "", /pushed:>=/);
      assert.equal(url.searchParams.get("sort"), "stars");
      assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
      return Response.json(
        {
          total_count: searchItems.length,
          incomplete_results: false,
          items: searchItems,
        },
        {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1770000000",
            "x-ratelimit-resource": "search",
          },
        },
      );
    }
    hydratedPaths.push(url.pathname);
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/releases$/)) {
      if (url.pathname === "/repos/acme/releasebar-13/releases") {
        return Response.json([]);
      }
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          published_at: "2026-05-15T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const first = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = (await first.json()) as DashboardPayload;
    assert.equal(body.title, "GitHub Hot");
    assert.equal(body.projects[0]?.fullName, "acme/releasebar");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.deepEqual(body.projects[0]?.topics, ["releases", "dashboard"]);
    assert.equal(body.projects[0]?.openIssues, 7);
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.equal(body.cache?.progress?.limit, searchItems.length);
    assert.equal(body.cache?.quota?.remaining, 4999);
    assert.match(body.cache?.message ?? "", /repository search/);

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(second.status, 200);
    const firstBatch = (await second.json()) as DashboardPayload;
    assert.equal(firstBatch.cache?.state, "partial");
    assert.equal(firstBatch.cache?.progress?.done, false);
    assert.equal(firstBatch.cache?.progress?.scanned, 8);
    assert.equal(
      firstBatch.projects.filter((project) => project.version === "repo search").length,
      5,
    );

    await Promise.all(waitUntil.splice(0));

    const third = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    assert.equal(third.status, 200);
    const hydrated = (await third.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.cache?.progress?.done, true);
    assert.equal(hydrated.cache?.progress?.scanned, searchItems.length);
    assert.equal(
      hydrated.projects.filter((project) => project.version === "repo search").length,
      0,
    );
    assert.equal(hydrated.projects[0]?.version, "v1.2.3");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, null);
    assert.equal(hydrated.projects[0]?.openPullRequests, 0);
    assert.equal(hydrated.projects[12]?.version, "unreleased");
    assert.equal(hydrated.projects[12]?.releaseDate, null);
    assert.equal(searchCalls, 1);
    assert.equal(hydratedPaths.length, searchItems.length);
    assert.equal(
      hydratedPaths.every((path) => /^\/repos\/acme\/[^/]+\/releases$/.test(path)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not rehydrate completed GitHub discovery cache", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date().toISOString(),
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: new Date().toISOString(),
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async () => {
    throw new Error("discovery cache should not fetch");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale discovery caches to crawlers without searching GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const waits: Array<Promise<unknown>> = [];
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: "2026-05-15T12:00:00Z",
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: "2026-05-15T12:00:00Z",
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh discovery ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/_discover?period=week", "SemrushBot/7~bl", null),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects[0]?.version, "v2.0.0");
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.cache?.message, "showing cached discovery results");
    assert.equal(waits.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds cached repository detail with releases and stats", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json(
        {
          owner: { login: "acme" },
          name: "releasebar",
          full_name: "acme/releasebar",
          private: false,
          fork: false,
          archived: false,
          html_url: "https://github.com/acme/releasebar",
          description: "Release dashboard",
          default_branch: "main",
          language: "TypeScript",
          topics: ["release-health"],
          stargazers_count: 1234,
          forks_count: 45,
          open_issues_count: 9,
          pushed_at: "2026-05-16T12:00:00Z",
          updated_at: "2026-05-16T12:00:00Z",
        },
        {
          headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "100",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    if (path === "/repos/acme/releasebar/releases") {
      assert.equal(url.searchParams.get("per_page"), "100");
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T00:00:00Z",
        },
        {
          tag_name: "v1.2.2",
          name: "Release 1.2.2",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.2",
          draft: false,
          prerelease: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/contributors") {
      return Response.json([
        {
          login: "octo",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/octo",
          contributions: 42,
        },
      ]);
    }
    if (path === "/repos/acme/releasebar/languages") {
      return Response.json({ TypeScript: 900, CSS: 100 });
    }
    if (path === "/repos/acme/releasebar/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/releasebar/pulls") {
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/1/pulls?state=open&per_page=1&page=2>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/releasebar/compare/v1.2.3...main") {
      return Response.json({
        total_commits: 6,
        html_url: "https://github.com/acme/releasebar/compare/v1.2.3...main",
      });
    }
    if (path === "/repos/acme/releasebar/commits/abcdef123456/check-runs") {
      return Response.json({
        check_runs: [
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/1",
            status: "completed",
            conclusion: "success",
            name: "CI",
            completed_at: "2026-05-16T12:30:00Z",
          },
          {
            html_url: "https://github.com/acme/releasebar/actions/runs/2",
            status: "completed",
            conclusion: "failure",
            name: "Lint",
            completed_at: "2026-05-16T12:20:00Z",
          },
        ],
      });
    }
    if (path === "/repos/acme/releasebar/stats/commit_activity") {
      return Response.json([{ week: 1778889600, total: 7, days: [0, 1, 2, 0, 3, 1, 0] }]);
    }
    if (path === "/repos/acme/releasebar/stats/code_frequency") {
      return Response.json([[1778889600, 120, -20]]);
    }
    if (path === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      if (query.includes("is:issue") && query.includes("created:>=")) {
        return Response.json({ total_count: 5 });
      }
      if (query.includes("is:issue") && query.includes("closed:>=")) {
        return Response.json({ total_count: 3 });
      }
      if (query.includes("is:pr") && query.includes("created:>=")) {
        return Response.json({ total_count: 4 });
      }
      if (query.includes("is:pr") && query.includes("closed:>=")) {
        return Response.json({ total_count: 2 });
      }
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:octo": JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 73,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.fullName, "acme/releasebar");
    assert.equal(body.project.version, "v1.2.3");
    assert.equal(body.project.commitsSinceRelease, 6);
    assert.equal(body.project.openIssues, 7);
    assert.equal(body.project.openPullRequests, 2);
    assert.equal(body.project.ciState, "failure");
    assert.equal(body.project.ciWorkflow, "Lint");
    assert.equal(body.releases.length, 2);
    assert.equal(body.contributors[0]?.login, "octo");
    assert.equal(body.contributors[0]?.trustScore, 73);
    assert.equal(body.contributors[0]?.trustTier, "high");
    assert.equal(body.commitActivity[0]?.total, 7);
    assert.equal(body.codeFrequency[0]?.additions, 120);
    assert.equal(body.codeFrequency[0]?.deletions, 20);
    assert.equal(body.stats?.commitActivity.state, "ready");
    assert.equal(body.stats?.codeFrequency.state, "ready");
    assert.equal(body.workTrend?.issuesOpened30d, 5);
    assert.equal(body.workTrend?.pullRequestsClosed30d, 2);
    assert.deepEqual(
      body.languages.map((language) => language.name),
      ["TypeScript", "CSS"],
    );
    const accessRecords = await githubAccessRouteRecords(env.DASHBOARD_CACHE);
    assert.ok(
      accessRecords.some(
        (record) =>
          record.area === "repo-detail" &&
          record.source === "shared" &&
          record.resource === "core" &&
          record.status === 200,
      ),
    );
    assert.ok(await env.DASHBOARD_CACHE.get("github:budget:v1:shared:core"));

    await env.DASHBOARD_CACHE.put(
      "trust-profile:v4:octo",
      JSON.stringify({
        login: "octo",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 62,
        tier: "medium",
        generatedAt: "2026-05-16T12:05:00Z",
      }),
    );
    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    const cachedBody = (await cached.json()) as RepoDetailPayload;
    assert.equal(cachedBody.contributors[0]?.trustScore, 62);
    assert.equal(cachedBody.contributors[0]?.trustTier, "medium");
    assert.equal(calls, 14);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds cached repository audience from public stargazers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { owner?: string; name?: string; first?: number };
      };
      assert.equal(body.variables?.owner, "acme");
      assert.equal(body.variables?.name, "releasebar");
      assert.equal(body.variables?.first, 30);
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "quiet",
                    avatarUrl: "https://avatars.githubusercontent.com/u/11",
                    url: "https://github.com/quiet",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "renovate-bot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/12",
                    url: "https://github.com/renovate-bot",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/repos/acme/releasebar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers instanceof Headers, false);
      assert.match(String(headers?.accept), /star\+json/);
      if (url.searchParams.get("page") !== "3") {
        return Response.json(
          [
            {
              starred_at: "2020-01-01T00:00:00Z",
              user: {
                login: "old",
                avatar_url: "https://avatars.githubusercontent.com/u/9",
                html_url: "https://github.com/old",
              },
            },
          ],
          {
            headers: {
              link: '<https://api.github.com/repos/acme/releasebar/stargazers?per_page=30&page=3>; rel="last"',
            },
          },
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "principal",
            avatar_url: "https://avatars.githubusercontent.com/u/10",
            html_url: "https://github.com/principal",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "quiet",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/quiet",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "renovate-bot",
            avatar_url: "https://avatars.githubusercontent.com/u/12",
            html_url: "https://github.com/renovate-bot",
          },
        },
      ]);
    }
    if (path === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
        {
          login: "acme",
          avatar_url: "https://avatars.githubusercontent.com/u/20",
          description: "Developer tools",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    if (path === "/users/quiet") {
      return Response.json({
        login: "quiet",
        avatar_url: "https://avatars.githubusercontent.com/u/11",
        html_url: "https://github.com/quiet",
        type: "User",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 2,
        following: 0,
        public_repos: 1,
        public_gists: 0,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/quiet/orgs") {
      return Response.json([]);
    }
    if (path === "/users/quiet/repos") {
      return Response.json([]);
    }
    if (path === "/users/renovate-bot") {
      return Response.json({
        login: "renovate-bot",
        avatar_url: "https://avatars.githubusercontent.com/u/12",
        html_url: "https://github.com/renovate-bot",
        type: "Bot",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 1000,
        following: 0,
        public_repos: 100,
        public_gists: 0,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:principal": JSON.stringify({
        login: "principal",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 88,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.equal(body.fullName, "acme/releasebar");
    assert.equal(body.range, "month");
    assert.equal(body.users[0]?.login, "principal");
    assert.equal(body.users[0]?.tier, "high");
    assert.equal(body.users[0]?.trustScore, 88);
    assert.equal(body.users[0]?.trustTier, "high");
    assert.ok((body.users[0]?.dimensions.trust ?? 0) >= 80);
    assert.equal(body.users[0]?.orgs[0]?.login, "github");
    assert.equal(body.users[0]?.topRepositories[0]?.fullName, "principal/release-tools");
    assert.match(body.users[0]?.reasons.join(" ") ?? "", /notable org: github/);
    assert.equal(body.totals.stargazers, 1234);
    assert.equal(body.totals.highSignal, 1);
    assert.equal(body.totals.bots, 1);
    assert.equal(body.totals.highSignalPercent, 33);
    assert.equal(body.totals.mediumSignalPercent, 0);
    assert.equal(body.totals.lowSignalPercent, 33);
    assert.equal(body.totals.botPercent, 33);
    assert.equal(body.cache.quota?.source, "shared");

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.equal(calls, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker REST stargazer fallback samples newest stargazers", async () => {
  const originalFetch = globalThis.fetch;
  const stargazerPages: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/restbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "restbar",
        full_name: "acme/restbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/restbar",
        description: "REST fallback",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 31,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/restbar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.match(String(headers?.accept), /star\+json/);
      stargazerPages.push(url.searchParams.get("page") ?? "first");
      if (url.searchParams.get("page") !== "2") {
        return Response.json(
          [
            {
              starred_at: new Date().toISOString(),
              user: {
                login: "previous",
                avatar_url: "https://avatars.githubusercontent.com/u/10",
                html_url: "https://github.com/previous",
              },
            },
          ],
          !url.searchParams.has("page")
            ? {
                headers: {
                  link: '<https://api.github.com/repos/acme/restbar/stargazers?per_page=30&page=2>; rel="last"',
                },
              }
            : undefined,
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "newest",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/newest",
          },
        },
      ]);
    }
    const user = path.match(/^\/users\/([^/]+)$/)?.[1];
    if (user === "previous" || user === "newest") {
      return Response.json({
        login: user,
        avatar_url: `https://avatars.githubusercontent.com/u/${user === "previous" ? "10" : "11"}`,
        html_url: `https://github.com/${user}`,
        type: "User",
        name: user,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: user === "newest" ? 20 : 10,
        following: 1,
        public_repos: 2,
        public_gists: 0,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/previous/orgs" || path === "/users/newest/orgs") {
      return Response.json([]);
    }
    if (path === "/users/previous/repos" || path === "/users/newest/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/restbar/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.deepEqual(stargazerPages, ["first", "2", "1"]);
    assert.deepEqual(body.users.map((user) => user.login).sort(), ["newest", "previous"]);
    assert.equal(body.totals.stargazers, 31);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository audience caches to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const cache = kvStore({
    "repo-audience:v5:acme/releasebar:month": JSON.stringify({
      fullName: "acme/releasebar",
      range: "month",
      generatedAt,
      cache: {
        state: "fresh",
        stale: false,
        generatedAt,
      },
      totals: {
        stargazers: 10,
        stargazersSampled: 1,
        highSignal: 1,
        mediumSignal: 0,
        lowSignal: 0,
        bots: 0,
        highSignalPercent: 100,
        mediumSignalPercent: 0,
        lowSignalPercent: 0,
        botPercent: 0,
      },
      users: [],
    } satisfies RepoAudiencePayload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler stale audience cache should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/releasebar/audience"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoAudiencePayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "showing cached repository audience signals");
    assert.equal(body.totals.stargazers, 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves OpenAPI spec aliases for Swagger tooling", async () => {
  const env = { DASHBOARD_CACHE: kvStore() };
  for (const path of ["/openapi.json", "/api/openapi.json", "/api/swagger.json"]) {
    const response = await worker.fetch(new Request(`https://release.bar${path}`), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    assert.equal(body.openapi, "3.1.0");
    assert.ok(body.paths?.["/api/users/{login}/trust"]);
    assert.ok(body.paths?.["/api/repos/{owner}/{repo}/audience"]);
  }
});

test("worker rejects malformed nested owner API paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw/openclaw/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "not found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured audience GETs off shared quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "private-key",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /GitHub App/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only backfills repository audience caches with GitHub App quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const denied = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
      }),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(denied.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "audience-backfill";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  let appCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const authorization = new Headers(init?.headers).get("authorization");
    if (path === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "acme",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/acme",
            },
            html_url: "https://github.com/organizations/acme/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (path === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (path === "/repos/acme/releasebar") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: ["developer-tools"],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/users/principal") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/principal/orgs") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      appCalls += 1;
      assert.equal(authorization, "Bearer installation-token");
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      fullName: string;
      ranges: Array<{ range: AudienceRange; state: string; users: number }>;
      quota: { source: string; account: string | null };
    };
    assert.equal(body.fullName, "acme/releasebar");
    assert.deepEqual(
      body.ranges.map((range) => `${range.range}:${range.state}:${range.users}`),
      ["week:rebuilt:1", "month:rebuilt:1"],
    );
    assert.deepEqual(body.quota, { source: "app", account: "acme" });
    assert.ok(appCalls > 0);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience?range=week"),
      env,
      { waitUntil: () => undefined },
    );
    const audience = (await cached.json()) as RepoAudiencePayload;
    assert.equal(audience.cache.quota?.source, "app");
    assert.equal(audience.users[0]?.factors.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker builds bounded trust profiles for people pages", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "principal/trust-map",
          html_url: "https://github.com/principal/trust-map",
          description: "Trust signals",
          language: "TypeScript",
          stargazers_count: 10,
          forks_count: 2,
          fork: false,
          archived: false,
          topics: ["trust", "developer-tools"],
          pushed_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
    assert.equal(body.login, "principal");
    assert.equal(body.type, "user");
    assert.equal(body.profileKind, "user_trust");
    assert.equal(body.scoreLabel, "trust score");
    assert.equal(body.tier, "high");
    assert.ok((body.accountAgeDays ?? 0) > 3650);
    assert.ok(body.dimensions.trust >= 80);
    assert.equal(body.stats.totalStars, 130);
    assert.equal(body.stats.activeRepositories, 2);
    assert.equal(body.stats.languages[0]?.name, "typescript");
    assert.equal(body.stats.topics[0]?.name, "developer-tools");
    assert.equal(body.orgs[0]?.login, "github");
    assert.equal(body.topRepositories[0]?.fullName, "principal/release-tools");
    assert.equal(body.factors.find((factor) => factor.key === "age")?.label, "account age");
    assert.match(
      body.factors.find((factor) => factor.key === "builder")?.detail ?? "",
      /recent repos scanned/,
    );
    assert.match(body.reasons.join(" "), /notable org: github/);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.deepEqual(paths, [
      "/users/principal",
      "/users/principal/orgs",
      "/users/principal/repos",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered app quota for anonymous trust profiles", async () => {
  const cache = kvStore({
    "auth:installation:v1:principal": JSON.stringify({
      id: 42,
      accountLogin: "principal",
      accountType: "user",
      accountUrl: "https://github.com/principal",
      avatarUrl: "https://avatars.githubusercontent.com/u/10",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    assert.equal(authorization, "Bearer installation-token");
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.quota?.source, "app");
    assert.equal(body.cache.quota?.account, "principal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns org signal profiles for organization accounts", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/openclaw") {
      return Response.json({
        login: "openclaw",
        avatar_url: "https://avatars.githubusercontent.com/u/20",
        html_url: "https://github.com/openclaw",
        type: "Organization",
        name: "OpenClaw",
        company: null,
        bio: "Open source agent tooling",
        location: "Internet",
        blog: "https://openclaw.dev",
        twitter_username: null,
        followers: 1200,
        following: 0,
        public_repos: 42,
        public_gists: 0,
        created_at: "2018-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      assert.equal(url.searchParams.get("type"), "public");
      return Response.json([
        {
          full_name: "openclaw/openclaw",
          html_url: "https://github.com/openclaw/openclaw",
          description: "Agent runtime",
          language: "TypeScript",
          stargazers_count: 900,
          forks_count: 80,
          private: false,
          visibility: "public",
          fork: false,
          archived: false,
          topics: ["agents", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          full_name: "openclaw/private-signals",
          html_url: "https://github.com/openclaw/private-signals",
          description: "Should never leak",
          language: "TypeScript",
          stargazers_count: 9999,
          forks_count: 0,
          private: true,
          visibility: "private",
          fork: false,
          archived: false,
          topics: ["private"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/openclaw/trust"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.deepEqual(paths, ["/users/openclaw", "/orgs/openclaw/repos"]);
    assert.equal(body.type, "org");
    assert.equal(body.profileKind, "org_signal");
    assert.equal(body.scoreLabel, "org signal");
    assert.equal(body.stats.totalStars, 900);
    assert.deepEqual(
      body.topRepositories.map((repo) => repo.fullName),
      ["openclaw/openclaw"],
    );
    assert.equal(body.orgs.length, 0);
    assert.ok(body.reasons.includes("organization account"));
    assert.equal(
      body.factors.find((factor) => factor.key === "orgs"),
      undefined,
    );
    assert.equal(
      body.factors.find((factor) => factor.key === "builder")?.label,
      "repository footprint",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes stale trust profiles in the background", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const staleProfile: TrustProfilePayload = {
    login: "principal",
    type: "user",
    profileKind: "user_trust",
    scoreLabel: "trust score",
    avatarUrl: "https://avatars.githubusercontent.com/u/10",
    url: "https://github.com/principal",
    name: "Old Principal",
    company: null,
    bio: null,
    location: null,
    blog: null,
    twitterUsername: null,
    followers: 1,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    accountCreatedAt: "2020-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-16T12:00:00Z",
    accountAgeDays: 1000,
    score: 10,
    tier: "low",
    reasons: [],
    dimensions: { trust: 0, influence: 0, builder: 0, recency: 0, risk: 100 },
    factors: [],
    orgs: [],
    topRepositories: [],
    stats: {
      totalStars: 0,
      totalForks: 0,
      recentRepositories: 0,
      activeRepositories: 0,
      publicOrganizations: 0,
      languages: [],
      topics: [],
    },
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "bounded public GitHub profile signals",
    },
  };
  const cache = kvStore({
    "trust-profile:v4:principal": JSON.stringify(staleProfile),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "New Principal",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (url.pathname === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (url.pathname === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 120,
          forks_count: 12,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/users/principal/trust"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as TrustProfilePayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "refreshing trust profile");
    assert.equal(body.name, "Old Principal");
    assert.equal(queued.length, 1);
    await Promise.all(queued);
    const refreshed = JSON.parse(
      (await cache.get("trust-profile:v4:principal")) ?? "{}",
    ) as TrustProfilePayload;
    assert.equal(refreshed.name, "New Principal");
    assert.equal(refreshed.cache.state, "fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker throttles cached warming repository detail refreshes", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "warming");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached warming repository detail after short grace window", async () => {
  const generatedAt = new Date(Date.now() - 31_000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("queued refresh");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "refreshing repository statistics");
    assert.equal(waitUntilPromises.length, 1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository detail to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "stale");
    assert.equal(body.cache.message, "showing cached repository statistics");
    assert.equal(waitUntilPromises.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps crawler-only auxiliary API misses off GitHub", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler auxiliary cache miss should not call GitHub ${String(input)}`);
  };
  try {
    for (const url of [
      "https://release.bar/api/kvark/activity?range=week",
      "https://release.bar/api/users/kvark/trust",
      "https://release.bar/api/repos/acme/coldbar/activity?range=week",
      "https://release.bar/api/repos/acme/coldbar",
    ]) {
      const response = await worker.fetch(
        crawlerRequest(url),
        { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
        { waitUntil: () => undefined },
      );
      assert.equal(response.status, 202, url);
      const body = (await response.json()) as { cache?: { state?: string; message?: string } };
      assert.equal(body.cache?.state, "warming");
      assert.match(body.cache?.message ?? "", /crawler/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes commits since release in the background", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "refreshing repository statistics",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 2,
      commitsUsed: 0,
      message: "Summarizing commits since the latest release.",
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 2,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = kvStore({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.equal(url.searchParams.get("page"), "1");
      return Response.json({
        total_commits: 2,
        commits: [
          { commit: { message: "Add release summary panel\n\nLong body" } },
          { commit: { message: "Fix summary cache key" } },
        ],
      });
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.match(JSON.stringify(body.input), /Add release summary panel/);
      return Response.json({
        output_text: "",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "ReleaseBar added an AI summary panel and tightened the cache key for generated summaries.",
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.releaseSummary?.state, "warming");
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    assert.equal(cached.releaseSummary?.state, "ready");
    assert.equal(cached.releaseSummary?.model, "chat-latest");
    assert.match(cached.releaseSummary?.text ?? "", /AI summary panel/);
    assert.equal(cached.releaseSummary?.commitsUsed, 2);
    assert.equal(cached.generatedAt, generatedAt);
    assert.equal(cached.cache.state, "warming");
    assert.equal(cached.cache.generatedAt, generatedAt);
    assert.notEqual(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:chat-latest"),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes recent repository activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased") {
      return Response.json({
        owner: { login: "acme" },
        name: "unreleased",
        full_name: "acme/unreleased",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/unreleased",
        description: "Unreleased repo",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 12,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: now,
        updated_at: now,
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased/events") {
      if (url.searchParams.get("page") !== "1") return Response.json([]);
      return Response.json([
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            size: 2,
            commits: [
              { message: "Add repository activity summary" },
              { message: "Polish unreleased project copy" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            action: "merged",
            pull_request: {
              title: "Wire recent work panel",
              html_url: "https://github.com/acme/unreleased/pull/1",
            },
          },
        },
      ]);
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.match(JSON.stringify(body.input), /Repository: acme\/unreleased/);
      assert.match(JSON.stringify(body.input), /Add repository activity summary/);
      return Response.json({
        output_text:
          "acme/unreleased added a recent-work panel for unreleased projects and polished the copy around that flow.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/unreleased/activity?range=month"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailActivityPayload;
    assert.equal(body.fullName, "acme/unreleased");
    assert.equal(body.range, "month");
    assert.equal(body.summary?.state, "warming");
    assert.equal(body.totals.commits, 2);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-activity:v1:acme/unreleased:month")) ?? "{}",
    ) as RepoDetailActivityPayload;
    assert.equal(cached.summary?.state, "ready", cached.summary?.message ?? "");
    assert.equal(cached.summary?.model, "chat-latest");
    assert.match(cached.summary?.text ?? "", /recent-work panel/);
    assert.equal(cached.summary?.promptVersion, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes public owner activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const generatedAt = new Date().toISOString();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme") {
      return Response.json({
        login: "acme",
        type: "User",
        avatar_url: "https://github.com/acme.png",
        html_url: "https://github.com/acme",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme/events/public") {
      assert.equal(url.searchParams.get("per_page"), "100");
      if (url.searchParams.get("page") !== "1") {
        return Response.json([]);
      }
      const events: unknown[] = [
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            size: 4,
            commits: [
              { message: "Add owner activity panel\n\nLong body" },
              { message: "Cache activity summaries" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            action: "opened",
            pull_request: {
              title: "Polish working-on copy",
              html_url: "https://github.com/acme/releasebar/pull/1",
            },
          },
        },
        {
          id: "repo-missing",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: {},
          payload: {
            size: 1,
            commits: [{ message: "This malformed event should be ignored" }],
          },
        },
        {
          id: "3",
          type: "PushEvent",
          public: false,
          created_at: generatedAt,
          repo: { name: "acme/private" },
          payload: { commits: [{ message: "private work" }] },
        },
      ];
      for (let index = 4; index <= 125; index += 1) {
        events.push({
          id: String(index),
          type: "IssueCommentEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            issue: {
              title: `Activity thread ${index}`,
              html_url: `https://github.com/acme/releasebar/issues/${index}`,
            },
          },
        });
      }
      return Response.json(events);
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      const headers = init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, "Bearer openai-token");
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.model, "chat-latest");
      assert.equal(body.reasoning, undefined);
      assert.match(body.instructions, /do not restate those facts/i);
      assert.doesNotMatch(body.instructions, /Say this is public activity/i);
      assert.match(JSON.stringify(body.input), /Top repositories: acme\/releasebar/);
      assert.match(JSON.stringify(body.input), /Add owner activity panel/);
      assert.match(JSON.stringify(body.input), /Events included: 120/);
      return Response.json({
        output_text:
          "ReleaseBar activity summaries, cache behavior, and dashboard copy moved forward together.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as OwnerActivityPayload;
    assert.equal(body.owner.login, "acme");
    assert.equal(body.range, "week");
    assert.equal(body.totals.commits, 4);
    assert.equal(body.totals.pullRequests, 1);
    assert.equal(body.totals.repositories, 1);
    const commitEvent = body.events.find((event) => event.kind === "commit");
    assert.match(commitEvent?.title ?? "", /\+3 commits/);
    assert.equal(
      body.events.some((event) => event.repo === "acme/private"),
      false,
    );
    assert.equal(body.summary?.state, "warming");
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v1:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "ready", cached.summary?.message ?? "");
    assert.match(cached.summary?.text ?? "", /activity summaries/);
    assert.doesNotMatch(cached.summary?.text ?? "", /GitHub activity|public activity/i);
    assert.notEqual(cached.summary?.inputHash, null);
    assert.equal(cached.summary?.eventsUsed, 120);
    assert.equal(cached.summary?.promptVersion, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker skips stale public owner activity summaries when events changed", async () => {
  const generatedAt = new Date().toISOString();
  const oldPayload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "old",
        kind: "commit",
        title: "Add old activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "old-hash",
      eventsUsed: 1,
    },
  };
  const newPayload: OwnerActivityPayload = {
    ...oldPayload,
    events: [
      {
        id: "new",
        kind: "commit",
        title: "Add new activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "new-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v1:acme:week": JSON.stringify(oldPayload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      await cache.put("owner-activity:v1:acme:week", JSON.stringify(newPayload));
      return Response.json({
        output_text: "Acme worked on old activity.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v1:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.events[0]?.id, "new");
    assert.equal(cached.summary?.state, "warming");
    assert.equal(cached.summary?.inputHash, "new-hash");
    assert.equal(cached.summary?.text, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached owner activity summaries from older prompt versions", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "event",
        kind: "commit",
        title: "Improve working-on summaries",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "@acme's public GitHub activity has centered on ReleaseBar.",
      generatedAt,
      model: "gpt-5.5",
      inputHash: "old-prompt-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v1:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      return Response.json({
        output_text: "@acme's public GitHub activity refined working-on summaries.",
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v1:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "ready");
    assert.equal(cached.summary?.promptVersion, 2);
    assert.equal(cached.summary?.model, "chat-latest");
    assert.notEqual(cached.summary?.inputHash, "old-prompt-hash");
    assert.equal(cached.summary?.text, "@acme's work refined working-on summaries.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not summarize empty owner activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 0,
      commits: 0,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 0,
    },
    repositories: [],
    events: [],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "empty-hash",
      eventsUsed: 0,
    },
  };
  const cache = kvStore({
    "owner-activity:v1:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v1:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "unavailable");
    assert.equal(cached.summary?.message, "Not enough recent work to summarize.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker persists public owner activity summary failures", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "event",
        kind: "commit",
        title: "Add activity summary",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "activity-hash",
      eventsUsed: 1,
    },
  };
  const cache = kvStore({
    "owner-activity:v1:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      return Response.json({ error: { message: "summary unavailable" } }, { status: 500 });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v1:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    assert.equal(cached.summary?.state, "unavailable");
    assert.equal(cached.summary?.model, "chat-latest");
    assert.match(cached.summary?.message ?? "", /summary unavailable/);
    assert.notEqual(cached.summary?.inputHash, "activity-hash");
    assert.equal(cached.summary?.promptVersion, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail routes for repositories named activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/activity",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "activity",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = kvStore({
    "repo-detail:v4:acme/activity": JSON.stringify(payload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/activity"),
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.fullName, "acme/activity");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker skips stale release summaries when repository detail changed", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 1,
      commitsUsed: 0,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const latestPayload: RepoDetailPayload = {
    ...payload,
    project: {
      ...payload.project,
      version: "v1.0.1",
      latestCommitSha: "fedcba9",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.1",
      headSha: "fedcba9",
      commitCount: 1,
      commitsUsed: 0,
    },
  };
  const cache = kvStore({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      return Response.json({
        total_commits: 1,
        commits: [{ commit: { message: "Add stale summary guard" } }],
      });
    }
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
      await cache.put("repo-detail:v4:acme/releasebar", JSON.stringify(latestPayload));
      return Response.json({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "ReleaseBar added a stale summary guard.",
              },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", OPENAI_API_KEY: "openai-token" },
      { waitUntil: (promise) => queued.push(promise) },
    );
    assert.equal(response.status, 200);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    assert.equal(cached.project.version, "v1.0.1");
    assert.equal(cached.project.latestCommitSha, "fedcba9");
    assert.equal(cached.releaseSummary?.releaseTag, "v1.0.1");
    assert.equal(cached.releaseSummary?.text, null);
    assert.notEqual(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:chat-latest"),
      null,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects private repository detail payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/private") {
      return Response.json({
        owner: { login: "acme" },
        name: "private",
        full_name: "acme/private",
        private: true,
        html_url: "https://github.com/acme/private",
        description: null,
        default_branch: "main",
        language: null,
        topics: [],
        stargazers_count: 0,
        forks_count: 0,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/private"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    const body = (await response.json()) as { error?: string };
    assert.equal(response.status, 502);
    assert.match(body.error ?? "", /private repositories are not visible/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when pull request count fails", async () => {
  const originalFetch = globalThis.fetch;
  let failPulls = true;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/retrybar") {
      return Response.json({
        owner: { login: "acme" },
        name: "retrybar",
        full_name: "acme/retrybar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/retrybar",
        description: "Retry dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/retrybar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/retrybar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/retrybar/pulls") {
      if (failPulls) {
        return Response.json(
          { message: "rate limit exceeded", documentation_url: "https://docs.github.com/rest" },
          { status: 403, headers: { "retry-after": "60" } },
        );
      }
      return Response.json([{}], {
        headers: {
          link: '<https://api.github.com/repositories/2/pulls?state=open&per_page=1&page=3>; rel="last"',
        },
      });
    }
    if (path === "/repos/acme/retrybar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/retrybar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/retrybar/stats/code_frequency") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const failed = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(failed.status, 429);

    failPulls = false;
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/retrybar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.openPullRequests, 3);
    assert.equal(body.project.openIssues, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns 404 for missing repository detail pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/missing") {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/missing"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 404);
    assert.match(await response.text(), /GitHub API 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores optional repository detail permission gaps", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/limitedbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "limitedbar",
        full_name: "acme/limitedbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/limitedbar",
        description: "Limited dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/limitedbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/contributors") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/limitedbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/limitedbar/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/commits/1234567890/check-runs") {
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    if (path === "/repos/acme/limitedbar/stats/commit_activity") {
      return Response.json([]);
    }
    if (path === "/repos/acme/limitedbar/stats/code_frequency") {
      return Response.json(
        { message: "repository must have fewer than 10000 commits" },
        { status: 422 },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/limitedbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.project.ciState, "unknown");
    assert.equal(body.cache.state, "fresh");
    assert.equal(body.stats?.codeFrequency.state, "unavailable");
    assert.match(body.stats?.codeFrequency.message ?? "", /fewer than 10000 commits/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker backs off repository stats per repo after one warming response", async () => {
  const originalFetch = globalThis.fetch;
  let codeFrequencyCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/warmstats") {
      return Response.json({
        owner: { login: "acme" },
        name: "warmstats",
        full_name: "acme/warmstats",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/warmstats",
        description: "Stats warming",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/warmstats/releases") return Response.json([]);
    if (path === "/repos/acme/warmstats/contributors") return Response.json([]);
    if (path === "/repos/acme/warmstats/languages") return Response.json({});
    if (path === "/repos/acme/warmstats/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/warmstats/pulls") return Response.json([]);
    if (path === "/repos/acme/warmstats/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/warmstats/stats/commit_activity") {
      return new Response(null, { status: 202 });
    }
    if (path === "/repos/acme/warmstats/stats/code_frequency") {
      codeFrequencyCalls += 1;
      return Response.json([]);
    }
    if (path === "/search/issues") {
      return Response.json({ total_count: 0 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmstats"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.cache.state, "warming");
    assert.equal(body.stats?.commitActivity.state, "warming");
    assert.equal(body.stats?.codeFrequency.state, "warming");
    assert.equal(codeFrequencyCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not cache repository detail when optional calls are rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/slowbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "slowbar",
        full_name: "acme/slowbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/slowbar",
        description: "Slow dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/slowbar/releases") {
      return Response.json([]);
    }
    if (path === "/repos/acme/slowbar/contributors") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "retry-after": "60" } },
      );
    }
    if (path === "/repos/acme/slowbar/languages") {
      return Response.json({});
    }
    if (path === "/repos/acme/slowbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/slowbar/pulls") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/slowbar"),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail when work trend search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/trendbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "trendbar",
        full_name: "acme/trendbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/trendbar",
        description: "Trend dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/trendbar/releases") return Response.json([]);
    if (path === "/repos/acme/trendbar/contributors") return Response.json([]);
    if (path === "/repos/acme/trendbar/languages") return Response.json({});
    if (path === "/repos/acme/trendbar/commits/main") {
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/trendbar/pulls") return Response.json([]);
    if (path === "/repos/acme/trendbar/commits/1234567890/check-runs") {
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/trendbar/stats/commit_activity") return Response.json([]);
    if (path === "/repos/acme/trendbar/stats/code_frequency") return Response.json([]);
    if (path === "/search/issues") {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/trendbar"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as RepoDetailPayload;
    assert.equal(body.workTrend, null);
    assert.notEqual(await cache.get("repo-detail:v4:acme/trendbar"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reuses repository detail auxiliary caches across rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  const calls = new Map<string, number>();
  const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/cachebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "cachebar",
        full_name: "acme/cachebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/cachebar",
        description: "Cached detail dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 20,
        forks_count: 1,
        open_issues_count: 4,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/cachebar/releases") {
      count("releases");
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: "v1.0.0",
          draft: false,
          prerelease: false,
          published_at: "2026-05-15T12:00:00Z",
          html_url: "https://github.com/acme/cachebar/releases/tag/v1.0.0",
        },
      ]);
    }
    if (path === "/repos/acme/cachebar/commits/main") {
      count("latest_commit");
      return Response.json({
        sha: "1234567890",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (path === "/repos/acme/cachebar/pulls") {
      count("open_pulls");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/compare/v1.0.0...main") {
      count("compare");
      return Response.json({
        html_url: "https://github.com/acme/cachebar/compare/v1.0.0...main",
        ahead_by: 0,
        total_commits: 0,
        commits: [],
      });
    }
    if (path === "/repos/acme/cachebar/commits/1234567890/check-runs") {
      count("check_runs");
      return Response.json({ check_runs: [] });
    }
    if (path === "/repos/acme/cachebar/contributors") {
      count("contributors");
      return Response.json([]);
    }
    if (path === "/repos/acme/cachebar/languages") {
      count("languages");
      return Response.json({ TypeScript: 100 });
    }
    if (path === "/repos/acme/cachebar/stats/commit_activity") {
      count("commit_activity");
      return new Response("", { status: 202 });
    }
    if (path === "/repos/acme/cachebar/stats/code_frequency") {
      count("code_frequency");
      return new Response("", { status: 202 });
    }
    if (path === "/search/issues") {
      count(`search:${url.searchParams.get("q") ?? ""}`);
      return Response.json({ total_count: 1 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const request = new Request("https://release.bar/api/repos/acme/cachebar");
    const first = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(first.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal([...calls.keys()].filter((key) => key.startsWith("search:")).length, 4);

    await cache.delete("repo-detail:v4:acme/cachebar");

    const second = await worker.fetch(
      request,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(second.status, 202);
    assert.equal(calls.get("releases"), 1);
    assert.equal(calls.get("latest_commit"), 1);
    assert.equal(calls.get("open_pulls"), 1);
    assert.equal(calls.get("compare"), 1);
    assert.equal(calls.get("check_runs"), 1);
    assert.equal(calls.get("contributors"), 1);
    assert.equal(calls.get("languages"), 1);
    assert.equal(calls.get("commit_activity"), 1);
    assert.equal(calls.get("code_frequency") ?? 0, 0);
    assert.equal([...calls.keys()].filter((key) => key.startsWith("search:")).length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns metadata before release hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const repoNode = (issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: "Manual refresh repo",
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [] },
    stargazerCount: 42,
    forkCount: 2,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    releases: {
      nodes: [
        {
          tagName: "v1.0.0",
          name: null,
          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          isDraft: false,
          publishedAt: "2026-05-01T00:00:00Z",
        },
      ],
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode(9, 4)],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.equal(body.cache?.progress?.done, false);
    assert.match(body.cache?.message ?? "", /issue and PR counts refreshed/);
    assert.equal(body.projects[0]?.openIssues, 9);
    assert.equal(body.projects[0]?.openPullRequests, 4);
    assert.equal(body.projects[0]?.version, "repo search");

    const repeated = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(repeated.status, 202);
    const repeatedBody = (await repeated.json()) as DashboardPayload;
    assert.match(repeatedBody.cache?.message ?? "", /manual refresh recently started/);
    assert.equal(repeatedBody.projects[0]?.openIssues, 9);

    await Promise.all(waits);
    const cached = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.cache?.state, "fresh");
    assert.equal(hydrated.projects[0]?.version, "v1.0.0");
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns structured GitHub errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.match(body.cache?.message ?? "", /GitHub shared API quota is exhausted/);

    const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 5 });
    const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
    dashboard.generatedAt = new Date().toISOString();
    if (dashboard.cache && dashboard.options) {
      dashboard.cache.generatedAt = dashboard.generatedAt;
      dashboard.options.includeUnreleased = true;
    }
    const cache = kvStore({ [key]: JSON.stringify(dashboard) });
    const cachedResponse = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(cachedResponse.status, 429);
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    assert.equal(cached.cache?.state, "fresh");
    assert.equal(cached.projects.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL backoff does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore({
    "github:backoff:v1:graphql:shared:_": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL upstream failure does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "upstream unavailable" },
        {
          status: 503,
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "800",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.deepEqual(paths, ["/users/owner", "/graphql"]);
    assert.ok(await cache.get("github:backoff:v1:graphql:shared:_"));
    assert.ok(await cache.get("github:budget:v1:shared:graphql"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves released-only cache while rebuilding", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "Released repo",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 42,
                  forkCount: 2,
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-05-15T00:00:00Z",
                  updatedAt: "2026-05-15T00:00:00Z",
                  releases: {
                    nodes: [
                      {
                        tagName: "v1.0.0",
                        name: null,
                        url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                        isDraft: false,
                        publishedAt: "2026-05-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: false, schemaVersion: 5 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const env = {
    DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0]?.version, "v1.0.0");
    assert.match(body.cache?.message ?? "", /release data updating/);

    await Promise.all(waits);
    const cached = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false"),
      env,
      { waitUntil: () => undefined },
    );
    const hydrated = (await cached.json()) as DashboardPayload;
    assert.equal(hydrated.projects[0]?.openIssues, 7);
    assert.equal(hydrated.projects[0]?.openPullRequests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects POST to reserved read-only owner-like APIs", async () => {
  for (const path of ["/api/me", "/api/_hot", "/api/_discover"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`, { method: "POST" }),
      {},
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 405, path);
  }
});

test("worker marks GitHub discovery hydration complete when release scan is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      return Response.json({
        total_count: 1,
        items: [
          {
            name: "releasebar",
            full_name: "acme/releasebar",
            private: false,
            fork: false,
            archived: false,
            html_url: "https://github.com/acme/releasebar",
            description: "Release dashboard",
            default_branch: "main",
            language: "TypeScript",
            stargazers_count: 1200,
            forks_count: 42,
            open_issues_count: 7,
            pushed_at: "2026-05-16T12:00:00Z",
            updated_at: "2026-05-16T12:00:00Z",
            owner: { login: "acme" },
          },
        ],
      });
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const waitUntil: Promise<unknown>[] = [];
  const env = { DASHBOARD_CACHE: kvStore() };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntil.push(promise);
        },
      },
    );
    assert.equal(response.status, 200);
    await Promise.all(waitUntil.splice(0));
    const cached = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    const body = (await cached.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "fresh");
    assert.equal(body.cache?.progress?.done, true);
    assert.equal(body.projects[0]?.version, "repo search");
    assert.match(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker pauses shared quota after discovery secondary rate limits", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "You have exceeded a secondary rate limit" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "search",
        },
      },
    );
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 429);
    const cooldown = JSON.parse((await cache.get("github:budget:v1:shared:search")) ?? "{}") as {
      active?: boolean;
      resource?: string;
      reason?: string;
      resetAt?: string | null;
    };
    assert.equal(cooldown.active, true);
    assert.equal(cooldown.resource, "search");
    assert.equal(cooldown.reason, "rate limited status 403");
    assert.equal(typeof cooldown.resetAt, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker falls back to stale discovery cache when GitHub search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [testProject({ owner: "cached", name: "repo" })]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    }),
  };
  globalThis.fetch = async () =>
    Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "stale");
    assert.equal(body.projects[0]?.fullName, "cached/repo");
    assert.match(body.cache?.message ?? "", /cached search/);
    assert.doesNotMatch(body.cache?.message ?? "", /install the app/i);

    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=month"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    assert.equal(coldResponse.status, 429);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    assert.equal(coldBody.cache?.state, "error");
    assert.match(coldBody.cache?.message ?? "", /repository search quota is exhausted/);
    assert.doesNotMatch(coldBody.cache?.message ?? "", /install the app/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns dashboard-shaped rate-limit errors without raw GitHub JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/vincentkoc") {
      return Response.json(
        {
          message: "API rate limit exceeded for user ID 58493",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
          status: "403",
        },
        { status: 403 },
      );
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  const waits: Array<Promise<unknown>> = [];
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.equal(body.owners[0]?.login, "vincentkoc");
    assert.deepEqual(body.projects, []);
    assert.match(body.cache?.message ?? "", /shared API quota is exhausted/);
    assert.doesNotMatch(body.cache?.message ?? "", /58493|documentation_url|request ID/i);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    assert.equal(cached.status, 429);
    await cached.arrayBuffer();
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard build records GitHub quota headers", async () => {
  const resetAt = Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "installation-token",
    quotaSource: "app",
    quotaAccount: "owner",
    repoLimit: 200,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  });

  assert.equal(payload.cache?.quota?.source, "app");
  assert.equal(payload.cache?.quota?.account, "owner");
  assert.equal(payload.cache?.quota?.limit, 5000);
  assert.equal(payload.cache?.quota?.remaining, 4998);
  assert.equal(payload.cache?.quota?.resetAt, "2026-05-15T13:00:00.000Z");
  assert.equal(payload.cache?.quota?.resource, "graphql");
});

test("worker preserves cached quota metadata on fresh responses", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 5 });
  const dashboard = testDashboard("owner", []);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
    dashboard.cache.quota = {
      source: "app",
      account: "owner",
      limit: 5000,
      remaining: 4900,
      resetAt: "2026-05-15T13:00:00.000Z",
      resource: "graphql",
    };
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.cache?.state, "fresh");
  assert.equal(body.cache?.quota?.source, "app");
  assert.equal(body.cache?.quota?.remaining, 4900);
});

test("worker streams cached dashboard snapshots over owner events", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 5 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /owner\/repo/);
});

test("worker records dashboard stream sync audits", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 5 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const cache = kvStore({ [key]: JSON.stringify(dashboard) });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  await response.text();
  const events = await refreshAuditEvents(cache);
  assert.equal(
    events.some((event) => event.event === "dashboard_stream_start"),
    true,
  );
  const send = events.find((event) => event.event === "dashboard_stream_send");
  assert.equal(send?.status, "fresh");
  assert.equal(send?.projects, 1);
  const done = events.find((event) => event.event === "dashboard_stream_done");
  assert.equal(done?.events, 1);
});

test("worker keeps owner events working for the repos owner slug", async () => {
  const key = dashboardCacheKey({ owner: "repos", includeUnreleased: true, schemaVersion: 5 });
  const dashboard = testDashboard("repos", [testProject({ owner: "repos", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/events"),
    { DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }) },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: dashboard/);
  assert.match(text, /repos\/repo/);
});

test("worker returns rebuilding while another isolate owns the dashboard build lock", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: kvStore(),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not display dashboard data past the stale display window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/old") {
      return Response.json({ login: "old", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const key = dashboardCacheKey({ owner: "old", schemaVersion: 5 });
  const dashboard = testDashboard("old", [testProject({ owner: "old", name: "ancient" })]);
  dashboard.generatedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/old"),
      {
        DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(body.projects.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves partial cached sources while combined dashboard rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => new Response(null, { status: 409 }),
    }),
  };
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 5 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 5 });

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        DASHBOARD_CACHE: kvStore({
          [alphaKey]: JSON.stringify(
            testDashboard("alpha", [testProject({ owner: "alpha", name: "one" })]),
          ),
          [betaKey]: JSON.stringify(
            testDashboard("beta", [testProject({ owner: "beta", name: "two" })]),
          ),
        }),
        DASHBOARD_LOCKS: busyLocks,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    assert.deepEqual(body.projects.map((project) => project.fullName).sort(), [
      "alpha/one",
      "beta/two",
    ]);
    assert.equal(body.totals.repos, 2);
    assert.equal(repoFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker progressively resumes large owner dashboard builds from partial cache", async () => {
  const originalFetch = globalThis.fetch;
  const repos = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "big" },
      name,
      full_name: `big/${name}`,
      description: null,
      html_url: `https://github.com/big/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      fork: false,
      private: false,
    };
  });
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = { DASHBOARD_CACHE: kvStore() };

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/big") {
      return Response.json({ login: "big", type: "User" });
    }
    if (path === "/users/big/repos") {
      return Response.json(repos);
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/big/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/big/repo/compare",
      });
    }
    if (path.endsWith("/pulls")) {
      return Response.json([]);
    }
    if (path.endsWith("/check-runs")) {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const first = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const firstBody = (await first.json()) as DashboardPayload;
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(firstBody.cache?.state, "partial");
    assert.equal(firstBody.cache?.progress?.scanned, 12);
    assert.equal(firstBody.cache?.progress?.done, false);
    assert.equal(firstBody.projects.length, 25);
    assert.equal(
      firstBody.projects.filter((project) => project.version === "repo search").length,
      13,
    );

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const secondBody = (await second.json()) as DashboardPayload;
    assert.equal(secondBody.cache?.state, "fresh");
    assert.equal(secondBody.cache?.progress?.done, true);
    assert.equal(secondBody.projects.length, 25);
    assert.equal(
      secondBody.projects.filter((project) => project.version === "repo search").length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard build lock only releases the matching lease token", async () => {
  const storage = new Map<string, unknown>();
  const lock = new DashboardBuildLock(
    {
      storage: {
        async get<T>(key: string) {
          return storage.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          storage.set(key, value);
        },
        async delete(key: string) {
          return storage.delete(key);
        },
      },
    },
    {},
  );

  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    409,
  );

  storage.set("lock", { token: "first", expiresAt: Date.now() - 1 });
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/acquire", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  const secondExpiresAt = (storage.get("lock") as { expiresAt: number }).expiresAt;
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/refresh", {
          method: "POST",
          body: JSON.stringify({ token: "second" }),
        }),
      )
    ).status,
    204,
  );
  assert.equal((storage.get("lock") as { expiresAt: number }).expiresAt >= secondExpiresAt, true);
  assert.equal(
    (
      await lock.fetch(
        new Request("https://releasebar.internal/release", {
          method: "POST",
          body: JSON.stringify({ token: "first" }),
        }),
      )
    ).status,
    204,
  );
  assert.deepEqual(storage.get("lock"), {
    token: "second",
    expiresAt: (storage.get("lock") as { expiresAt: number }).expiresAt,
  });
});

test("worker rejects oversized custom source requests", async () => {
  const owners = Array.from({ length: 9 }, (_, index) => `owner-${index}`).join(",");
  const response = await worker.fetch(
    new Request(`https://release.bar/api/dashboard?owners=${owners}`),
    {},
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /too many custom sources/);
});

test("worker exposes GitHub App auth endpoints", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const context = { waitUntil: () => undefined };

  const anonymous = await worker.fetch(new Request("https://release.bar/api/me"), env, context);
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await anonymous.json(), {
    configured: true,
    quotaConfigured: false,
    user: null,
    installations: [],
    installNeeded: false,
    installReason: null,
    loginUrl: "https://release.bar/api/auth/login",
    logoutUrl: "https://release.bar/api/auth/logout",
    installUrl: "https://release.bar/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
  });

  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw?owners=steipete"),
    env,
    context,
  );
  assert.equal(login.status, 302);
  const location = login.headers.get("location") ?? "";
  assert.equal(location.startsWith("https://github.com/login/oauth/authorize?"), true);
  assert.match(location, /client_id=Iv123/);
  assert.match(location, /redirect_uri=https%3A%2F%2Frelease.bar%2Fapi%2Fauth%2Fcallback/);
  assert.equal(new URL(location).searchParams.has("scope"), false);

  const badCallback = await worker.fetch(
    new Request("https://release.bar/api/auth/callback?code=x&state=bad"),
    env,
    context,
  );
  assert.equal(badCallback.status, 400);
  assert.equal((await env.DASHBOARD_CACHE.list({ prefix: "auth:funnel:v1:" })).keys.length, 0);

  const install = await worker.fetch(
    new Request("https://release.bar/api/auth/install?returnTo=/openclaw"),
    env,
    context,
  );
  assert.equal(install.status, 302);
  assert.equal(
    install.headers.get("location"),
    "https://github.com/apps/releasebar-app/installations/new",
  );
});

test("worker remembers GitHub App installs without OAuth session", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/openclaw",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore();
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/77") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 77,
        account: {
          login: "openclaw",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/2",
          html_url: "https://github.com/openclaw",
        },
        html_url: "https://github.com/organizations/openclaw/settings/installations/77",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=77&setup_action=install", {
        headers: { cookie: `rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(install.status, 302);
    assert.equal(install.headers.get("location"), "/openclaw");
    const remembered = JSON.parse((await cache.get("auth:installation:v1:openclaw")) ?? "{}");
    assert.equal(remembered.id, 77);
    assert.equal(remembered.accountLogin, "openclaw");
    assert.equal(remembered.repositorySelection, "all");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reports GitHub App installation coverage for signed-in users", async () => {
  const sessionId = "session-1";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.login, "octocat");
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.equal(body.quotaConfigured, true);
    assert.equal(body.installations[0].accountLogin, "openclaw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker detects the signed-in user's GitHub App install with app auth fallback", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-app-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 99,
          account: {
            login: "steipete",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1",
            html_url: "https://github.com/steipete",
          },
          html_url: "https://github.com/settings/installations/99",
          repository_selection: "all",
          target_type: "User",
        },
        {
          id: 100,
          account: {
            login: "someone-else",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/someone-else",
          },
          html_url: "https://github.com/settings/installations/100",
          repository_selection: "all",
          target_type: "User",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.deepEqual(
      body.installations.map((installation: { accountLogin: string }) => installation.accountLogin),
      ["steipete"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not prompt signed-in users to install the app for third-party repos", async () => {
  const sessionId = "session-third-party";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/-/f/prompts.chat", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.match(body.installReason, /shared API quota unless f\/prompts\.chat installs/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker still prompts signed-in users to install the app for owner dashboards", async () => {
  const sessionId = "session-owner-install";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, true);
    assert.match(body.installReason, /Install the GitHub App for @openclaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker remembers a just-completed GitHub App install while GitHub catches up", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-install-return";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/steipete",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/99") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 99,
        account: {
          login: "steipete",
          type: "User",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/steipete",
        },
        html_url: "https://github.com/settings/installations/99",
        repository_selection: "all",
        target_type: "User",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}; rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(install.status, 302);
    assert.equal(install.headers.get("location"), "/steipete");

    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    const acknowledgedAt = stored.installationsUpdatedAt;
    const remembered = stored.installations.find(
      (installation: { id: number }) => installation.id === 99,
    );
    assert.equal(remembered.accountLogin, "steipete");
    assert.equal(remembered.repositorySelection, "all");

    const me = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.installNeeded, false);
    assert.equal(body.installReason, null);
    assert.equal(
      body.installations.some(
        (installation: { accountLogin: string }) => installation.accountLogin === "steipete",
      ),
      true,
    );
    const afterMe = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    assert.equal(afterMe.installationsUpdatedAt, acknowledgedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores install callback acknowledgements without signed return state", async () => {
  const sessionId = "session-install-forged";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    assert.equal(stored.installations, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker records server-verified install callbacks without signed return state", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/101") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 101,
        account: {
          login: "outside-org",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/101",
          html_url: "https://github.com/outside-org",
        },
        html_url: "https://github.com/organizations/outside-org/settings/installations/101",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=101&setup_action=install"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/");
    const remembered = JSON.parse((await cache.get("auth:installation:v1:outside-org")) ?? "{}");
    assert.equal(remembered.id, 101);
    assert.equal(remembered.accountLogin, "outside-org");
    const events = await cache.list({ prefix: "auth:funnel:v1:" });
    assert.equal(events.keys.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only exposes public selected installation repositories", async () => {
  const sessionId = "session-public-repos";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "steipete",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/58493",
              html_url: "https://github.com/steipete",
            },
            html_url: "https://github.com/settings/installations/1",
            repository_selection: "selected",
            target_type: "User",
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/1/repositories") {
      return Response.json({
        repositories: [
          {
            full_name: "steipete/public-repo",
            private: false,
            visibility: "public",
          },
          {
            full_name: "steipete/private-repo",
            private: true,
            visibility: "private",
          },
          {
            full_name: "steipete/contradictory-private-repo",
            private: true,
            visibility: "public",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/?repos=steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.installations[0].repositories, ["steipete/public-repo"]);
    assert.equal(body.installNeeded, false);

    const repoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(repoRoute.status, 200);
    const repoRouteBody = await repoRoute.json();
    assert.equal(repoRouteBody.installNeeded, false);

    const escapedRepoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/-/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(escapedRepoRoute.status, 200);
    const escapedRepoRouteBody = await escapedRepoRoute.json();
    assert.equal(escapedRepoRouteBody.installNeeded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker surfaces mixed-account dashboards as shared-quota", async () => {
  const sessionId = "session-2";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: ["openclaw", "steipete"].map((login, index) => ({
          id: index + 1,
          account: {
            login,
            type: index === 0 ? "Organization" : "User",
            avatar_url: `https://avatars.githubusercontent.com/u/${index + 2}`,
            html_url: `https://github.com/${login}`,
          },
          html_url: `https://github.com/settings/installations/${index + 1}`,
          repository_selection: "all",
          target_type: index === 0 ? "Organization" : "User",
        })),
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installNeeded, false);
    assert.match(body.installReason, /Mixed-account dashboards use shared API quota/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps signed-in mixed-account dashboards on shared release scans", async () => {
  const sessionId = "session-mixed-dashboard";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_TOKEN: "shared-token",
  };
  const graphqlIncludeReleases: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/users/steipete") {
      assert.equal(authorization, "Bearer shared-token");
      return Response.json({ login: "steipete", type: "User" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer shared-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { includeReleases?: boolean };
      };
      graphqlIncludeReleases.push(Boolean(body.variables?.includeReleases));
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4996",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.deepEqual(graphqlIncludeReleases, [true, true]);
    assert.equal(body.cache?.quota?.source, "shared");
    assert.equal(body.cache?.quota?.remaining, 4996);
    assert.doesNotMatch(body.cache?.message ?? "", /release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured owner dashboards metadata-only", async () => {
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const fetchedPaths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    fetchedPaths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "repo",
          full_name: "owner/repo",
          description: null,
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          language: "TypeScript",
          topics: ["releasebar"],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 2,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.deepEqual(fetchedPaths, ["/users/owner", "/users/owner/repos"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "cookie");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.equal(body.projects[0]?.commitsSinceRelease, null);
    assert.match(body.cache?.message ?? "", /release scan skipped/);
    assert.equal(await env.DASHBOARD_CACHE.get("hot:index:v3"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses GitHub App installation token for cold owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-3";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  let ownerResolvedWithInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      assert.equal(authorization, "Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4997",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, 4997);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered source-owned app tokens for anonymous owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const auditLogs: unknown[] = [];
  let ownerResolvedWithInstallationToken = false;
  console.log = (message?: unknown) => {
    if (typeof message === "string" && message.includes("github_token_use")) {
      auditLogs.push(JSON.parse(message));
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/1/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
        {
          headers: {
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4998",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    assert.equal(ownerResolvedWithInstallationToken, true);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    assert.equal(body.cache?.quota?.remaining, 4998);
    assert.equal(
      auditLogs.some(
        (entry) =>
          (entry as { event?: string; quota?: { source?: string; account?: string } }).event ===
            "github_token_use" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.source === "app" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.account ===
            "openclaw",
      ),
      true,
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker discovers and stores source-owned app installs for anonymous dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  console.log = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "openclaw",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/openclaw",
          },
          html_url: "https://github.com/organizations/openclaw/settings/installations/7",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.quota?.source, "app");
    assert.equal(body.cache?.quota?.account, "openclaw");
    const stored = JSON.parse((await cache.get("auth:installation:v1:openclaw")) ?? "{}");
    assert.equal(stored.id, 7);
    assert.equal(stored.repositorySelection, "all");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker saves owner public defaults and applies them to clean owner URLs", async () => {
  const sessionId = "session-profile";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/steipete") {
      return Response.json({ login: "steipete", type: "User" });
    }
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (path === "/users/steipete/repos") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo") {
      return Response.json({
        owner: { login: "openclaw" },
        name: "peekaboo",
        full_name: "openclaw/peekaboo",
        description: null,
        html_url: "https://github.com/openclaw/peekaboo",
        default_branch: "main",
        language: "Swift",
        stargazers_count: 5,
        forks_count: 0,
        open_issues_count: 0,
        archived: false,
        pushed_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        fork: false,
        private: false,
      });
    }
    if (path === "/repos/openclaw/peekaboo/releases") {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/openclaw/peekaboo/releases/tag/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (path === "/repos/openclaw/peekaboo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 2,
        html_url: "https://github.com/openclaw/peekaboo/compare/v1.0.0...main",
      });
    }
    if (path === "/repos/openclaw/peekaboo/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const save = await worker.fetch(
      new Request("https://release.bar/api/profile/steipete", {
        method: "POST",
        headers: {
          cookie: `rd_session=${authCookie}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          includeRepos: ["openclaw/peekaboo"],
          hiddenRepos: [],
        }),
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(save.status, 200);
    const saved = await save.json();
    assert.deepEqual(saved.profile.includeRepos, ["openclaw/peekaboo"]);

    const response = await worker.fetch(new Request("https://release.bar/api/steipete"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.profile?.owner, "steipete");
    assert.equal(body.projects[0]?.fullName, "openclaw/peekaboo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only lets the dashboard owner save public defaults", async () => {
  const sessionId = "session-profile-forbidden";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
  };
  const response = await worker.fetch(
    new Request("https://release.bar/api/profile/steipete", {
      method: "POST",
      headers: {
        cookie: `rd_session=${authCookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ includeRepos: ["openclaw/peekaboo"] }),
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 403);
});

test("worker logout deletes the stored session and clears the cookie", async () => {
  const sessionId = "session-logout";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/logout?returnTo=/openclaw", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/openclaw");
  assert.match(response.headers.get("set-cookie") ?? "", /rd_session=;.*Max-Age=0/);
  assert.equal(await cache.get(`auth:session:${sessionId}`), null);
});

test("worker login returns 503 when GitHub App is not configured", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/login"),
    { DASHBOARD_CACHE: kvStore() },
    { waitUntil: () => undefined },
  );
  assert.equal(response.status, 503);
});

test("worker admin scheduler requires an admin session and reports refresh targets", async () => {
  const sessionId = "session-admin";
  const otherSessionId = "session-admin-other";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const otherAuthCookie = await signedJson("test-secret", { id: otherSessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const activeJob: RefreshJob = {
    id: "job-active",
    targetKey: target.key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T12:59:00Z",
    updatedAt: "2026-05-15T12:59:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const accessHour = new Date().toISOString().slice(0, 13);
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`auth:session:${otherSessionId}`]: JSON.stringify({
      user: {
        id: 2,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/2",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    [`refresh:job:v1:${activeJob.id}`]: JSON.stringify(activeJob),
    "refresh:jobs:index:v1": JSON.stringify([activeJob.id]),
    [`github:access:v1:${accessHour}:dashboard:shared:_:graphql:200:graphql`]: JSON.stringify({
      area: "dashboard",
      route: "graphql",
      status: 200,
      source: "shared",
      account: null,
      resource: "graphql",
      count: 3,
      lastPath: "/graphql",
      lastAt: `${accessHour}:00:00.000Z`,
    }),
  });
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const anonymous = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler"),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(anonymous.status, 401);

  const nonAdmin = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${otherAuthCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(nonAdmin.status, 403);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as SchedulerAdminPayload;
  assert.equal(body.status.targets, 1);
  assert.equal(body.status.dueTargets, 0);
  assert.equal(body.status.queuedJobs, 1);
  assert.equal(body.targets[0]?.owner, "openclaw");
  assert.equal(body.githubAccess.total, 3);
  assert.equal(body.githubAccess.topRoutes[0]?.route, "graphql");

  const access = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(access.status, 200);
  const accessBody = (await access.json()) as { total?: number };
  assert.equal(accessBody.total, 3);

  const run = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(run.status, 200);
  const runBody = (await run.json()) as { enqueued: number; due: number };
  assert.equal(runBody.enqueued, 0);
  assert.equal(runBody.due, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker admin installation sync removes stale registry entries", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:stale-org": JSON.stringify({
      id: 7,
      accountLogin: "stale-org",
      accountType: "org",
      accountUrl: "https://github.com/stale-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 11,
          account: {
            login: "fresh-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/fresh-org",
          },
          html_url: "https://github.com/organizations/fresh-org/settings/installations/11",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { count?: number };
    assert.equal(body.count, 1);
    assert.equal(await cache.get("auth:installation:v1:stale-org"), null);
    const fresh = JSON.parse((await cache.get("auth:installation:v1:fresh-org")) ?? "{}");
    assert.equal(fresh.id, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps registry when GitHub listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:known-org": JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 400);
    assert.notEqual(await cache.get("auth:installation:v1:known-org"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps selected repos when repository listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-selected-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:known-org": JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "selected",
      repositories: ["known-org/releasebar"],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "known-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/7",
            html_url: "https://github.com/known-org",
          },
          html_url: "https://github.com/organizations/known-org/settings/installations/7",
          repository_selection: "selected",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/installation/repositories") {
      assert.equal(authorization, "Bearer installation-token");
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(response.status, 400);
    const preserved = JSON.parse((await cache.get("auth:installation:v1:known-org")) ?? "{}");
    assert.deepEqual(preserved.repositories, ["known-org/releasebar"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin scheduler counts missing caches as due even before nextDueAt", async () => {
  const sessionId = "session-admin-due";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as SchedulerAdminPayload;
  assert.equal(body.status.dueTargets, 1);
});

test("worker scheduler skips shared cold targets while GraphQL is backed off", async () => {
  const sessionId = "session-admin-graphql-backoff";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=backedoff",
    kind: "dashboard",
    owner: "backedoff",
    owners: ["backedoff"],
    repos: [],
    includeReleaseData: false,
    path: "/backedoff",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    "github:backoff:v1:graphql:shared:_": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  const sentJobs: RefreshJob[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker scheduler keeps dormant shared targets on weekly cadence after success", async () => {
  const sessionId = "session-admin-dormant-shared-cadence";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const key = dashboardCacheKey({
    owner: "sleepy",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 5,
  });
  const lastRefreshAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "sleepy",
    owners: ["sleepy"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: lastRefreshAt,
    lastSuccessAt: lastRefreshAt,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [key]: JSON.stringify(testDashboard("sleepy", [])),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker scheduler still rebuilds missing dormant shared caches", async () => {
  const sessionId = "session-admin-dormant-shared-missing";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=sleepy-missing",
    kind: "dashboard",
    owner: "sleepy-missing",
    owners: ["sleepy-missing"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy-missing",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    lastSuccessAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs.length, 1);
});

test("worker admin GitHub access ignores expired shared quota cooldowns", async () => {
  const sessionId = "session-admin-expired-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { active?: boolean } };
  assert.equal(body.cooldown?.active, false);
  assert.equal(await cache.get("github:budget:v1:shared:_"), null);
});

test("worker admin GitHub access keeps longest active shared quota cooldown", async () => {
  const sessionId = "session-admin-longest-cooldown";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 10,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "shorter",
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "3000-01-01T00:00:00.000Z",
      reason: "longer",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { cooldown?: { resource?: string | null } };
  assert.equal(body.cooldown?.resource, "graphql");
});

test("worker admin scheduler defers shared quota paused targets even with missing cache", async () => {
  const sessionId = "session-admin-shared-quota-defer";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 0);
  assert.equal(body.enqueued, 0);
  assert.deepEqual(sentJobs, []);
});

test("worker admin scheduler lets app-token targets bypass shared quota pauses", async () => {
  const sessionId = "session-admin-shared-quota-app-bypass";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    "auth:installation-token:42": "installation-token",
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler uses app registry coverage without minting tokens", async () => {
  const sessionId = "session-admin-shared-quota-app-registry";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker admin scheduler bypasses shared quota defer time with app coverage", async () => {
  const sessionId = "session-admin-shared-quota-app-stale";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: "2026-05-15T13:00:00Z",
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { due: number; enqueued: number };
  assert.equal(body.due, 1);
  assert.equal(body.enqueued, 1);
  assert.equal(sentJobs[0]?.reason, "app-quota");
});

test("worker scheduler marks jobs failed when queue delivery fails", async () => {
  const sessionId = "session-admin-queue-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v5:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });

  await assert.rejects(
    worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send() {
            throw new Error("queue unavailable");
          },
        },
      },
      { waitUntil: () => undefined },
    ),
    /queue unavailable/,
  );

  const ids = JSON.parse((await cache.get("refresh:jobs:index:v1")) ?? "[]") as string[];
  assert.equal(ids.length, 1);
  const stored = JSON.parse((await cache.get(`refresh:job:v1:${ids[0]}`)) ?? "{}") as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.match(stored.error ?? "", /queue unavailable/);
});

test("worker refresh jobs can use shared quota when no source app token exists", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer shared-token");
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "succeeded");
  const auditEvents = await refreshAuditEvents(cache);
  assert.equal(
    auditEvents.some((event) => event.event === "job_start"),
    true,
  );
  assert.equal(
    auditEvents.some((event) => event.event === "dashboard_build_start"),
    true,
  );
  const buildDone = auditEvents.find((event) => event.event === "dashboard_build_done");
  assert.equal(buildDone?.status, "fresh");
  assert.equal(buildDone?.projects, 0);
  assert.deepEqual(paths, ["/users/openclaw", "/graphql"]);
});

test("worker refresh jobs defer shared work while shared quota is paused", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared-paused",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 42,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "remaining 42 <= 500",
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("shared quota pause should skip GitHub fetches");
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "skipped");
  assert.match(updated.error ?? "", /remaining 42/);
  const storedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.match(storedTarget.message ?? "", /shared GitHub quota paused/);
});

test("worker refresh jobs defer shared work while GraphQL is backed off", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared-graphql-paused",
    targetKey: key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
    "github:backoff:v1:graphql:shared:_": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("GraphQL backoff should skip GitHub fetches");
  };
  let acked = false;
  try {
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              ack(): void;
              retry(options?: { delaySeconds?: number }): void;
            }>;
          },
          env: unknown,
          context: unknown,
        ): Promise<void>;
      }
    ).queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(acked, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "skipped");
  assert.match(updated.error ?? "", /GraphQL temporarily paused/);
  const storedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(storedTarget.failureCount, 0);
  assert.match(storedTarget.message ?? "", /GitHub GraphQL paused/);
});

test("worker skips request-triggered progressive rebuilds while shared quota is paused", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 42,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "remaining 42 <= 500",
    }),
  });
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("shared quota pause should skip progressive GitHub fetches");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    assert.equal(waits.length > 0, true);
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_progressive_skip"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cached dashboards to crawlers without scheduling refreshes", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 5,
  });
  const dashboard: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    generatedAt: "2026-05-15T12:00:00Z",
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: 200,
    },
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: "2026-05-15T12:00:00Z",
      progress: {
        scanned: 1,
        limit: 200,
        done: false,
      },
    },
  };
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
  });
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  let installationListCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([
        {
          id: 7,
          account: {
            login: "owner",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/7",
            html_url: "https://github.com/owner",
          },
          html_url: "https://github.com/settings/installations/7",
          repository_selection: "all",
          target_type: "User",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "installation-token" });
    }
    throw new Error(`crawler should not refresh dashboard ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/owner", "AhrefsBot/7.0", null),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "partial");
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_refresh_schedule"),
      false,
    );
    assert.equal(installationListCalls, 0);
    assert.equal(await cache.get(`refresh:target:v1:${key}`), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves cache-only cold dashboard status to crawlers", async () => {
  const key = dashboardCacheKey({
    owner: "coldbot",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 5,
  });
  const baseCache = kvStore({
    "auth:installation:v1:coldbot": JSON.stringify({
      id: 42,
      accountLogin: "coldbot",
      accountType: "org",
      accountUrl: "https://github.com/coldbot",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
  });
  let installationTokenReads = 0;
  const cache = {
    ...baseCache,
    async get(key: string) {
      if (key.startsWith("auth:installation-token:")) installationTokenReads += 1;
      return baseCache.get(key);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler cold dashboard should not call GitHub ${String(input)}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/coldbot", "Googlebot/2.1", null),
      { DASHBOARD_CACHE: cache, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "invalid" },
      {
        waitUntil: (promise) => waits.push(promise),
      },
    );
    assert.equal(response.status, 202);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "rebuilding");
    assert.equal(body.cache?.message, "cached dashboard unavailable for crawler");
    assert.equal(await cache.get(key), null);
    assert.equal(installationTokenReads, 0);
    await Promise.all(waits);
    const events = await refreshAuditEvents(cache);
    assert.equal(
      events.some((event) => event.event === "dashboard_refresh_schedule"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not pause shared quota for ordinary forbidden responses", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "Resource not accessible by integration" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "core",
        },
      },
    );
  try {
    await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await cache.get("github:budget:v1:shared:_"), null);
    assert.equal(await cache.get("github:budget:v1:shared:core"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safeReturnTo accepts the current request origin, including workers.dev", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const ctx = { waitUntil: () => undefined };

  const workersDevLogin = await worker.fetch(
    new Request(
      "https://releasedeck-api.steipete.workers.dev/api/auth/login?returnTo=https%3A%2F%2Freleasedeck-api.steipete.workers.dev%2Fopenclaw",
    ),
    env,
    ctx,
  );
  assert.equal(workersDevLogin.status, 302);
  assert.match(
    workersDevLogin.headers.get("location") ?? "",
    /redirect_uri=https%3A%2F%2Freleasedeck-api.steipete.workers.dev%2Fapi%2Fauth%2Fcallback/,
  );

  const evilOriginLogout = await worker.fetch(
    new Request(
      "https://release.bar/api/auth/logout?returnTo=https%3A%2F%2Fevil.example.com%2Fattack",
    ),
    env,
    ctx,
  );
  assert.equal(evilOriginLogout.headers.get("location"), "/");
});

test("worker reuses cached installation tokens", async () => {
  const sessionId = "session-token-cache";
  const accountLogin = "cacheorg";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
      "auth:installation-token:1": "installation-token",
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  let tokenMintCalled = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: accountLogin,
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: `https://github.com/${accountLogin}`,
            },
            html_url: `https://github.com/organizations/${accountLogin}/settings/installations/1`,
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      tokenMintCalled = true;
      throw new Error("cached installation token should be reused");
    }
    if (url.pathname === `/users/${accountLogin}`) {
      return Response.json({ login: accountLogin, type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    if (url.pathname === `/orgs/${accountLogin}/repos`) {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const headers = { cookie: `rd_session=${authCookie}` };
    const waits: Array<Promise<unknown>> = [];
    const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
    const first = await worker.fetch(
      new Request(`https://release.bar/api/${accountLogin}`, { headers }),
      env,
      context,
    );
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    await Promise.all(waits);
    assert.equal(tokenMintCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("query options are explicit booleans", () => {
  assert.deepEqual(optionsFromSearch("?forks=true&archived=false&unreleased=true"), {
    includeForks: true,
    includeArchived: false,
    includeUnreleased: true,
  });
  assert.deepEqual(optionsFromSearch("?unreleased=false"), {
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
  });
  assert.equal(optionsFromSearch("").includeUnreleased, true);
});

test("build option normalization preserves config includeUnreleased", () => {
  const options = normalizeBuildOptions({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
  });

  assert.equal(options.includeUnreleased, true);
  assert.equal(
    normalizeBuildOptions({ ...options, includeUnreleased: undefined }).includeUnreleased,
    false,
  );
});

test("cache keys include owner, schema, and visibility flags", () => {
  assert.equal(
    dashboardCacheKey({
      owner: "@OpenClaw",
      includeForks: true,
      includeArchived: false,
      includeUnreleased: true,
      schemaVersion: 5,
    }),
    "dashboard:v5:openclaw:forks-noarchived-unreleased-release",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 5,
    }),
    "dashboard:v5:openclaw:noforks-noarchived-released-release:sources-2dgec2fqc87xi",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      includeReleaseData: false,
      schemaVersion: 5,
    }),
    "dashboard:v5:openclaw:noforks-noarchived-released-metadata",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: Array.from({ length: 50 }, (_, index) => `owner-${index}`),
      repos: Array.from({ length: 50 }, (_, index) => `owner-${index}/repo-${index}`),
    }).length < 512,
    true,
  );
});

test("owner slugs match public GitHub login rules", () => {
  assert.equal(validOwnerSlug("steipete"), true);
  assert.equal(validOwnerSlug("openclaw"), true);
  assert.equal(validOwnerSlug("-bad"), false);
  assert.equal(validOwnerSlug("bad-"), false);
  assert.equal(validOwnerSlug("bad_owner"), false);
  assert.equal(validRepoSlug("steipete/oracle"), true);
  assert.equal(validRepoSlug("bad_owner/oracle"), false);
});

test("owner resolution keeps GitHub profile identity", async () => {
  const owner = await resolveOwnerType("OpenClaw", {
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/users/openclaw");
      return Response.json({
        login: "OpenClaw",
        type: "Organization",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
        html_url: "https://github.com/openclaw",
      });
    },
  });

  assert.deepEqual(owner, {
    type: "org",
    login: "OpenClaw",
    avatarUrl: "https://avatars.githubusercontent.com/u/123",
    url: "https://github.com/openclaw",
  });
});

test("repo filtering respects forks, archived repos, private repos, and excludes", () => {
  const repo = {
    full_name: "owner/repo",
    fork: false,
    archived: false,
    private: false,
  };
  assert.equal(filterRepo(repo, { includeForks: false, includeArchived: false }), true);
  assert.equal(
    filterRepo({ ...repo, fork: true }, { includeForks: false, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, archived: true }, { includeForks: true, includeArchived: false }),
    false,
  );
  assert.equal(
    filterRepo({ ...repo, private: true }, { includeForks: true, includeArchived: true }),
    false,
  );
  assert.equal(
    filterRepo(repo, {
      includeForks: true,
      includeArchived: true,
      excludeRepos: ["owner/repo"],
    }),
    false,
  );
});

test("freshness buckets remain compatible with existing dashboard semantics", () => {
  const project = { commitsSinceRelease: null };
  assert.equal(freshness(project), "hot");
  assert.equal(freshness({ ...project, commitsSinceRelease: 0 }), "fresh");
  assert.equal(freshness({ ...project, commitsSinceRelease: 5 }), "warm");
  assert.equal(freshness({ ...project, commitsSinceRelease: 25 }), "busy");
  assert.equal(freshness({ ...project, commitsSinceRelease: 26 }), "hot");
});

test("dashboard build skips empty unreleased repositories without failing", async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "empty",
          full_name: "owner/empty",
          description: null,
          html_url: "https://github.com/owner/empty",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        },
      ]);
    }
    if (path === "/repos/owner/empty/releases") {
      return Response.json([]);
    }
    if (path === "/repos/owner/empty/commits/main") {
      return new Response("empty repository", { status: 409 });
    }
    throw new Error(`unexpected ${path}`);
  };

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    fetch: fetcher,
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build treats empty successful GitHub JSON as no data", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeRepos: ["other/repo"],
    includeForks: false,
    includeArchived: false,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/other/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path === "/repos/other/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/other/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/other/repo/compare/v1.0.0...main",
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return new Response("", { status: 200 });
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openPullRequests, 0);
});

test("dashboard build falls back when GraphQL returns an empty success body", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") return new Response("", { status: 200 });
      if (path === "/users/owner/repos") return Response.json([]);
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
});

test("dashboard build treats ignored 403 check-run rate limits as quota errors", async () => {
  await assert.rejects(
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json([
            {
              owner: { login: "owner" },
              name: "repo",
              full_name: "owner/repo",
              description: null,
              html_url: "https://github.com/owner/repo",
              default_branch: "main",
              language: null,
              stargazers_count: 0,
              forks_count: 0,
              open_issues_count: 0,
              archived: false,
              pushed_at: null,
              updated_at: null,
              fork: false,
              private: false,
            },
          ]);
        }
        if (path === "/repos/owner/repo/releases") {
          return Response.json([
            {
              tag_name: "v1.0.0",
              name: null,
              html_url: "https://github.com/owner/repo/releases/v1.0.0",
              draft: false,
              published_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        if (path === "/repos/owner/repo/commits/main") {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/pulls") {
          return Response.json([]);
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          return Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
              },
            },
          );
        }
        throw new Error(`unexpected ${path}`);
      },
    }),
    GitHubRateLimitError,
  );
});

test("dashboard build can add explicit public repositories without an owner scan", async () => {
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/repo"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/repo") {
        return Response.json({
          owner: { login: "other" },
          name: "repo",
          full_name: "other/repo",
          description: null,
          html_url: "https://github.com/other/repo",
          default_branch: "main",
          language: null,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: false,
        });
      }
      if (path === "/repos/other/repo/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/other/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path === "/repos/other/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path === "/repos/other/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/other/repo/compare/v1.0.0...main",
        });
      }
      if (path === "/repos/other/repo/pulls") {
        return Response.json([]);
      }
      if (path === "/repos/other/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.fullName, "other/repo");
});

test("dashboard build uses GraphQL owner metadata when token is available", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 2,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                          {
                            __typename: "CheckRun",
                            name: "lint",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/2",
                            completedAt: "2026-01-03T00:11:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    owner: { login: "owner", __typename: "User" },
                    name: "repo",
                    nameWithOwner: "owner/repo",
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
                    isArchived: false,
                    isFork: false,
                    isPrivate: false,
                    pushedAt: "2026-01-03T00:00:00Z",
                    updatedAt: "2026-01-03T00:00:00Z",
                    releases: {
                      nodes: [
                        {
                          tagName: "v2.0.0-alpha.1",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v2.0.0-alpha.1",
                          isDraft: false,
                          publishedAt: "2026-01-04T00:00:00Z",
                        },
                        {
                          tagName: "v1.0.0",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                          isDraft: false,
                          publishedAt: "2026-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/repo/compare/v2.0.0-alpha.1...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v2.0.0-alpha.1...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openIssues, 7);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.projects[0]?.version, "v2.0.0-alpha.1");
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "2/2 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/releases")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/pulls")),
    false,
  );
});

test("dashboard released-only build uses GraphQL detail hydration for CI", async () => {
  const requested: string[] = [];
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init.body ?? "{}")) as { query?: string };
        if (body.query?.includes("ReleaseBarRepoDetails")) {
          return Response.json({
            data: {
              r0: {
                nameWithOwner: "owner/repo",
                defaultBranchRef: {
                  name: "main",
                  target: {
                    oid: "abcdef123456",
                    committedDate: "2026-01-03T00:00:00Z",
                    statusCheckRollup: {
                      state: "SUCCESS",
                      contexts: {
                        totalCount: 1,
                        nodes: [
                          {
                            __typename: "CheckRun",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                            completedAt: "2026-01-03T00:10:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          });
        }
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    owner: { login: "owner", __typename: "User" },
                    name: "repo",
                    nameWithOwner: "owner/repo",
                    description: "GraphQL repo",
                    url: "https://github.com/owner/repo",
                    defaultBranchRef: {
                      name: "main",
                      target: {
                        oid: "abcdef123456",
                        committedDate: "2026-01-03T00:00:00Z",
                      },
                    },
                    primaryLanguage: { name: "TypeScript" },
                    stargazerCount: 42,
                    forkCount: 2,
                    issues: { totalCount: 7 },
                    pullRequests: { totalCount: 3 },
                    isArchived: false,
                    isFork: false,
                    isPrivate: false,
                    pushedAt: "2026-01-03T00:00:00Z",
                    updatedAt: "2026-01-03T00:00:00Z",
                    releases: {
                      nodes: [
                        {
                          tagName: "v1.0.0",
                          name: null,
                          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                          isDraft: false,
                          publishedAt: "2026-01-01T00:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/repo/compare/v1.0.0...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.version, "v1.0.0");
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.projects[0]?.ciWorkflow, "1/1 checks");
  assert.equal(
    requested.some((path) => path.includes("/commits/main")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/check-runs")),
    false,
  );
});

test("dashboard build emits owner metadata before release hydration", async () => {
  const progress: Awaited<ReturnType<typeof buildDashboard>>[] = [];
  const requested: string[] = [];
  const repoNode = (name: string, issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name,
    nameWithOwner: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: `2026-01-0${issues}T00:00:00Z`,
    updatedAt: `2026-01-0${issues}T00:00:00Z`,
    releases: { nodes: [] },
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 3,
    repoScanLimit: 1,
    repoScanTarget: 3,
    hydrateSort: "prs",
    hydrateDirection: "desc",
    token: "token",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      requested.push(path);
      if (path === "/graphql") {
        return Response.json({
          data: {
            repositoryOwner: {
              __typename: "User",
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [repoNode("three", 3, 0), repoNode("one", 5, 2), repoNode("two", 4, 1)],
              },
            },
          },
        });
      }
      if (path === "/repos/owner/one/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-04T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
    onProgress: (partial) => {
      progress.push(partial);
    },
  });

  assert.equal(progress[0]?.projects.length, 3);
  assert.deepEqual(
    progress[0]?.projects.map((project) => [
      project.name,
      project.openIssues,
      project.openPullRequests,
      project.version,
    ]),
    [
      ["one", 5, 2, "repo search"],
      ["two", 4, 1, "repo search"],
      ["three", 3, 0, "repo search"],
    ],
  );
  assert.equal(progress[0]?.cache?.progress?.scanned, 0);
  assert.equal(requested.includes("/repos/owner/one/commits/main"), true);
  assert.equal(requested.includes("/repos/owner/three/commits/main"), false);
  assert.equal(payload.cache?.state, "partial");
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two", "three"],
  );
});

test("dashboard cached hydration keeps fresh owner issue and PR totals", async () => {
  const cache = kvStore();
  let openIssues = 1;
  let openPullRequests = 1;
  const repoNode = () => ({
    owner: { login: "owner", __typename: "User" },
    name: "one",
    nameWithOwner: "owner/one",
    description: null,
    url: "https://github.com/owner/one",
    defaultBranchRef: { name: "main" },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    stargazerCount: 0,
    forkCount: 0,
    issues: { totalCount: openIssues },
    pullRequests: { totalCount: openPullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    releases: { nodes: [] },
  });
  const fetch: typeof globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode()],
            },
          },
        },
      });
    }
    if (path === "/repos/owner/one/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-01-02T00:00:00Z" } },
      });
    }
    if (path === "/repos/owner/one/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const options = {
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user" as const, login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 1,
    repoScanLimit: 1,
    repoScanTarget: 1,
    token: "token",
    projectCache: cache,
    fetch,
  };

  await buildDashboard(options);
  openIssues = 8;
  openPullRequests = 5;
  const payload = await buildDashboard(options);

  assert.equal(payload.projects[0]?.openIssues, 8);
  assert.equal(payload.projects[0]?.openPullRequests, 5);
});

test("dashboard build reuses cached repo fragments when metadata is unchanged", async () => {
  const cache = kvStore();
  let fanoutCalls = 0;
  const build = () =>
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 1,
      token: "token",
      projectCache: cache,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/graphql") {
          return Response.json({
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      owner: { login: "owner", __typename: "User" },
                      name: "repo",
                      nameWithOwner: "owner/repo",
                      description: null,
                      url: "https://github.com/owner/repo",
                      defaultBranchRef: { name: "main" },
                      primaryLanguage: null,
                      stargazerCount: 1,
                      forkCount: 0,
                      issues: { totalCount: 0 },
                      pullRequests: { totalCount: 0 },
                      isArchived: false,
                      isFork: false,
                      isPrivate: false,
                      pushedAt: "2026-01-03T00:00:00Z",
                      updatedAt: "2026-01-03T00:00:00Z",
                      releases: {
                        nodes: [
                          {
                            tagName: "v1.0.0",
                            name: null,
                            url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                            isDraft: false,
                            publishedAt: "2026-01-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          });
        }
        if (path === "/repos/owner/repo/commits/main") {
          fanoutCalls += 1;
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-03T00:00:00Z" } },
          });
        }
        if (path === "/repos/owner/repo/compare/v1.0.0...main") {
          fanoutCalls += 1;
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
          });
        }
        if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
          fanoutCalls += 1;
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build()).totals.repos, 1);
  assert.equal((await build()).totals.repos, 1);
  assert.equal(fanoutCalls, 3);
});

test("dashboard build ignores explicit private repositories", async () => {
  let releaseFetched = false;
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["other/private"],
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/other/private") {
        return Response.json({
          owner: { login: "other" },
          name: "private",
          full_name: "other/private",
          description: null,
          html_url: "https://github.com/other/private",
          default_branch: "main",
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: null,
          updated_at: null,
          fork: false,
          private: true,
        });
      }
      if (path === "/repos/other/private/releases") {
        releaseFetched = true;
        return Response.json([]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 0);
  assert.equal(releaseFetched, false);
});

test("dashboard cache cap only marks omitted repos as capped", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const build = (repos: unknown[]) =>
    buildDashboard({
      title: "ReleaseBar",
      subtitle: "test",
      canonicalDomain: "example.com",
      owners: [{ type: "user", login: "owner" }],
      includeForks: false,
      includeArchived: false,
      repoLimit: 2,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/users/owner/repos") {
          return Response.json(repos);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
          return Response.json([
            {
              tag_name: "v1.0.0",
              name: null,
              html_url: "https://github.com/owner/repo/releases/v1.0.0",
              draft: false,
              published_at: "2026-01-01T00:00:00Z",
            },
          ]);
        }
        if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
          return Response.json({
            sha: "abcdef123456",
            commit: { committer: { date: "2026-01-02T00:00:00Z" } },
          });
        }
        if (path.includes("/compare/")) {
          return Response.json({
            total_commits: 0,
            html_url: "https://github.com/owner/repo/compare",
          });
        }
        if (path.endsWith("/pulls")) {
          return Response.json([]);
        }
        if (path.endsWith("/check-runs")) {
          return Response.json({ check_runs: [] });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

  assert.equal((await build([repo("one"), repo("two")])).cache?.capped, false);
  assert.equal((await build([repo("one"), repo("two"), repo("three")])).cache?.capped, true);
});

test("explicit repositories survive capped owner scan trimming", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeRepos: ["owner/three"],
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      if (path === "/repos/owner/three") {
        return Response.json(repo("three"));
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.startsWith("/repos/owner/") && path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(
    payload.projects.some((project) => project.fullName === "owner/three"),
    true,
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies after visibility filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("fork", { fork: true }),
          repo("archived", { archived: true }),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies per owner for custom dashboards", async () => {
  const repo = (owner: string, name: string) => ({
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    description: null,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [
      { type: "user", login: "owner" },
      { type: "org", login: "other" },
    ],
    includeForks: false,
    includeArchived: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("owner", "one"), repo("owner", "two"), repo("owner", "three")]);
      }
      if (path === "/orgs/other/repos") {
        return Response.json([
          repo("other", "alpha"),
          repo("other", "beta"),
          repo("other", "gamma"),
        ]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const fullNames = payload.projects.map((project) => project.fullName);
  assert.equal(payload.totals.repos, 4);
  assert.equal(fullNames.includes("owner/one"), true);
  assert.equal(fullNames.includes("owner/two"), true);
  assert.equal(fullNames.includes("owner/three"), false);
  assert.equal(fullNames.includes("other/alpha"), true);
  assert.equal(fullNames.includes("other/beta"), true);
  assert.equal(fullNames.includes("other/gamma"), false);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo cap applies to visible rows before release hydration", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: name === "empty-a" ? 3 : 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const released = new Set(["one", "two", "three"]);

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("empty-a"),
          repo("empty-b"),
          repo("empty-c"),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      const name = path.split("/")[3];
      if (path.endsWith("/releases")) {
        return Response.json(
          released.has(name)
            ? [
                {
                  tag_name: "v1.0.0",
                  name: null,
                  html_url: "https://github.com/owner/repo/releases/v1.0.0",
                  draft: false,
                  published_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json(name === "empty-a" ? [{}] : []);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({
          check_runs:
            name === "empty-a"
              ? [
                  {
                    name: "ci",
                    status: "completed",
                    conclusion: "success",
                    html_url: "https://github.com/owner/empty-a/actions/runs/1",
                    completed_at: "2026-01-02T00:00:00Z",
                    started_at: "2026-01-02T00:00:00Z",
                  },
                ]
              : [],
        });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["unreleased", "unreleased"],
  );
  assert.equal(payload.projects[0]?.latestCommitSha, "abcdef1");
  assert.equal(payload.projects[0]?.openIssues, 2);
  assert.equal(payload.projects[0]?.openPullRequests, 1);
  assert.equal(payload.projects[0]?.ciState, "success");
  assert.equal(payload.cache?.capped, true);
});

test("dashboard released-only repo cap scans past unreleased repositories", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const released = new Set(["one", "two", "three"]);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    repoLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([
          repo("empty-a"),
          repo("empty-b"),
          repo("empty-c"),
          repo("one"),
          repo("two"),
          repo("three"),
        ]);
      }
      const name = path.split("/")[3];
      if (path.endsWith("/releases")) {
        return Response.json(
          released.has(name)
            ? [
                {
                  tag_name: "v1.0.0",
                  name: null,
                  html_url: `https://github.com/owner/${name}/releases/v1.0.0`,
                  draft: false,
                  published_at: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.totals.unreleased, 0);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap stops giant owners after recent repos", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const releaseFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("empty-a"), repo("empty-b"), repo("released")]);
      }
      if (path.endsWith("/releases")) {
        releaseFetches.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(releaseFetches, ["empty-a", "empty-b"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["empty-a", "empty-b"],
  );
  assert.equal(payload.totals.repos, 2);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 2 recently pushed repos/);
});

test("dashboard metadata-only mode skips release hydration", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const unexpectedHydrationFetches: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/users/owner/repos") {
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      unexpectedHydrationFetches.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(unexpectedHydrationFetches, []);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.deepEqual(
    payload.projects.map((project) => project.version),
    ["repo search", "repo search"],
  );
  assert.equal(payload.projects[0]?.commitsSinceRelease, null);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard metadata-only released-only mode keeps released-only semantics", async () => {
  const fetchedPaths: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: false,
    includeReleaseData: false,
    repoLimit: 2,
    repoScanLimit: 2,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      fetchedPaths.push(path);
      return Response.json([]);
    },
  });

  assert.deepEqual(fetchedPaths, []);
  assert.deepEqual(payload.projects, []);
  assert.equal(payload.totals.repos, 0);
  assert.equal(payload.totals.unreleased, 0);
  assert.match(payload.cache?.message ?? "", /release scan skipped/);
});

test("dashboard shared owner page cap finishes as fresh capped data", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    fork: false,
    private: false,
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    quotaSource: "shared",
    repoLimit: 400,
    repoScanLimit: 0,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        const page = parsed.searchParams.get("page") ?? "";
        pages.push(page);
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`page-${page}-${index}`)),
        );
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1", "2", "3"]);
  assert.equal(payload.cache?.state, "fresh");
  assert.equal(payload.cache?.progress?.done, undefined);
  assert.equal(payload.cache?.capped, true);
});

test("dashboard repo scan cap marks full page boundary truncation as capped", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 200,
    repoScanLimit: 100,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        return Response.json(Array.from({ length: 100 }, (_, index) => repo(`empty-${index}`)));
      }
      if (path.endsWith("/releases")) {
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(payload.totals.repos, 100);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 100 recently pushed repos/);
});

test("dashboard resume stops paging when visible cap is already scanned", async () => {
  const repo = (name: string) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
  });
  const project = (
    name: string,
  ): Awaited<ReturnType<typeof buildDashboard>>["projects"][number] => ({
    owner: "owner",
    name,
    fullName: `owner/${name}`,
    description: null,
    url: `https://github.com/owner/${name}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 0,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/owner/${name}/issues`,
    pullRequestsUrl: `https://github.com/owner/${name}/pulls`,
    archived: false,
    pushedAt: null,
    updatedAt: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `https://github.com/owner/${name}/releases`,
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
  });
  const pages: string[] = [];

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    repoLimit: 2,
    repoScanLimit: 2,
    repoScanTarget: 2,
    initialProjects: [project("one"), project("two")],
    skipRepos: ["owner/one", "owner/two"],
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/users/owner/repos") {
        pages.push(parsed.searchParams.get("page") ?? "");
        return Response.json([repo("one"), repo("two"), repo("three")]);
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1"]);
  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one", "two"],
  );
  assert.equal(payload.cache?.progress?.done, true);
});

test("dashboard repo cap keeps paginating until eligible repos survive filters", async () => {
  const repo = (name: string, overrides = {}) => ({
    owner: { login: "owner" },
    name,
    full_name: `owner/${name}`,
    description: null,
    html_url: `https://github.com/owner/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: null,
    updated_at: null,
    fork: false,
    private: false,
    ...overrides,
  });

  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    repoLimit: 1,
    fetch: async (url) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      const page = parsed.searchParams.get("page");
      if (path === "/users/owner/repos" && page === "1") {
        return Response.json(
          Array.from({ length: 100 }, (_, index) => repo(`fork-${index}`, { fork: true })),
        );
      }
      if (path === "/users/owner/repos" && page === "2") {
        return Response.json([repo("one"), repo("two")]);
      }
      if (path.endsWith("/releases")) {
        return Response.json([
          {
            tag_name: "v1.0.0",
            name: null,
            html_url: "https://github.com/owner/repo/releases/v1.0.0",
            draft: false,
            published_at: "2026-01-01T00:00:00Z",
          },
        ]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-02T00:00:00Z" } },
        });
      }
      if (path.includes("/compare/")) {
        return Response.json({
          total_commits: 0,
          html_url: "https://github.com/owner/repo/compare",
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(
    payload.projects.map((project) => project.name),
    ["one"],
  );
  assert.equal(payload.cache?.capped, true);
});
