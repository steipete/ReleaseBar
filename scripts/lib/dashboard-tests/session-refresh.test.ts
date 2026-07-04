import assert from "node:assert/strict";
import test from "node:test";
import worker from "../../../worker/index.js";
import { kvStore, signedJson } from "../dashboard-test-harness.js";

const context = { waitUntil: () => undefined };

function sessionEnv(cache: ReturnType<typeof kvStore>) {
  return {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
}

function installationPayload(id: number, login: string, type: "User" | "Organization") {
  return {
    id,
    account: {
      login,
      type,
      avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
      html_url: `https://github.com/${login}`,
    },
    html_url: `https://github.com/settings/installations/${id}`,
    repository_selection: "all",
    target_type: type,
  };
}

function storedInstallation(id: number, login: string, type: "user" | "org") {
  // Key order matches githubInstallations so unchanged lists compare equal.
  return {
    id,
    accountLogin: login,
    accountType: type,
    accountUrl: `https://github.com/${login}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}`,
    repositorySelection: "all",
    repositories: [],
  };
}

const octocat = {
  id: 1,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/1",
  url: "https://github.com/octocat",
};

test("worker refreshes expired GitHub user tokens instead of losing them", async () => {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = "session-refresh";
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: octocat,
      accessToken: "stale-token",
      accessTokenExp: now - 10,
      refreshToken: "refresh-1",
      refreshTokenExp: now + 3600,
      iat: now - 9 * 3600,
      exp: now + 86400,
    }),
  });
  const env = sessionEnv(cache);
  const authCookie = await signedJson("test-secret", { id: sessionId, exp: now + 86400 });
  // Rotated grants must survive a transient KV write failure (1-write/sec/key limit).
  let failedRotationWrites = 0;
  const basePut = cache.put.bind(cache);
  cache.put = async (key: string, value: string) => {
    if (key.startsWith("auth:session:") && failedRotationWrites === 0) {
      failedRotationWrites += 1;
      throw new Error("simulated KV write rate limit");
    }
    return basePut(key, value);
  };

  let refreshCalls = 0;
  const installationTokens: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
      assert.equal(body.grant_type, "refresh_token");
      assert.equal(body.refresh_token, "refresh-1");
      refreshCalls += 1;
      return Response.json({
        access_token: "fresh-token",
        expires_in: 28800,
        refresh_token: "refresh-2",
        refresh_token_expires_in: 15552000,
        token_type: "bearer",
        scope: "",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      installationTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ installations: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      context,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { user: { login: string } | null };
    assert.equal(body.user?.login, "octocat");
    assert.equal(refreshCalls, 1);
    assert.deepEqual(installationTokens, ["Bearer fresh-token"]);
    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}") as {
      accessToken: string;
      accessTokenExp: number;
      refreshToken: string;
      refreshTokenExp: number;
    };
    assert.equal(stored.accessToken, "fresh-token");
    assert.equal(stored.refreshToken, "refresh-2");
    assert.equal(stored.accessTokenExp >= now + 28700, true);
    assert.equal(stored.refreshTokenExp >= now + 15551900, true);
    assert.equal(failedRotationWrites, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps sessions logged in across redundant or failing KV writes", async () => {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = "session-write-limits";
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: octocat,
      accessToken: "user-token",
      iat: now - 3600,
      exp: now + 86400,
      installations: [storedInstallation(77, "octocat", "user")],
      installationsUpdatedAt: new Date((now - 3600) * 1000).toISOString(),
    }),
  });
  const env = sessionEnv(cache);
  const authCookie = await signedJson("test-secret", { id: sessionId, exp: now + 86400 });
  const sessionPuts: string[] = [];
  const registryPuts: string[] = [];
  const basePut = cache.put.bind(cache);
  cache.put = async (key: string, value: string) => {
    if (key.startsWith("auth:session:")) {
      sessionPuts.push(key);
      throw new Error("simulated KV write rate limit");
    }
    if (key.startsWith("auth:installation:v1:")) registryPuts.push(key);
    return basePut(key, value);
  };

  let liveInstallations = [installationPayload(77, "octocat", "User")];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({ installations: liveInstallations });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const request = () =>
      worker.fetch(
        new Request("https://release.bar/api/me", {
          headers: { cookie: `rd_session=${authCookie}` },
        }),
        env,
        context,
      );

    // Unchanged installation list: /api/me must not rewrite the session key at all.
    const unchanged = await request();
    assert.equal(unchanged.status, 200);
    const unchangedBody = (await unchanged.json()) as { user: { login: string } | null };
    assert.equal(unchangedBody.user?.login, "octocat");
    assert.equal(sessionPuts.length, 0);

    // Changed list with a failing KV write: still logged in, write attempted once.
    liveInstallations = [
      installationPayload(77, "octocat", "User"),
      installationPayload(88, "clawtopia", "Organization"),
    ];
    const degraded = await request();
    assert.equal(degraded.status, 200);
    const degradedBody = (await degraded.json()) as {
      user: { login: string } | null;
      installations: unknown[];
    };
    assert.equal(degradedBody.user?.login, "octocat");
    assert.equal(degradedBody.installations.length, 2);
    assert.equal(sessionPuts.length, 1);
    // Fresh, unchanged registry entries are not rewritten on the second /api/me call.
    assert.deepEqual(registryPuts.sort(), [
      "auth:installation:v1:clawtopia",
      "auth:installation:v1:octocat",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker stores refresh grants during the OAuth callback", async () => {
  const cache = kvStore();
  const env = sessionEnv(cache);
  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw"),
    env,
    context,
  );
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({
        access_token: "user-token",
        expires_in: 28800,
        refresh_token: "refresh-1",
        refresh_token_expires_in: 15552000,
        token_type: "bearer",
        scope: "",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: 1,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/octocat",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const callback = await worker.fetch(
      new Request(
        `https://release.bar/api/auth/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookie } },
      ),
      env,
      context,
    );
    assert.equal(callback.status, 302);
    const sessionKeys = (await cache.list({ prefix: "auth:session:" })).keys;
    assert.equal(sessionKeys.length, 1);
    const stored = JSON.parse((await cache.get(sessionKeys[0]?.name ?? "")) ?? "{}") as {
      accessToken: string;
      accessTokenExp?: number;
      refreshToken?: string;
      refreshTokenExp?: number;
    };
    assert.equal(stored.accessToken, "user-token");
    assert.equal(typeof stored.accessTokenExp, "number");
    assert.equal(stored.refreshToken, "refresh-1");
    assert.equal(typeof stored.refreshTokenExp, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
