# ReleaseDeck

ReleaseDeck is a release freshness dashboard for public GitHub users and orgs: latest version, latest release date, commits since release, activity, stars, language, and quick search. Repositories without any GitHub releases are skipped unless unreleased repositories are explicitly included. Dev mode adds open issue counts, open PR counts, and latest CI status.

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

- `/` loads the checked-in static snapshot from `data/projects.json`
- `/:owner` loads the Worker API for that owner
- query options: `forks=true`, `archived=true`, `unreleased=true`
- add public sources with `owners=openclaw,steipete` or `repos=owner/name`
- the settings panel can add public users, orgs, or explicit repos to the current URL
- custom URLs are capped at 8 added public sources
- settings can hide visible owners or repos locally without changing the shared cache
- GitHub App login uses `/api/auth/login`, `/api/auth/callback`, `/api/auth/install`, `/api/auth/logout`, and `/api/me`
- `Connect GitHub` signs the user in, checks GitHub App installations, and sends them to install the app when the current dashboard source is not covered
- GitHub App installation gives ReleaseDeck dedicated GitHub API quota for the selected account/repositories; public dashboards still fall back to the shared server token and cache
- private orgs still need the GitHub App installed on the target account/repositories; login alone only identifies the user

The Worker in `worker/index.ts` serves both the static app shell and the generic owner API. It validates public GitHub owners, builds a capped public dashboard from the 8 most recently pushed public repos, stores it in KV, serves fresh cache for 1h, and serves stale cache while revalidating. Configure `DASHBOARD_CACHE` and `GITHUB_TOKEN` before deploying the Worker. GitHub Pages builds fall back to the workers.dev API origin while DNS is still cached away from Cloudflare.

### GitHub App Login

Configure these Worker secrets before enabling login:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `AUTH_COOKIE_SECRET`

Optional: `GITHUB_APP_SLUG` defaults to `releasedeck`.

Set the GitHub App setup URL to `https://releasedeck.dev/api/auth/install` and enable redirect-on-update so users return to their dashboard after installing or changing repository access.

## Deploy

GitHub Pages is deployed by `.github/workflows/pages.yml`.
The combined app/API Worker deploys with Wrangler:

```sh
npm run build
wrangler deploy
```

`wrangler.toml` binds `dist` as Worker static assets and runs the Worker first so `/api/*` stays dynamic and owner routes like `/openclaw` return the app shell with HTTP 200.
