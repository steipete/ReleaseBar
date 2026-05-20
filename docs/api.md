# ReleaseBar Public API

ReleaseBar exposes cached public REST endpoints for agents and dashboards that need GitHub release, people trust, and organization signal context without crawling the whole GitHub graph themselves.

The trust and org signal APIs only use public GitHub profile, organization, repository, and stargazer metadata. They do not prove identity, employment, repository ownership, or maintainer intent. Treat the score as triage context, not an access-control decision.

## Base URL

```text
https://release.bar
```

Local development may serve the app from Vite and the Worker API from Wrangler. Browser fallback routes use port `8787` for local Worker API calls.

## OpenAPI

Swagger-compatible OpenAPI 3.1 JSON is available at:

- `GET /openapi.json`
- `GET /api/openapi.json`
- `GET /api/swagger.json`

## Cache Contract

All successful JSON responses include a `cache` object when the payload can be reused by agents.

```ts
type CacheState = {
  state: "fresh" | "stale" | "partial" | "warming" | "error";
  stale: boolean;
  generatedAt: string;
  message?: string;
  quota?: {
    source: "app" | "shared" | "anonymous";
    account: string | null;
    remaining: number | null;
    limit: number | null;
    resetAt: string | null;
    resource: string | null;
  };
};
```

Agents should:

- prefer `fresh` and `stale` payloads over calling GitHub directly
- keep their own short client cache keyed by endpoint URL
- surface `cache.stale`, `cache.generatedAt`, and `cache.message` in audit logs
- avoid retry loops on `429`; respect `Retry-After` when present
- treat `error` payloads as "no ReleaseBar signal", not as negative user evidence

## User Trust Or Org Signal Profile

`GET /api/users/:login/trust`

Returns a cached public people trust profile or organization signal profile for one GitHub login. This is the primary agent endpoint for PR triage when an agent wants bounded context about an author, reviewer, issue reporter, commenter, or the organization behind a repository.

People return `profileKind: "user_trust"` and `scoreLabel: "trust score"`. Organization accounts return `profileKind: "org_signal"` and `scoreLabel: "org signal"` because an organization is a project venue, employer, brand, or umbrella rather than an individual actor. Do not present an org signal as personal author trust.

### Path Parameters

| Name    | Type   | Notes                                           |
| ------- | ------ | ----------------------------------------------- |
| `login` | string | GitHub login. `@` prefixes are normalized away. |

### Response

```ts
type TrustProfilePayload = {
  login: string;
  type: "user" | "org";
  profileKind: "user_trust" | "org_signal";
  scoreLabel: "trust score" | "org signal";
  avatarUrl: string;
  url: string;
  name: string | null;
  company: string | null;
  bio: string | null;
  location: string | null;
  blog: string | null;
  twitterUsername: string | null;
  followers: number;
  following: number;
  publicRepos: number;
  publicGists: number;
  accountCreatedAt: string | null;
  accountUpdatedAt: string | null;
  accountAgeDays: number | null;
  score: number;
  tier: "high" | "medium" | "low" | "bot";
  reasons: string[];
  dimensions: {
    trust: number;
    influence: number;
    builder: number;
    recency: number;
    risk: number;
  };
  factors: Array<{
    key: "age" | "profile" | "orgs" | "reach" | "builder" | "recency" | "risk";
    label: string;
    value: number;
    maxValue: number;
    weight: number;
    weightedValue: number;
    detail: string;
    sentiment: "positive" | "neutral" | "negative";
  }>;
  orgs: Array<{
    login: string;
    description: string | null;
  }>;
  topRepositories: Array<{
    fullName: string;
    url: string;
    description: string | null;
    language: string | null;
    stars: number;
    forks: number;
    updatedAt: string | null;
    topics: string[];
  }>;
  stats: {
    totalStars: number;
    totalForks: number;
    recentRepositories: number;
    activeRepositories: number;
    publicOrganizations: number;
    languages: Array<{ name: string; count: number }>;
    topics: Array<{ name: string; count: number }>;
  };
  generatedAt: string;
  cache: CacheState;
};
```

### Score Semantics

`score` is a 0-100 public-signal score. `tier` is derived from that score, except obvious automation accounts return `bot`.

For `profileKind: "user_trust"`, the score describes a person/account as a public GitHub actor. For `profileKind: "org_signal"`, the score describes an organization's public footprint and credibility. These are intentionally not the same semantic label.

Dimension notes:

- `trust`: for people, account age, profile completeness, and public organization signals; for orgs, organization credibility
- `influence`: follower count and stars across recent public repositories
- `builder`: for people, public repository history and recent activity; for orgs, public repository footprint
- `recency`: stargazer recency when scored in a repository audience context; usually neutral on profile-only trust pages
- `risk`: account safety score where `100` is best and lower values mean more public-account risk signals. The UI labels this as account safety to avoid implying a higher value is more risk.

Agents should use the dimensions, factors, and reasons instead of only the headline score. A low score on a new account is not automatically suspicious; it may simply mean there is not enough public signal.

### Example

```sh
curl -s https://release.bar/api/users/octocat/trust
```

