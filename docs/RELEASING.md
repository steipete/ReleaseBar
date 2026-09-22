# Releasing ReleaseBar

ReleaseBar is deployed to Cloudflare from `main`. GitHub releases mark source snapshots; the npm package is private and there are no signed app binaries to publish.

1. Run `npm ci` and `npm run check:static` with the supported Node.js version in `.nvmrc`.
2. Bump `version` in `package.json` and the root package entries in `package-lock.json`. Finalize the pending changelog section as `## X.Y.Z - YYYY-MM-DD`, with a one-line **Highlights** lead-in. Keep an empty `## Unreleased` section above it.
3. Land the release preparation through a reviewed PR with passing CI. Wait for the `Deploy` workflow at that exact `main` commit to complete its Cloudflare asset and route smoke checks.
4. Tag that commit as `vX.Y.Z` and push the tag. Tags do not trigger a release workflow in this repository.
5. Copy the finalized changelog section verbatim to a temporary notes file and publish the GitHub release with `gh release create vX.Y.Z --verify-tag --title "ReleaseBar vX.Y.Z" --notes-file <notes-file>`.
6. Verify that the GitHub release is published, its tag points to the intended commit, and its body matches the changelog section. Do not run `npm publish`.
