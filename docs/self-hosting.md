# Self-hosting and Operations

ReleaseBar is a Svelte frontend and Cloudflare Worker service. The Worker serves the static app shell and public GitHub API routes, while Cloudflare KV, Queues, and a Durable Object coordinate cached dashboard hydration.

## Requirements

- Node.js 22.12 or newer; CI and `.nvmrc` use Node.js 24.
- npm, using the committed `package-lock.json`.
- A Cloudflare account and Wrangler authentication for remote development or deployment.
- A GitHub token for higher API limits when building real dashboard data locally.

Install dependencies and build the app:

```sh
npm ci
npm run build
```

`GITHUB_TOKEN` is optional. GitHub Actions uses its built-in token for data builds that need authenticated GitHub access.

## Configuration

Static builds read `releasebar.config.json`.

| Key                 | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `owners`            | GitHub users or organizations to scan                         |
| `includeForks`      | Include forked repositories                                   |
| `includeArchived`   | Include archived repositories                                 |
| `includeUnreleased` | Include repositories without GitHub releases in static builds |
| `excludeRepos`      | Hide specific `owner/name` repositories                       |
| `canonicalDomain`   | Set the primary dashboard domain                              |

The public Worker service accepts arbitrary public owners through route and query parameters rather than limiting requests to the static configuration.

## Local development

For frontend hot reload:

```sh
npm run dev
```

For a fully local Worker on port 8787:

```sh
npm run dev:worker
```

The Vite app falls back to `http://127.0.0.1:8787` for API calls. Local Worker development does not receive production secrets unless they are provided through local Wrangler configuration.

For local code running on Cloudflare with real secrets and preview KV:

```sh
npm run dev:worker:real
```

Open `http://localhost:8787/steipete` or another owner route. Because `wrangler.toml` defines a KV `preview_id`, remote development warms preview storage rather than the production dashboard cache.

## Cloudflare resources

`wrangler.toml` binds:

- `dist` as Worker static assets
- `DASHBOARD_CACHE` as KV storage for dashboard, repository, settings, installation, session, and scheduler records
- `DASHBOARD_LOCKS` as a Durable Object for single-flight builds, checkpoints, job reservations, and failure state
- `REFRESH_QUEUE` for bounded background hydration and webhook work

The Worker runs before static assets so `/api/*` stays dynamic and owner routes return the application shell. The deployed Cloudflare service remains named `releasedeck-api` for infrastructure continuity even though the product, repository, package, and configuration names are ReleaseBar and `releasebar`.

The shared `GITHUB_TOKEN` is the fallback quota bucket for sources without GitHub App coverage. Installed accounts use their own App quota. ReleaseBar defers optional enrichment before core release-health work when shared GitHub quota becomes constrained. Detailed cache, queue, and retry behavior is in [the refresh scheduler](refresh-scheduler.md).

## GitHub App

Configure these Worker secrets to enable login and installation:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `AUTH_COOKIE_SECRET`

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` enable dedicated installation quota. Without them, users can still sign in, but dashboard rebuilds use the shared server token and cache. `GITHUB_APP_SLUG` is optional and defaults to `releasebar-app`.

Set the GitHub App setup URL to `https://release.bar/api/auth/install` and enable redirect-on-update. Set the webhook URL to `https://release.bar/api/github/webhook`, use the same webhook secret in GitHub and Cloudflare, and subscribe to Issues, Pull requests, Push, Releases, and Repository events.

Signed webhook payloads up to 2 MiB enter Cloudflare Queue before acknowledgement. Issue and pull-request bursts coalesce into authoritative count refreshes; push and release bursts coalesce into release refreshes. Privacy and archive transitions remain separate so visibility changes apply promptly.

## AI summaries

Set `OPENAI_API_KEY` as a Worker secret to summarize public owner activity and commit titles since the latest release:

```sh
wrangler secret put OPENAI_API_KEY
```

`OPENAI_SUMMARY_MODEL` is optional and defaults to `chat-latest`. Summaries run server-side through the OpenAI Responses API, remain subordinate to public source data, and are cached with the model and prompt version.

## Deploy

The production deployment is a Cloudflare Worker with Worker Assets, not GitHub Pages. A local deployment runs:

```sh
npm run build
wrangler deploy
```

Pushes to `main` run `.github/workflows/deploy.yml`. The workflow requires `CLOUDFLARE_API_TOKEN`, runs `npm run check:static`, deploys through Wrangler, compares live JavaScript and CSS asset hashes with the local build, and smokes `/`, `/steipete`, `/openclaw/openclaw`, and `/api/_discover`.

`.github/workflows/monitor.yml` repeats the production route, discovery API, and asset checks every six hours without redeploying unchanged code.
