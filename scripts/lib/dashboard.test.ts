import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildDashboard,
  dashboardCacheKey,
  filterRepo,
  freshness,
  GitHubRateLimitError,
  normalizeBuildOptions,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard.js";
import {
  dashboardRoute,
  ownerDashboardPath,
  optionsFromSearch,
  ownerFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../src/routing.js";
import {
  parseViewState,
  sortProjects,
  viewStateSearch,
  type DashboardViewState,
} from "../../src/dashboard-view.js";
import type { DashboardPayload, Project } from "../../src/types.js";
import worker, { DashboardBuildLock } from "../../worker/index.js";

const textEncoder = new TextEncoder();

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
  assert.equal(
    dashboardRoute("/", "?period=day&lang=TypeScript").apiPath,
    `${workerApiOrigin}/api/_discover?period=day`,
  );
  assert.equal(dashboardRoute("/openclaw", "").apiPath, `${workerApiOrigin}/api/openclaw`);
  assert.equal(
    dashboardRoute("/openclaw", "?forks=true&archived=true&unreleased=true").apiPath,
    `${workerApiOrigin}/api/openclaw?forks=true&archived=true&unreleased=true`,
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
});

test("worker builds root hot dashboard from cached dashboards", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", schemaVersion: 4 });
  const betaKey = dashboardCacheKey({ owner: "beta", schemaVersion: 4 });
  const forksKey = dashboardCacheKey({ owner: "forks", includeForks: true, schemaVersion: 4 });
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
      [dashboardCacheKey({ owner: "gamma", schemaVersion: 4 })]: JSON.stringify(
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

test("worker serves cached GitHub discovery dashboards from repository search", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/search/repositories");
    assert.match(url.searchParams.get("q") ?? "", /language:"TypeScript"/);
    assert.match(url.searchParams.get("q") ?? "", /pushed:>=/);
    assert.equal(url.searchParams.get("sort"), "stars");
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer shared-token");
    return Response.json(
      {
        total_count: 2,
        incomplete_results: false,
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
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const first = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(first.status, 200);
    const body = (await first.json()) as DashboardPayload;
    assert.equal(body.title, "GitHub Hot");
    assert.equal(body.projects[0]?.fullName, "acme/releasebar");
    assert.equal(body.projects[0]?.version, "repo search");
    assert.equal(body.projects[0]?.openIssues, 7);
    assert.equal(body.cache?.quota?.remaining, 4999);
    assert.match(body.cache?.message ?? "", /repository search/);

    const second = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker falls back to stale discovery cache when GitHub search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [testProject({ owner: "cached", name: "repo" })]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v3:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: "2020-01-01T00:00:00Z",
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
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/vincentkoc"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(response.status, 429);
    const body = (await response.json()) as DashboardPayload;
    assert.equal(body.cache?.state, "error");
    assert.equal(body.owners[0]?.login, "vincentkoc");
    assert.deepEqual(body.projects, []);
    assert.match(body.cache?.message ?? "", /shared API quota is exhausted/);
    assert.doesNotMatch(body.cache?.message ?? "", /58493|documentation_url|request ID/i);

    const cached = await worker.fetch(new Request("https://release.bar/api/vincentkoc"), env, {
      waitUntil: () => undefined,
    });
    assert.equal(cached.status, 429);
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
  const key = dashboardCacheKey({ owner: "owner", schemaVersion: 4 });
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
  const body = (await response.json()) as DashboardPayload;
  assert.equal(body.cache?.state, "fresh");
  assert.equal(body.cache?.quota?.source, "app");
  assert.equal(body.cache?.quota?.remaining, 4900);
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
  const alphaKey = dashboardCacheKey({ owner: "alpha", schemaVersion: 4 });
  const betaKey = dashboardCacheKey({ owner: "beta", schemaVersion: 4 });

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

  const badCallback = await worker.fetch(
    new Request("https://release.bar/api/auth/callback?code=x&state=bad"),
    env,
    context,
  );
  assert.equal(badCallback.status, 400);

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

test("worker reuses cached installation tokens across requests", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-token-cache";
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
  let tokenMintCount = 0;
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
    if (url.pathname === "/app/installations/1/access_tokens") {
      tokenMintCount += 1;
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const headers = { cookie: `rd_session=${authCookie}` };
    await worker.fetch(new Request("https://release.bar/api/openclaw", { headers }), env, {
      waitUntil: () => undefined,
    });
    await worker.fetch(
      new Request("https://release.bar/api/openclaw?archived=true", { headers }),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(tokenMintCount, 1);
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
      schemaVersion: 4,
    }),
    "dashboard:v4:openclaw:forks-noarchived-unreleased",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 4,
    }),
    "dashboard:v4:openclaw:noforks-noarchived-released:sources-2dgec2fqc87xi",
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
    repoLimit: 1,
    token: "token",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      requested.push(`${path}${parsed.search}`);
      if (path === "/graphql") {
        assert.equal(init?.method, "POST");
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
                    defaultBranchRef: { name: "main" },
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
      if (path === "/repos/owner/repo/commits/main") {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-01-03T00:00:00Z" } },
        });
      }
      if (path === "/repos/owner/repo/compare/v2.0.0-alpha.1...main") {
        return Response.json({
          total_commits: 4,
          html_url: "https://github.com/owner/repo/compare/v2.0.0-alpha.1...main",
        });
      }
      if (path === "/repos/owner/repo/commits/abcdef123456/check-runs") {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.equal(payload.totals.repos, 1);
  assert.equal(payload.projects[0]?.openIssues, 7);
  assert.equal(payload.projects[0]?.openPullRequests, 3);
  assert.equal(payload.projects[0]?.version, "v2.0.0-alpha.1");
  assert.equal(
    requested.some((path) => path.includes("/releases")),
    false,
  );
  assert.equal(
    requested.some((path) => path.includes("/pulls")),
    false,
  );
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

test("dashboard repo cap applies after release eligibility", async () => {
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
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(releaseFetches, ["empty-a", "empty-b"]);
  assert.equal(payload.totals.repos, 0);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 2 recently pushed repos/);
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
      throw new Error(`unexpected ${path}`);
    },
  });

  assert.deepEqual(pages, ["1"]);
  assert.equal(payload.totals.repos, 0);
  assert.equal(payload.cache?.capped, true);
  assert.match(payload.cache?.message ?? "", /scanned 100 recently pushed repos/);
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
