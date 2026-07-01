# ReleaseBar Vision

ReleaseBar makes public open-source release health legible and actionable. It should answer which projects need attention, why they need it, and what changed without making maintainers assemble the picture from many GitHub pages.

## Product Promise

- Show a useful public owner, organization, or repository dashboard quickly.
- Explain release freshness with evidence: releases, commits, activity, CI, and open work.
- Preserve generic routes and configuration so ReleaseBar works beyond its original maintainers.
- Keep the public dashboard useful without requiring an account.

## Durable Principles

### Public by design

- Index and render public repositories only, including after GitHub App installation.
- Treat an installation as source-scoped API quota, not permission to expose private data.
- Store only the cache, settings, installation coverage, and session state needed to serve the product.
- Never turn ReleaseBar into a GitHub write proxy or release automation service.

### Useful before complete

- Return inexpensive repository metadata first, then hydrate release and CI details progressively.
- Prefer clearly labeled stale or partial data over an empty dashboard during upstream failure.
- Never present missing, partial, or old fields as current; freshness must remain inspectable.

### Accountable quota use

- Use source-owned GitHub App quota for covered sources and shared quota only for uncovered work.
- Bound scans, concurrency, fanout, retries, and enrichment so one dashboard cannot exhaust the service.
- Defer optional enrichment before core release-health data when quota or runtime budgets tighten.
- Deduplicate concurrent work and preserve the last useful cache while rebuilding.

### Signal over spectacle

- Make every need-attention state explainable from observable repository evidence.
- Treat people and organization scores as context, never as verdicts; expose factors and recent evidence.
- Keep AI summaries optional, derived from public activity, and subordinate to the underlying data.
- Prefer compact, comparable maintainer signals over vanity metrics or opaque ranking.

### Operationally honest

- Design background work to be bounded, retryable, and safe under duplicate delivery.
- Keep production monitoring independent from deployment success.
- Require real route and built-asset proof for runtime changes; mocks and static checks supplement that proof.

## Product Boundaries

ReleaseBar is not a private-repository browser, security or compliance score, GitHub action console, or package publisher. Features that require private repository ingestion, repository writes, opaque judgment, or unbounded background work are outside the default product direction.

## Decision Order

When goals conflict, prefer:

1. Public-data boundaries, privacy, and correctness.
2. Honest freshness and availability of useful cached data.
3. Maintainer usefulness and explainability.
4. Sustainable GitHub quota and Cloudflare runtime cost.
5. Richer optional enrichment.

## Shipping Standard

User-visible changes should update the relevant docs and changelog, pass the repository's static checks, and prove the affected production-shaped path. Changes must preserve public-only behavior, labeled cache state, bounded work, and a useful anonymous experience.
