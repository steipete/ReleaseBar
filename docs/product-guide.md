# ReleaseBar Product Guide

ReleaseBar presents release health for public GitHub users, organizations, and repositories. This guide covers the dashboard behavior that is intentionally summarized in the README.

## Dashboard routes

- `/` loads ReleaseBar Hot, a cached board built from recently requested public dashboards.
- `/:owner` loads the Worker API for a public GitHub user or organization.
- `/:owner/activity` groups day, week, or month public work by repository and ranks repositories by activity volume. Contributor forks of profile-owned repositories are omitted when GitHub identifies them; unrelated external project work remains visible.
- `/:owner/:repo` shows release cadence, recent releases, contributors, languages, commit and churn charts, public stargazer audience signals, and 30-day issue and pull-request trends when GitHub provides them.

## Custom dashboards

The settings panel can add public users, organizations, or explicit repositories to the current URL. Shareable query options include:

- `forks=true` to include forks
- `archived=true` to include archived repositories
- `unreleased=false` to hide repositories without a GitHub release
- `owners=openclaw,steipete` to add public owners
- `repos=owner/name` to add explicit public repositories

Custom URLs accept up to eight added public sources. Settings can hide visible owners or repositories locally without changing the shared cache. Signed-in dashboard owners can save added sources and local visibility as the public default for their clean owner route.

## Attention and repository context

The need-attention metric identifies repositories with unreleased commits, stale releases, failing or cancelled CI, or issue and pull-request pressure. Rows include the reason for the state instead of exposing only a score.

Owner pages show bounded people-trust or organization-signal profiles based on public GitHub age, reach, footprint, safety dimensions, weighted factors, and recent repository evidence. These signals are context, not identity or access-control decisions. Repository pages can also show bounded recent public stargazer signals and, when configured, an AI summary of commit titles since the latest release.

## GitHub login and installation

GitHub authentication uses `/api/auth/login`, `/api/auth/callback`, `/api/auth/install`, `/api/auth/logout`, and `/api/me`. Login detects existing ReleaseBar GitHub App installations and offers installation when the current dashboard source is not covered.

An installation supplies dedicated GitHub API quota for the selected account and public repositories. Public unsynced dashboards remain metadata-only and skip release hydration. Once an installation is known, anonymous viewers can benefit from that account's app quota; mixed-owner dashboards partition work across each covered source instead of consuming one shared quota bucket.

Successful login or installation queues a bounded warm-up for an all-repository installation when its shared owner dashboard is missing, stale, or incomplete. Audience backfill is GitHub App-only and warms bounded week and month stargazer-signal caches for covered public repositories.

Private repositories are ignored even when selected in the installation. ReleaseBar stores and renders public repository metadata only.

## Freshness behavior

Dashboard builds validate public GitHub owners and scan up to the 200 most recently pushed public repositories per owner. Lightweight metadata appears before release and CI hydration completes. Active owner issue and pull-request counts refresh more frequently than deeper release data.

Fresh cache is served for about one hour. Stale or partial cache stays visible while a bounded background rebuild continues, and payloads expose separate timestamps for count, release, and CI data. The [public API reference](api.md) defines these cache fields; the [refresh scheduler](refresh-scheduler.md) documents batching, retries, quota selection, and webhook fanout.
