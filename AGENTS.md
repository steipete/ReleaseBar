Work style: terse.

## Deploy

- Canonical prod: Cloudflare Worker + Worker Assets from `wrangler.toml`.
- Repo/product name: ReleaseBar. Config file: `releasebar.config.json`.
- Cloudflare Worker service name is still `releasedeck-api`; do not rename it casually because it affects deployed infrastructure.
- `release.bar` is not GitHub Pages. Do not trust Pages deploys for prod.
- Push to `main` runs `.github/workflows/deploy.yml`, then `npm exec --yes --package wrangler -- wrangler deploy`.
- Required GitHub secret: `CLOUDFLARE_API_TOKEN`.
- Post-deploy smoke compares live JS/CSS hashes against local `dist/index.html`, then checks `/`, `/steipete`, `/openclaw/openclaw`, and `/api/_discover`.
- Local prod deploy: `npx wrangler deploy`.
- Local real-data dev: `npm run dev:worker:real` uses Wrangler `--remote` on port 8787 with real secrets and preview KV.
- Static CI/proof: `npm run check:static`.
