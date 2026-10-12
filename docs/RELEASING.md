# Releasing ReleaseBar

ReleaseBar ships source snapshots through GitHub Releases. Its `package.json`
is private build tooling, so there is no npm channel or trusted publisher.
There are no macOS, Homebrew, or Sparkle artifacts. Cloudflare deployment is
owned separately by the existing `deploy.yml`; release automation never invokes
Wrangler, changes production secrets, or dispatches a deployment.

1. Update `version` in `package.json` and both root package entries in
   `package-lock.json`. Finalize exactly one `## X.Y.Z - YYYY-MM-DD` changelog
   section, retaining `## Unreleased` above it.
2. Land the preparation PR. Wait for successful **push CI at that exact main
   commit**; a green PR run does not satisfy the release gate.
3. Create and push a signed annotated `vX.Y.Z` tag using the authorized SSH key
   in `.github/release-signers`. Never move a tag or reuse a version.
4. `.github/workflows/release.yml` validates the signature, main ancestry,
   versions, dated notes, and exact push CI. It runs `npm ci` and
   `npm run check:static` (including build and tests), packages a versioned source
   archive, extracts it for a smoke check, and records SHA-256 checksums.
5. The workflow creates a draft GitHub Release, downloads and checks all its
   assets and notes, then publishes once. The dated changelog section is the
   release body. Existing releases and drafts are refused, not overwritten.

For a no-publish proof, dispatch **Release** from `main` with `dry_run: true`
(the default), leaving `tag` empty. It builds and packages the current main
commit and retains a 14-day Actions artifact, without creating tags, releases,
or deployments. Supply an existing signed tag to prove that source instead.
Publishing via dispatch requires an existing tag and `dry_run: false`; the
workflow never creates tags.

No release secrets are required. `GITHUB_TOKEN` receives read access for the
build and narrowly scoped Contents write access only in the publishing job.
A failed draft is preserved for inspection; it is not automatically deleted or
republished. The former local `gh release create` procedure is retired.
