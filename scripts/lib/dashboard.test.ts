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
  resolveOwnerType,
  validOwnerSlug,
  validRepoSlug,
} from "./dashboard.js";
import {
  dashboardRoute,
  ownerDashboardPath,
  optionsFromSearch,
  ownerFromPath,
  repoDetailPath,
  repoFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../../src/routing.js";
import {
  attentionReasons,
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
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../../src/types.js";
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
  assert.match(html, /openclaw\/react\.dev · release\.bar/);
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

  const repoResponse = await worker.fetch(
    new Request("https://release.bar/og/acme%2Freleasebar.svg"),
    env,
    { waitUntil: () => undefined },
  );
  assert.equal(repoResponse.status, 200);
  const repoSvg = await repoResponse.text();
  assert.match(repoSvg, /acme\/releasebar/);
  assert.match(repoSvg, /v2\.0\.0 · 42 commits since release/);
  assert.match(repoSvg, /https:\/\/github\.com\/acme\.png\?size=240/);

  const ownerResponse = await worker.fetch(
    new Request("https://release.bar/og/openclaw.svg"),
    env,
    { waitUntil: () => undefined },
  );
  const ownerSvg = await ownerResponse.text();
  assert.match(ownerSvg, /@openclaw/);
  assert.match(ownerSvg, /https:\/\/github\.com\/openclaw\.png\?size=240/);

  const coldStore = kvStore();
  const originalFetch = globalThis.fetch;
  const coldCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
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
  globalThis.fetch = async () => {
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
  let repoCalls = 0;
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
    repoCalls += 1;
    const repoMatch = url.pathname.match(/^\/repos\/acme\/([^/]+)$/);
    if (repoMatch) {
      const repoName = repoMatch[1] ?? "releasebar";
      return Response.json({
        owner: { login: "acme" },
        name: repoName,
        full_name: `acme/${repoName}`,
        description: "Release dashboard",
        html_url: `https://github.com/acme/${repoName}`,
        default_branch: "main",
        language: "TypeScript",
        topics: ["releases", "dashboard"],
        stargazers_count: 1200,
        forks_count: 42,
        open_issues_count: 9,
        archived: false,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
        fork: false,
        private: false,
      });
    }
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/releases$/)) {
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
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/commits\/main$/)) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-16T12:00:00Z" } },
      });
    }
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/compare\/v1\.2\.3\.\.\.main$/)) {
      return Response.json({
        total_commits: 5,
        html_url: "https://github.com/acme/releasebar/compare/v1.2.3...main",
      });
    }
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/pulls$/)) {
      return Response.json([{}]);
    }
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/commits\/abcdef123456\/check-runs$/)) {
      return Response.json({ check_runs: [] });
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
    assert.equal(firstBatch.cache?.progress?.scanned, 12);
    assert.equal(
      firstBatch.projects.filter((project) => project.version === "repo search").length,
      1,
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
    assert.equal(hydrated.projects[0]?.commitsSinceRelease, 5);
    assert.equal(hydrated.projects[0]?.openPullRequests, 1);
    assert.equal(searchCalls, 1);
    assert.equal(repoCalls > 0, true);
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

test("worker builds cached repository detail with releases and stats", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
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
        topics: ["release-health"],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
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
    DASHBOARD_CACHE: kvStore(),
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

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.equal(calls, 14);
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
    "dashboard:v5:openclaw:forks-noarchived-unreleased",
  );
  assert.equal(
    dashboardCacheKey({
      owner: "openclaw",
      owners: ["Steipete"],
      repos: ["Steipete/Oracle"],
      schemaVersion: 5,
    }),
    "dashboard:v5:openclaw:noforks-noarchived-released:sources-2dgec2fqc87xi",
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
