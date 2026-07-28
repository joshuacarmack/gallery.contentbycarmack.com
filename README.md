# CBC Gallery

Self-hosted client photo delivery for Content by Carmack, replacing ShootProof.
See [SPECS.md](SPECS.md) for the full specification.

**Stack:** Cloudflare Workers + Hono, D1, R2, Queues, React + Vite via Workers Static Assets.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars           # set COOKIE_SECRET
npm run db:migrate:local                 # apply D1 schema to local emulation
npm run build                            # build the frontend into dist/
npm run dev:worker                       # wrangler dev on :8787 (serves API + built SPA)
```

For frontend iteration with hot reload, also run `npm run dev` (Vite on :5173,
proxying `/api`, `/d`, `/z` to :8787).

Locally, `ACCESS_TEAM_DOMAIN` is empty so admin auth is bypassed. Open
`http://localhost:8787/admin`.

## First deploy

1. **Provision resources** (one time):
   ```sh
   wrangler d1 create cbc-gallery        # paste database_id into wrangler.jsonc
   wrangler r2 bucket create cbc-gallery
   wrangler queues create cbc-gallery-zips
   wrangler secret put COOKIE_SECRET     # long random string
   ```
2. **Public bucket domain**: in the Cloudflare dashboard, connect the R2 bucket
   to the custom domain `cdn.gallery.contentbycarmack.com` (public access via
   custom domain only). Cache headers are set per-object at upload time.
   Add an R2 bucket-level or zone Transform Rule setting
   `X-Robots-Tag: noindex, nofollow` on that hostname (§12 of the spec).
3. **Cloudflare Access**: create an Access application covering
   `gallery.contentbycarmack.com/admin*` and `/api/admin*`. Copy the team
   domain (e.g. `yourteam.cloudflareaccess.com`) and the application AUD tag
   into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in `wrangler.jsonc`. The Worker
   verifies the Access JWT itself; `workers_dev` is already disabled.
4. **Migrate and deploy**:
   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```
5. Add the custom domain route `gallery.contentbycarmack.com` to the Worker.

## Layout

```
migrations/            D1 schema
src/worker/            Hono app: routes/public.ts, routes/admin.ts, zip-consumer.ts
src/app/public/        client-facing gallery UI (gate, justified grid, lightbox)
src/app/admin/         admin UI (CRUD, uploads with Web Worker thumbnailing)
src/shared/types.ts    API types shared by both sides
```

## Operational notes

- Gallery deletes are soft (Trash in the admin UI); "Delete forever" purges R2.
- ZIPs rebuild automatically after each upload batch; "Rebuild Downloads" in
  the admin UI forces it.
- A gallery scope over 900 photos fails its ZIP build loudly by design
  (subrequest limit, spec §7) — individual downloads still work.
- D1 Time Travel gives 30-day point-in-time restore of metadata; masters live
  on Joshua's own hardware, R2 is delivery-only.
