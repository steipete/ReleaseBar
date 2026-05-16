# 📦 ReleaseDeck

Release freshness dashboard for public GitHub users and orgs.

ReleaseDeck tracks latest version, latest release date, commits since release, activity, stars, language, and quick search. Repositories without any GitHub releases are skipped unless unreleased repositories are explicitly included. Dev mode adds open issue counts, open PR counts, and latest CI status.

## Configure

Edit `releasedeck.config.json`:

- `owners`: GitHub users or orgs to scan
- `includeForks`: include forked repositories
- `includeArchived`: include archived repositories
- `excludeRepos`: full `owner/name` entries to hide
- `canonicalDomain`: primary public dashboard domain

## Build

```sh
npm run build
```

Set `GITHUB_TOKEN` for higher API limits. GitHub Actions uses the built-in token.

## Generic Dashboards

- `/` loads `ReleaseBar Hot`, a cached board built from recently requested public dashboards
- `/:owner` loads the Worker API for that owner
- query options: `forks=true`, `archived=true`, `unreleased=true`
- add public sources with `owners=openclaw,steipete` or `repos=owner/name`
- the settings panel can add public users, orgs, or explicit repos to the current URL
- custom URLs are capped at 8 added public sources
- settings can hide visible owners or repos locally without changing the shared cache
- GitHub App login uses `/api/auth/login`, `/api/auth/callback`, `/api/auth/install`, `/api/auth/logout`, and `/api/me`
- `Connect GitHub` signs the user in, checks GitHub App installations, and sends them to install the app when the current dashboard source is not covered
- GitHub App installation gives ReleaseBar dedicated GitHub API quota for the selected account/repositories; public dashboards still fall back to the shared server token and cache
- private repositories are ignored even when selected in GitHub App installation; ReleaseBar only stores and renders public repository metadata

The Worker in `worker/index.ts` serves both the static app shell and the generic owner API. It validates public GitHub owners, builds a capped public dashboard from the 50 most recently pushed public repositories per owner, stores dashboards and repo fragments in KV, serves fresh cache for 1h, serves stale cache while revalidating, and builds the root hot board from existing cached dashboards. A Durable Object binding prevents repeated cold requests from stampeding GitHub. Configure `DASHBOARD_CACHE`, `DASHBOARD_LOCKS`, and `GITHUB_TOKEN` before deploying the Worker.

### GitHub App Login

Configure these Worker secrets before enabling login:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `AUTH_COOKIE_SECRET`

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required for dedicated GitHub App quota. Without them, users can still sign in, but dashboard rebuilds use the shared server token/cache. Optional: `GITHUB_APP_SLUG` defaults to `releasebar-app`, the current GitHub App slug.

Set the GitHub App setup URL to `https://release.bar/api/auth/install` and enable redirect-on-update so users return to their dashboard after installing or changing repository access.

## Deploy

The combined app/API Worker deploys with Wrangler through `.github/workflows/deploy.yml` on pushes to `main`:

```sh
npm run build
wrangler deploy
```

`wrangler.toml` binds `dist` as Worker static assets, `DASHBOARD_CACHE` as KV, and `DASHBOARD_LOCKS` as the Durable Object single-flight lock. The Worker runs first so `/api/*` stays dynamic and owner routes like `/openclaw` return the app shell with HTTP 200.
