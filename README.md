# ReleaseBar 📦 — Know what needs a release.

[![CI](https://img.shields.io/github/actions/workflow/status/steipete/ReleaseBar/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/steipete/ReleaseBar/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/steipete/ReleaseBar?style=flat-square&label=release)](https://github.com/steipete/ReleaseBar/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/steipete/ReleaseBar?style=flat-square)](LICENSE)
[![Live](https://img.shields.io/badge/live-release.bar-6fda44?style=flat-square)](https://release.bar)

ReleaseBar is a release-freshness dashboard for public GitHub users and organizations. It combines releases, unreleased commits, repository activity, CI, and open work so maintainers can see which projects need attention.

## Install

The public service runs at [release.bar](https://release.bar), with no installation required.

To run the source locally:

```sh
git clone https://github.com/steipete/ReleaseBar.git
cd ReleaseBar
npm ci
```

ReleaseBar requires Node.js 22.12 or newer. Node.js 24 is the version used by CI.

## Quick start

Open a dashboard for any public GitHub owner, such as [release.bar/steipete](https://release.bar/steipete), or read the same cached data from the API:

```sh
curl -fsSL https://release.bar/api/steipete \
  | jq '{owners: [.owners[].login], repositories: (.projects | length), cache: .cache.state}'
```

The response may initially report `partial` or `stale` while deeper release and CI data hydrates in the background.

## Dashboards

| Route              | Shows                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| `/`                | Recently requested public dashboards                                                    |
| `/:owner`          | Release health for one GitHub user or organization                                      |
| `/:owner/activity` | Day, week, or month public activity grouped by repository                               |
| `/:owner/:repo`    | Release cadence, contributors, languages, churn, open work, and recent audience signals |

Dashboard settings can add public owners, organizations, or explicit repositories to the current URL. Query parameters cover shareable filters such as `forks=true`, `archived=true`, `unreleased=false`, `owners=openclaw,steipete`, and `repos=owner/name`.

See the [product guide](docs/product-guide.md) for login, GitHub App, filtering, attention, trust, and repository-detail behavior.

## Freshness and public data

Owner dashboards return lightweight public repository metadata first, then hydrate release, commit, pull-request, and CI data in bounded background batches. Cached data remains visible during GitHub outages or rate limits, and each payload reports whether its data is fresh, stale, partial, warming, or errored.

ReleaseBar ignores private repositories even when a GitHub App installation includes them. Installing the app supplies dedicated GitHub API quota for covered public sources; it does not turn ReleaseBar into a private-repository browser or a GitHub write proxy.

## API

The Worker exposes cached public endpoints for owner dashboards, activity, repository details, audience signals, and public GitHub profile context. Swagger-compatible OpenAPI 3.1 is available at [`/openapi.json`](https://release.bar/openapi.json).

See the [public API reference](docs/api.md) for response shapes, cache semantics, and agent guidance. The [refresh scheduler](docs/refresh-scheduler.md) describes background hydration, retries, quota selection, and webhook-driven refreshes.

## Self-hosting

Static builds use `releasebar.config.json`; the hosted service serves arbitrary public owner routes through the Cloudflare Worker API. See [Self-hosting and operations](docs/self-hosting.md) for configuration, local Worker modes, GitHub App setup, optional AI summaries, Cloudflare bindings, and deployment checks.

## Development

```sh
npm ci
npm run check:static
npm run dev
```

The Vite development server runs on `http://127.0.0.1:5173`. Run `npm run dev:worker` alongside it when testing Worker API routes locally.

Product direction and boundaries live in [VISION.md](VISION.md).

## License

MIT. See [LICENSE](LICENSE).
