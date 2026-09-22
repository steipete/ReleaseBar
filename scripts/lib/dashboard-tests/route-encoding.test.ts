import assert from "node:assert/strict";
import test from "node:test";
import { ownerActivityFromPath, ownerFromPath, repoFromPath } from "../../../src/routing.js";
import worker from "../../../worker/index.js";
import { kvStore } from "../dashboard-test-harness.js";

test("page route parsers reject malformed percent encoding", () => {
  for (const invalid of ["%", "%GG", "%C0%AF", "%E0%A4%A"]) {
    assert.equal(ownerFromPath(`/${invalid}`), null);
    assert.equal(repoFromPath(`/acme/${invalid}`), null);
    assert.equal(repoFromPath(`/-/${invalid}/project`), null);
    assert.equal(ownerActivityFromPath(`/${invalid}/activity`), null);
    assert.equal(ownerActivityFromPath(`/-/owners/${invalid}/activity`), null);
  }
  assert.equal(ownerFromPath("/%40Acme"), "Acme");
  assert.equal(repoFromPath("/acme/%70roject")?.fullName, "acme/project");
  assert.equal(ownerActivityFromPath("/%61cme/activity")?.owner, "acme");
});

test("worker rejects malformed path encoding before storage or background work", async () => {
  const cache = kvStore();
  const env = {
    DASHBOARD_CACHE: {
      ...cache,
      get: async () => assert.fail("invalid paths must not read storage"),
    },
    ASSETS: { fetch: async () => assert.fail("invalid paths must not fetch assets") },
  };
  const context = { waitUntil: () => assert.fail("invalid paths must not schedule work") };
  const paths = [
    "/%",
    "/acme/%GG",
    "/-/acme/%E0%A4%A",
    "/%C0%AF/activity",
    "/api/%",
    "/api/%/activity",
    "/api/repos/acme/%",
    "/api/repos/%/project/activity",
    "/api/repos/acme/%/audience",
    "/api/users/%/trust",
    "/og/%.svg",
    "/og/%.png",
  ];
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request(`https://release.bar${path}`, { method }),
        env,
        context,
      );
      assert.equal(response.status, 400, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method === "HEAD") assert.equal(await response.text(), "");
      else assert.deepEqual(await response.json(), { error: "invalid path encoding" });
    }
  }
});
