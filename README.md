# 📦 ReleaseBar

Release freshness dashboard for public GitHub users and orgs.

ReleaseBar tracks public GitHub repository release health: latest version, release date, commits since release, activity, stars, language, topics, open work, and CI status. It serves cached dashboards for routes like `https://release.bar/steipete`, `https://release.bar/openclaw`, and `https://release.bar/microsoft`.

Owner dashboards show visible public repositories immediately with lightweight repo metadata, then progressively hydrate release, commit, PR, and CI data in the background.

## Configure

Edit `releasebar.config.json`:

- `owners`: GitHub users or orgs to scan
- `includeForks`: include forked repositories
- `includeArchived`: include archived repositories
- `includeUnreleased`: include repositories without GitHub releases in static builds
- `excludeRepos`: full `owner/name` entries to hide
- `canonicalDomain`: primary public dashboard domain

## Build

```sh
npm run build
```

Set `GITHUB_TOKEN` for higher API limits. GitHub Actions uses the built-in token. Static builds read `releasebar.config.json`; the public service reads owner routes through the Worker API.

## Generic Dashboards

- `/` loads `ReleaseBar Hot`, a cached board built from recently requested public dashboards
- `/:owner` loads the Worker API for that owner
- query options: `forks=true`, `archived=true`, `unreleased=false`
- add public sources with `owners=openclaw,steipete` or `repos=owner/name`
- the settings panel can add public users, orgs, or explicit repos to the current URL
- signed-in dashboard owners can save added public sources and local visibility as the public default for their clean owner route
- custom URLs are capped at 8 added public sources
- settings can hide visible owners or repos locally without changing the shared cache
- GitHub App login uses `/api/auth/login`, `/api/auth/callback`, `/api/auth/install`, `/api/auth/logout`, and `/api/me`
- `Connect GitHub` signs the user in, checks GitHub App installations, and sends them to install the app when the current dashboard source is not covered
- GitHub App installation gives ReleaseBar dedicated GitHub API quota for the selected account/repositories; once an account installation is known, public refreshes for that account can use its app quota even for anonymous viewers
- private repositories are ignored even when selected in GitHub App installation; ReleaseBar only stores and renders public repository metadata
- the need-attention metric filters repos with unreleased commits, stale releases, failing/cancelled CI, or issue/PR pressure and rows show the reason inline
- repository detail pages include release cadence, recent releases, contributors, languages, commit/churn charts, and 30-day issue/PR trend counts when GitHub provides them
- repository detail pages can show an AI summary of commit titles since the latest release when the Worker has an OpenAI API key

## API And Cache

The Worker in `worker/index.ts` serves both the static app shell and the generic owner API:

- `GET /api/:owner` returns a cached dashboard for a public GitHub user or org
- `GET /api/:owner/events` streams cache updates for progressive rebuilds
- `GET /api/repos/:owner/:repo` returns repository detail stats
- `GET /api/_discover` and `GET /api/_hot` power the root dashboard

Dashboard builds validate public GitHub owners, scan up to the 200 most recently pushed public repositories per owner, and hydrate repositories in 12-repository batches. Dashboard payloads, repo fragments, hot boards, app-installation coverage, profile settings, and auth session data live in Cloudflare KV. A Durable Object binding (`DASHBOARD_LOCKS`) prevents repeated cold requests from stampeding GitHub.

Fresh dashboard cache is served for about 1h. Stale or partial cache is shown while a background rebuild continues, so large owners can show useful rows before all release data finishes. Dashboard records are retained longer than the fresh window so older public data can remain visible during GitHub outages or rate limits, with the UI marking stale/partial state.

The Worker writes structured `github_token_use` and `github_installation_token` logs without token values. Use Cloudflare Worker tail/logs to audit which area, route, quota source, account, status, and remaining rate-limit bucket handled public GitHub requests.

### GitHub App Login

Configure these Worker secrets before enabling login:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `AUTH_COOKIE_SECRET`

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are required for dedicated GitHub App quota. Without them, users can still sign in, but dashboard rebuilds use the shared server token/cache. Optional: `GITHUB_APP_SLUG` defaults to `releasebar-app`, the current GitHub App slug.

Set the GitHub App setup URL to `https://release.bar/api/auth/install` and enable redirect-on-update so users return to their dashboard after installing or changing repository access.

### AI Release Summaries

Configure `OPENAI_API_KEY` as a Worker secret to summarize recent public activity and commit titles since the latest release. Optional: `OPENAI_SUMMARY_MODEL` defaults to `chat-latest`, OpenAI's GPT-5.5 Instant API alias.

```sh
wrangler secret put OPENAI_API_KEY
```

Summaries are generated server-side through the OpenAI Responses API without an explicit reasoning option. Release summaries are cached by repository, release tag, default-branch head SHA, model, and prompt version; activity summaries also refresh when the configured model changes.

## Deploy

The combined app/API Worker deploys with Wrangler through `.github/workflows/deploy.yml` on pushes to `main`:

```sh
npm run build
wrangler deploy
```

`wrangler.toml` binds `dist` as Worker static assets, `DASHBOARD_CACHE` as KV, and `DASHBOARD_LOCKS` as the Durable Object single-flight lock. The Worker runs first so `/api/*` stays dynamic and owner routes like `/openclaw` return the app shell with HTTP 200. Deploy CI smokes the root page, an owner page, a repository detail page, the discovery API, and live JS/CSS asset hashes after Wrangler deploys.

The deployed Worker service is still named `releasedeck-api` in Cloudflare for continuity. The canonical product, repo, package, and config names are ReleaseBar / `releasebar`.
