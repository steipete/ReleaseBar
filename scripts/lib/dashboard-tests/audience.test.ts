import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { AudienceRange, RepoAudiencePayload } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import { crawlerRequest, kvStore, signedJson } from "../dashboard-test-harness.js";

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
                    __typename: "User",
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "cabot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/13",
                    url: "https://github.com/cabot",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "quiet",
                    avatarUrl: "https://avatars.githubusercontent.com/u/11",
                    url: "https://github.com/quiet",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "Bot",
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
    if (path === "/users/cabot") {
      return Response.json({
        login: "cabot",
        avatar_url: "https://avatars.githubusercontent.com/u/13",
        html_url: "https://github.com/cabot",
        type: "User",
        name: "C. Abot",
        company: "GitHub",
        bio: "Principal engineer building developer tools",
        location: "San Francisco",
        blog: "https://cabot.dev",
        twitter_username: "cabot",
        followers: 5000,
        following: 50,
        public_repos: 80,
        public_gists: 2,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/cabot/orgs") {
      return Response.json([]);
    }
    if (path === "/users/cabot/repos") {
      return Response.json([]);
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
    const cabot = body.users.find((user) => user.login === "cabot");
    assert.notEqual(cabot?.tier, "bot");
    assert.ok((cabot?.score ?? 0) > 0);
    assert.equal(body.totals.stargazers, 1234);
    assert.equal(body.totals.highSignal, 1);
    assert.equal(body.totals.mediumSignal, 1);
    assert.equal(body.totals.bots, 1);
    assert.equal(body.totals.highSignalPercent, 25);
    assert.equal(body.totals.mediumSignalPercent, 25);
    assert.equal(body.totals.lowSignalPercent, 25);
    assert.equal(body.totals.botPercent, 25);
    assert.equal(body.cache.quota?.source, "shared");

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    assert.equal(cached.status, 200);
    assert.equal(calls, 12);
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
      info?: { version?: string };
      paths?: Record<string, unknown>;
      components?: {
        schemas?: {
          CacheState?: {
            properties?: Record<string, unknown>;
          };
          OwnerActivity?: unknown;
        };
      };
    };
    assert.equal(body.openapi, "3.1.0");
    assert.equal(body.info?.version, "0.2.3");
    assert.ok(body.paths?.["/api/{owner}/activity"]);
    assert.ok(body.paths?.["/api/users/{login}/trust"]);
    assert.ok(body.paths?.["/api/repos/{owner}/{repo}/audience"]);
    assert.ok(body.components?.schemas?.OwnerActivity);
    assert.ok(body.components?.schemas?.CacheState?.properties?.countsUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.releasesUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.ciUpdatedAt);
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
