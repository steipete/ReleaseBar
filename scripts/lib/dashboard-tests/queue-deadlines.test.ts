import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../../../src/types.js";
import worker from "../../../worker/index.js";
import {
  crawlerRequest,
  kvStore,
  refreshAuditEvents,
  signedJson,
  testDashboard,
  testProject,
} from "../dashboard-test-harness.js";

test("worker terminalizes exhausted refresh retries before dead-lettering", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
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
    id: "job-lock-exhausted",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const backingCache = kvStore({
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  let jobWrites = 0;
  const cache = {
    ...backingCache,
    async put(storageKey: string, value: string) {
      if (storageKey === `refresh:job:v1:${job.id}`) {
        jobWrites += 1;
      }
      await backingCache.put(storageKey, value);
    },
  };
  let released = false;
  const busyLocks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/acquire") {
          return new Response(null, { status: 409 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  };
  let retryDelaySeconds: number | undefined;

  const deliver = async (attempts: number) =>
    (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
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
            attempts,
            ack() {
              throw new Error("exhausted job should be retried into the DLQ");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: busyLocks },
      { waitUntil: () => undefined },
    );

  await deliver(9);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, false);
  const retrying = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(retrying.status, "queued");
  assert.equal(retrying.error, "dashboard locked");

  await deliver(10);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, false);
  const finalRetry = JSON.parse(
    (await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}",
  ) as RefreshJob;
  assert.equal(finalRetry.status, "queued");
  assert.equal(finalRetry.error, "dashboard locked");

  await deliver(11);
  assert.equal(retryDelaySeconds, 60);
  assert.equal(released, true);
  const updated = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(updated.status, "failed");
  assert.match(updated.error ?? "", /after 11 Queue attempts/);
  assert.equal(updated.attempts, 11);
  assert.equal(jobWrites, 3);

  const failedTarget = JSON.parse(
    (await cache.get(`refresh:target:v1:${target.key}`)) ?? "{}",
  ) as RefreshTarget;
  assert.equal(failedTarget.failureCount, 1);
  assert.equal(Date.parse(failedTarget.nextDueAt) > Date.now(), true);
  assert.equal(failedTarget.terminalBackoffUntil, failedTarget.nextDueAt);
  assert.match(failedTarget.message ?? "", /after 11 Queue attempts/);

  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  globalThis.fetch = async (input) => {
    throw new Error(`backed-off dashboard should not fetch ${String(input)}`);
  };
  try {
    const staleResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(staleResponse.status, 200);
    await Promise.all(waits.splice(0));
    assert.equal(sentJobs.length, 0);

    await cache.delete(key);
    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(coldResponse.status, 202);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    assert.equal(coldBody.cache?.state, "rebuilding");
    assert.match(coldBody.cache?.message ?? "", /refresh paused after repeated failures/);
    await Promise.all(waits);
    assert.equal(sentJobs.length, 0);

    await cache.put(
      `refresh:target:v1:${target.key}`,
      JSON.stringify({ ...failedTarget, terminalBackoffUntil: null }),
    );
    await cache.put(
      key,
      JSON.stringify(testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })])),
    );
    const transientFailureResponse = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        DASHBOARD_CACHE: cache,
        DASHBOARD_LOCKS: busyLocks,
        REFRESH_QUEUE: {
          async send(sent: RefreshJob) {
            sentJobs.push(sent);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    assert.equal(transientFailureResponse.status, 200);
    await Promise.all(waits.splice(0));
    assert.equal(sentJobs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker terminalizes final-delivery queue handler failures", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
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
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-handler-failure",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const backingCache = kvStore();
  let failJobRead = true;
  const cache = {
    ...backingCache,
    async get(key: string) {
      if (key === `refresh:job:v1:${job.id}` && failJobRead) {
        failJobRead = false;
        throw new Error("refresh job read failed");
      }
      return backingCache.get(key);
    },
  };
  let released = false;
  const locks = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/job/reserve") {
          return new Response(null, { status: 204 });
        }
        if (path === "/job/release") {
          released = true;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    }),
  };
  let retryDelaySeconds: number | undefined;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
            attempts?: number;
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
          attempts: 11,
          ack() {
            throw new Error("failed handler should not acknowledge");
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache, DASHBOARD_LOCKS: locks },
    { waitUntil: () => undefined },
  );

  assert.equal(retryDelaySeconds, 300);
  assert.equal(released, true);
  const stored = JSON.parse((await cache.get(`refresh:job:v1:${job.id}`)) ?? "{}") as RefreshJob;
  assert.equal(stored.status, "failed");
  assert.equal(stored.attempts, 11);
  assert.match(stored.error ?? "", /refresh job read failed/);
});

test("worker refresh jobs defer shared work while shared quota is paused", async () => {
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
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
    schemaVersion: 6,
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
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
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
    schemaVersion: 6,
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
    schemaVersion: 6,
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
    schemaVersion: 6,
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

test("safeReturnTo rejects a normalized protocol-relative path", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const ctx = { waitUntil: () => undefined };
  const returnTos = [
    "/x/..//evil.com",
    "/%2e%2e//evil.com",
    "https://release.bar//evil.com",
    "/%2f%2fevil.com",
  ];

  for (const returnTo of returnTos) {
    const response = await worker.fetch(
      new Request(`https://release.bar/api/auth/logout?returnTo=${encodeURIComponent(returnTo)}`),
      env,
      ctx,
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/", returnTo);
  }
});

test("worker refreshes stale installation coverage before using its cached token", async () => {
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
      [`auth:installation:v1:${accountLogin}`]: JSON.stringify({
        id: 1,
        accountLogin,
        accountType: "org",
        accountUrl: `https://github.com/${accountLogin}`,
        avatarUrl: "https://avatars.githubusercontent.com/u/2",
        repositorySelection: "all",
        repositories: [],
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
      "auth:installation-token:1": "installation-token",
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_APP_SLUG: "releasebar-app",
    REFRESH_QUEUE: { send: async () => undefined },
  };
  const originalFetch = globalThis.fetch;
  let tokenMintCalled = false;
  let userInstallationsCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      userInstallationsCalls += 1;
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
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer installation-token");
      return Response.json({ login: accountLogin, type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number };
      };
      assert.equal(body.variables?.first, 25);
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
    assert.equal(userInstallationsCalls, 1);

    const second = await worker.fetch(
      new Request(`https://release.bar/api/${accountLogin}`, { headers }),
      env,
      context,
    );
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    await Promise.all(waits);
    assert.equal(userInstallationsCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
