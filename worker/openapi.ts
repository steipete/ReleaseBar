export function openApiSpec(origin: string): Record<string, unknown> {
  const cacheState = {
    type: "object",
    required: ["state", "stale", "generatedAt"],
    properties: {
      state: { enum: ["fresh", "stale", "partial", "warming", "error"] },
      stale: { type: "boolean" },
      generatedAt: { type: "string", format: "date-time" },
      countsUpdatedAt: { type: ["string", "null"], format: "date-time" },
      projectCountsUpdatedAt: {
        type: "object",
        additionalProperties: { type: "string", format: "date-time" },
      },
      releasesUpdatedAt: { type: ["string", "null"], format: "date-time" },
      ciUpdatedAt: { type: ["string", "null"], format: "date-time" },
      message: { type: "string" },
      quota: {
        type: "object",
        properties: {
          source: { enum: ["app", "shared", "anonymous"] },
          account: { type: ["string", "null"] },
          remaining: { type: ["number", "null"] },
          limit: { type: ["number", "null"] },
          resetAt: { type: ["string", "null"], format: "date-time" },
          resource: { type: ["string", "null"] },
        },
      },
    },
  };
  const trustFactor = {
    type: "object",
    required: [
      "key",
      "label",
      "value",
      "maxValue",
      "weight",
      "weightedValue",
      "detail",
      "sentiment",
    ],
    properties: {
      key: { enum: ["age", "profile", "orgs", "reach", "builder", "recency", "risk"] },
      label: { type: "string" },
      value: { type: "number" },
      maxValue: { type: "number" },
      weight: { type: "number" },
      weightedValue: { type: "number" },
      detail: { type: "string" },
      sentiment: { enum: ["positive", "neutral", "negative"] },
    },
  };
  const trustDimensions = {
    type: "object",
    required: ["trust", "influence", "builder", "recency", "risk"],
    properties: {
      trust: { type: "number", minimum: 0, maximum: 100 },
      influence: { type: "number", minimum: 0, maximum: 100 },
      builder: { type: "number", minimum: 0, maximum: 100 },
      recency: { type: "number", minimum: 0, maximum: 100 },
      risk: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: "Account safety score. 100 means no obvious public-account risk signals.",
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "ReleaseBar Public API",
      version: "0.2.3",
      description:
        "Cached public GitHub release, people trust, org signal, and stargazer audience context for dashboards and PR-triage agents.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/{owner}/activity": {
        get: {
          summary: "Get recent public GitHub activity grouped and ranked by repository",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            {
              name: "range",
              in: "query",
              schema: { enum: ["day", "week", "month"], default: "week" },
            },
          ],
          responses: {
            "200": {
              description: "Owner activity",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/OwnerActivity" } },
              },
            },
          },
        },
      },
      "/api/users/{login}/trust": {
        get: {
          summary: "Get cached public people trust or org signal context for one GitHub profile",
          parameters: [{ name: "login", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "People trust or org signal profile",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/TrustProfile" } },
              },
            },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience": {
        get: {
          summary: "Get cached recent stargazer audience percentages and scored users",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
            { name: "range", in: "query", schema: { enum: ["week", "month"], default: "month" } },
          ],
          responses: {
            "200": {
              description: "Repository audience",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RepoAudience" } },
              },
            },
            "403": { description: "GitHub App quota required for cold audience builds" },
          },
        },
      },
      "/api/repos/{owner}/{repo}/audience/backfill": {
        post: {
          summary: "Warm week and month audience caches with GitHub App quota",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Backfill state",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RepoAudienceBackfill" },
                },
              },
            },
            "403": { description: "GitHub App quota required" },
          },
        },
      },
    },
    components: {
      schemas: {
        CacheState: cacheState,
        OwnerActivityEvent: {
          type: "object",
          required: ["id", "kind", "title", "repo", "url", "createdAt", "count"],
          properties: {
            id: { type: "string" },
            kind: {
              enum: [
                "commit",
                "pull_request",
                "issue",
                "comment",
                "release",
                "repository",
                "other",
              ],
            },
            title: { type: "string" },
            repo: { type: "string" },
            url: { type: ["string", "null"], format: "uri" },
            createdAt: { type: "string", format: "date-time" },
            count: { type: "number" },
          },
        },
        OwnerActivityRepository: {
          type: "object",
          required: [
            "fullName",
            "url",
            "events",
            "commits",
            "pullRequests",
            "issues",
            "comments",
            "releases",
            "lastActiveAt",
          ],
          properties: {
            fullName: { type: "string" },
            url: { type: "string", format: "uri" },
            events: { type: "number" },
            commits: { type: "number" },
            pullRequests: { type: "number" },
            issues: { type: "number" },
            comments: { type: "number" },
            releases: { type: "number" },
            lastActiveAt: { type: "string", format: "date-time" },
          },
        },
        OwnerActivitySummary: {
          type: "object",
          required: ["state", "text"],
          properties: {
            state: { enum: ["ready", "warming", "unavailable"] },
            text: { type: ["string", "null"] },
            repositories: {
              type: "array",
              items: {
                type: "object",
                required: ["fullName", "text"],
                properties: {
                  fullName: { type: "string" },
                  text: { type: "string" },
                },
              },
            },
          },
        },
        OwnerActivity: {
          type: "object",
          required: ["owner", "range", "generatedAt", "cache", "totals", "repositories", "events"],
          properties: {
            owner: {
              type: "object",
              required: ["login", "type"],
              properties: {
                login: { type: "string" },
                type: { enum: ["user", "org"] },
                avatarUrl: { type: "string", format: "uri" },
                url: { type: "string", format: "uri" },
              },
            },
            range: { enum: ["day", "week", "month"] },
            generatedAt: { type: "string", format: "date-time" },
            cache: { $ref: "#/components/schemas/CacheState" },
            totals: {
              type: "object",
              required: [
                "events",
                "commits",
                "pullRequests",
                "issues",
                "comments",
                "releases",
                "repositories",
              ],
              properties: {
                events: { type: "number" },
                commits: { type: "number" },
                pullRequests: { type: "number" },
                issues: { type: "number" },
                comments: { type: "number" },
                releases: { type: "number" },
                repositories: { type: "number" },
              },
            },
            repositories: {
              type: "array",
              items: { $ref: "#/components/schemas/OwnerActivityRepository" },
            },
            events: {
              type: "array",
              items: { $ref: "#/components/schemas/OwnerActivityEvent" },
            },
            summary: { $ref: "#/components/schemas/OwnerActivitySummary" },
          },
        },
        TrustDimensions: trustDimensions,
        TrustFactor: trustFactor,
        TrustProfile: {
          type: "object",
          required: [
            "login",
            "type",
            "profileKind",
            "scoreLabel",
            "score",
            "tier",
            "dimensions",
            "factors",
            "cache",
          ],
          properties: {
            login: { type: "string" },
            type: { enum: ["user", "org"] },
            profileKind: { enum: ["user_trust", "org_signal"] },
            scoreLabel: { enum: ["trust score", "org signal"] },
            score: { type: "number", minimum: 0, maximum: 100 },
            tier: { enum: ["high", "medium", "low", "bot"] },
            accountAgeDays: { type: ["number", "null"] },
            reasons: { type: "array", items: { type: "string" } },
            dimensions: { $ref: "#/components/schemas/TrustDimensions" },
            factors: { type: "array", items: { $ref: "#/components/schemas/TrustFactor" } },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudience: {
          type: "object",
          required: ["fullName", "range", "totals", "users", "cache"],
          properties: {
            fullName: { type: "string" },
            range: { enum: ["week", "month"] },
            totals: {
              type: "object",
              required: [
                "stargazers",
                "stargazersSampled",
                "highSignalPercent",
                "mediumSignalPercent",
                "lowSignalPercent",
                "botPercent",
              ],
              properties: {
                stargazers: { type: "number" },
                stargazersSampled: { type: "number" },
                highSignal: { type: "number" },
                mediumSignal: { type: "number" },
                lowSignal: { type: "number" },
                bots: { type: "number" },
                highSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                mediumSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                lowSignalPercent: { type: "number", minimum: 0, maximum: 100 },
                botPercent: { type: "number", minimum: 0, maximum: 100 },
              },
            },
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  login: { type: "string" },
                  score: { type: "number" },
                  tier: { enum: ["high", "medium", "low", "bot"] },
                  trustScore: { type: "number" },
                  trustTier: { enum: ["high", "medium", "low", "bot"] },
                  dimensions: { $ref: "#/components/schemas/TrustDimensions" },
                },
              },
            },
            cache: { $ref: "#/components/schemas/CacheState" },
          },
        },
        RepoAudienceBackfill: {
          type: "object",
          required: ["fullName", "ranges", "quota", "message"],
          properties: {
            fullName: { type: "string" },
            ranges: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  range: { enum: ["week", "month"] },
                  state: { enum: ["busy", "fresh", "rebuilt"] },
                  users: { type: "number" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              },
            },
            quota: { type: "object" },
            message: { type: "string" },
          },
        },
      },
    },
  };
}