```json
{
  "login": "octocat",
  "type": "user",
  "profileKind": "user_trust",
  "scoreLabel": "trust score",
  "accountAgeDays": 6200,
  "score": 73,
  "tier": "high",
  "reasons": ["established GitHub audience", "active public builder"],
  "dimensions": {
    "trust": 68,
    "influence": 74,
    "builder": 80,
    "recency": 0,
    "risk": 100
  },
  "cache": {
    "state": "fresh",
    "stale": false,
    "generatedAt": "2026-05-18T10:00:00.000Z"
  }
}
```

## Repository Audience

`GET /api/repos/:owner/:repo/audience?range=week|month`

Returns cached public trust scores for recent human stargazers of a repository. This is useful when an agent wants to understand who is newly showing interest in a project, not when it only needs one user's profile.

If the deployment has GitHub App quota configured and the repository is not covered by the signed-in user's installation, cold audience builds are blocked. Existing cached audience payloads can still be returned as stale public context.

### Query Parameters

| Name    | Type                  | Default   | Notes                                   |
| ------- | --------------------- | --------- | --------------------------------------- |
| `range` | `"week"` or `"month"` | `"month"` | Filters recent stargazers by star time. |

### Response

```ts
type RepoAudiencePayload = {
  fullName: string;
  range: "week" | "month";
  generatedAt: string;
  cache: CacheState;
  totals: {
    stargazers: number;
    stargazersSampled: number;
    highSignal: number;
    mediumSignal: number;
    lowSignal: number;
    bots: number;
    highSignalPercent: number;
    mediumSignalPercent: number;
    lowSignalPercent: number;
    botPercent: number;
  };
  users: Array<{
    login: string;
    avatarUrl: string;
    url: string;
    name: string | null;
    company: string | null;
    bio: string | null;
    location: string | null;
    followers: number;
    publicRepos: number;
    starredAt: string | null;
    accountCreatedAt: string | null;
    score: number;
    tier: "high" | "medium" | "low" | "bot";
    // Present only when a cached UserTrustProfile exists for this login.
    trustScore?: number;
    trustTier?: "high" | "medium" | "low" | "bot";
    reasons: string[];
    dimensions: TrustProfilePayload["dimensions"];
    factors: TrustProfilePayload["factors"];
    orgs: TrustProfilePayload["orgs"];
    topRepositories: Array<{
      fullName: string;
      url: string;
      description: string | null;
      language: string | null;
      stars: number;
      forks: number;
      updatedAt: string | null;
    }>;
  }>;
};
```

`score` and `tier` are contextual audience signals for this repository and star event. `trustScore` and `trustTier`, when present, come from the cached `UserTrustProfile` for the login and match `/api/users/{login}/trust`.

## Audience Backfill

`POST /api/repos/:owner/:repo/audience/backfill`

Warms week and month repository audience caches. This endpoint requires GitHub App installation quota for the repository and is intended for covered dashboards, not anonymous broad crawling.

### Response

```ts
type RepoAudienceBackfillPayload = {
  fullName: string;
  ranges: Array<{
    range: "week" | "month";
    state: "busy" | "fresh" | "rebuilt";
    users: number;
    generatedAt: string;
  }>;
  quota: {
    source: "app";
    account: string | null;
  };
  message: string;
};
```

## PR Triage Guidance For Agents

For a pull request, fetch the people trust profile for bounded actors only:

- PR author
- commit authors if different from the PR author
- first-time reviewers or commenters that change the risk picture

Suggested triage summary:

```text
author trust: medium 57
age: 820 days
builder: 64
account safety: 92
signals: active public builder; filled-out public profile; 12 public repos
cache: stale, generated 2026-05-18T10:00:00.000Z
```

If the PR context is mostly organizational, label it separately:

```text
repo org signal: high 82
footprint: 74
reach: 69
signals: organization account; 44 public repos; 12 recently active repos
cache: fresh, generated 2026-05-18T10:00:00.000Z
```

Agent rules:

- Do not block or approve a PR based only on ReleaseBar score.
- Do not call this "verified" identity or employment.
- Do not call an organization score "trust"; use `scoreLabel` or `profileKind` when rendering summaries.
- Do not fan out across every commenter on large threads unless the task explicitly asks for that breadth.
- Prefer `accountAgeDays`, `dimensions.risk`, `factors`, and `reasons` when explaining why a score matters.
- For obvious automation accounts, preserve the `bot` tier and avoid treating low score as human-risk evidence.
- When the endpoint returns stale cached data, say it is stale and continue if it is still useful context.
- When the endpoint returns an error, omit trust context rather than retrying aggressively.

## Error Responses

Errors are JSON and usually include either `error` or `cache.message`.

| Status | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| `400`  | Invalid owner, repository, or user slug.                                        |
| `403`  | GitHub App quota is required for the requested cold audience build or backfill. |
| `404`  | GitHub did not find the requested public resource.                              |
| `429`  | GitHub shared quota is exhausted or secondary rate-limited.                     |
| `502`  | Upstream API or payload-shape failure.                                          |

Example:

```json
{
  "error": "GitHub shared API quota is exhausted. Connect GitHub and install the app for this account to use dedicated quota, or try again after the shared quota resets.",
  "cache": {
    "state": "error",
    "stale": true,
    "generatedAt": "2026-05-18T10:00:00.000Z",
    "message": "GitHub shared API quota is exhausted. Connect GitHub and install the app for this account to use dedicated quota, or try again after the shared quota resets."
  }
}
```
