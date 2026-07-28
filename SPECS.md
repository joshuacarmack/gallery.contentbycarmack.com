# CBC Gallery — Technical Specification

**Purpose:** Self-hosted client photo delivery for Content by Carmack, replacing ShootProof.
**Target:** `gallery.contentbycarmack.com`
**Status:** Spec — ready for implementation.

---

## 1. Goals and Non-Goals

### Goals
- Create galleries with optional simple password protection.
- Two-level structure: gallery → sub-gallery. No deeper nesting.
- Fast browsing on mobile (parents on phones are the primary audience).
- Download individual photos at full quality, or a whole gallery/sub-gallery as a ZIP.
- Upload hundreds of files in one pass with minimal fuss.
- Run for roughly $0–1/month.

### Non-Goals (explicitly out of scope)
- Proofing, favorites, client selects
- Print sales, cart, payments
- Watermarking
- Automatic gallery expiry
- Multi-user admin (single admin: Joshua)
- Download tracking / per-client analytics
- Athlete or jersey-number filtering *(possible future work — see §12)*

---

## 2. Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Router | Hono |
| Database | Cloudflare D1 |
| Object storage | Cloudflare R2 |
| Async jobs | Cloudflare Queues |
| Frontend | React + Vite, served via Workers Static Assets |
| Admin auth | Cloudflare Access |
| Deploy | Wrangler |

### Bindings

```jsonc
// wrangler.jsonc
{
  "d1_databases":   [{ "binding": "DB", "database_name": "cbc-gallery" }],
  "r2_buckets":     [{ "binding": "BUCKET", "bucket_name": "cbc-gallery" }],
  "queues": {
    "producers": [{ "binding": "ZIP_QUEUE", "queue": "cbc-gallery-zips" }],
    "consumers": [{ "queue": "cbc-gallery-zips", "max_batch_size": 1, "max_retries": 3 }]
  },
  "vars": { "PUBLIC_BUCKET_URL": "https://cdn.gallery.contentbycarmack.com" }
}
```

**Secrets:** `COOKIE_SECRET` (HMAC key for gallery session cookies).

---

## 3. Storage Model

### R2 bucket — public, served via custom domain

The bucket is **public** at `cdn.gallery.contentbycarmack.com`. Security comes from
unguessable keys, not from access control. Every photo ID is a 21-character nanoid
(~125 bits of entropy), so keys cannot be enumerated or guessed.

```
p/{photo_id}/f.jpg     full-size image
p/{photo_id}/t.jpg     thumbnail
z/{zip_id}.zip         pre-generated archive
```

**Accepted tradeoff:** anyone holding a direct image URL can view it without the
gallery password. The password is a convenience gate for casual privacy, not a
security boundary. This is intentional — it buys free edge caching and zero
per-image Worker invocations.

### Cache headers
Set at upload time on the R2 object:
```
Cache-Control: public, max-age=31536000, immutable
```
Keys are content-addressed by ID and never mutate, so this is safe.

---

## 4. Database Schema (D1)

```sql
CREATE TABLE galleries (
  id                  TEXT PRIMARY KEY,          -- nanoid(21)
  slug                TEXT NOT NULL UNIQUE,      -- "soccer2026"
  title               TEXT NOT NULL,             -- "2026 Soccer"
  description         TEXT,
  password            TEXT,                      -- plaintext; NULL = public
  cover_photo_id      TEXT REFERENCES assets(id) ON DELETE SET NULL,
  zip_includes_subs   INTEGER NOT NULL DEFAULT 0, -- top-level zip spans sub-galleries
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE subgalleries (
  id              TEXT PRIMARY KEY,
  gallery_id      TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,                 -- "wildcats"
  title           TEXT NOT NULL,                 -- "Wildcats"
  sort_order      INTEGER NOT NULL DEFAULT 0,
  cover_photo_id  TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (gallery_id, slug)
);

-- NOTE: named `assets`, not `photos`, and carries three columns that Phase 1 does not
-- use. This is deliberate future-proofing for video delivery and guest uploads
-- (see §12). Unused columns cost nothing now; renaming this table later means
-- migrating R2 keys, foreign keys, and a live client-facing gallery.
CREATE TABLE assets (
  id             TEXT PRIMARY KEY,               -- nanoid(21), also the R2 key segment
  gallery_id     TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  subgallery_id  TEXT REFERENCES subgalleries(id) ON DELETE CASCADE, -- NULL = gallery root
  kind           TEXT NOT NULL DEFAULT 'photo',  -- 'photo' | 'video'   (Phase 2)
  source         TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'guest'   (Phase 3)
  status         TEXT NOT NULL DEFAULT 'approved', -- 'pending' | 'approved' | 'rejected'
  uploader_name  TEXT,                           -- guest-supplied name (Phase 3)
  filename       TEXT NOT NULL,                  -- original, preserved for downloads
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  duration_ms    INTEGER,                        -- video only (Phase 2)
  size_bytes     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_assets_gallery ON assets(gallery_id, subgallery_id, filename);
CREATE INDEX idx_assets_moderation ON assets(gallery_id, status) WHERE status = 'pending';

CREATE TABLE zips (
  id             TEXT PRIMARY KEY,
  gallery_id     TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  subgallery_id  TEXT REFERENCES subgalleries(id) ON DELETE CASCADE, -- NULL = gallery-level
  status         TEXT NOT NULL,   -- 'stale' | 'building' | 'ready' | 'failed'
  size_bytes     INTEGER,
  photo_count    INTEGER,
  error          TEXT,
  built_at       INTEGER,
  UNIQUE (gallery_id, subgallery_id)
);
```

**Ordering:** photos always sort by `filename` ascending. No manual reordering.

---

## 5. Authentication

### Admin — Cloudflare Access
Access policy protects `/admin/*` and `/api/admin/*`. The Worker **must still verify**
the `Cf-Access-Jwt-Assertion` header against the team's public keys — do not trust the
route alone, since the Worker is reachable via the workers.dev hostname otherwise.
Disable the workers.dev route in production as defense in depth.

### Client — gallery password
- Passwords are stored **in plaintext** in D1. This is deliberate: Joshua needs to look
  up and re-send a gallery password months later. These are low-stakes delivery
  passwords, not account credentials.
- On successful password entry, set a cookie:
  - Name: `g_{gallery_id}`
  - Value: HMAC-SHA256 signature of `{gallery_id}:{expiry}` using `COOKIE_SECRET`
  - `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=2592000` (30 days)
- A gallery with `password IS NULL` is open to anyone with the link.

### Two share-link formats
Both must be available from the admin UI as one-click copy buttons:

1. **Link + password** — `https://gallery.contentbycarmack.com/soccer2026`
   Client lands on a password form and types it.
2. **Baked-in** — `https://gallery.contentbycarmack.com/soccer2026?k=<urlencoded>`
   The page auto-submits the password and immediately replaces the URL via
   `history.replaceState()` so the password does not linger in the address bar.

*Note:* the baked-in form puts the password in browser history and potentially in
referrer headers. Acceptable for this use case, but the two options should be
labeled clearly in the admin UI so the choice is deliberate.

---

## 6. Upload Pipeline

Uploads go **through the Worker** (not presigned URLs). Web-sized JPEGs are a few MB
each, well under the 100 MB request limit, and this avoids implementing S3 SigV4
entirely. If RAW or full-resolution originals are ever added, revisit with presigned
multipart uploads.

### Browser-side steps
1. Admin drops files or a folder tree. Use `webkitGetAsEntry()` to walk directories:
   - Top-level folder name → gallery title (pre-filled, editable)
   - Each subfolder → a sub-gallery, named from the folder
   - Loose files at the top level → photos at the gallery root
   - *This is a convenience feature, not required. Plain multi-file select must also work.*
2. For each file, in a **Web Worker** (keeps the UI responsive):
   - `createImageBitmap(file, { imageOrientation: 'from-image' })` — this applies EXIF
     rotation correctly, which is the single most common bug in this kind of pipeline.
   - Record natural `width` / `height`.
   - Draw to an `OffscreenCanvas` scaled so the **longest edge is 600px**.
   - Export as JPEG at quality **0.82** → thumbnail blob.
3. `POST /api/admin/photos` with `multipart/form-data`: original file, thumbnail blob,
   dimensions, target gallery/sub-gallery.
4. Upload with a concurrency limit of **4**. Show per-file progress and an overall
   progress bar. Failed files retry up to 3 times, then surface in a retry list —
   a single failure must never abort the batch.

### Worker-side steps
1. Generate `photo_id = nanoid(21)`.
2. `BUCKET.put('p/{id}/f.jpg', ...)` and `BUCKET.put('p/{id}/t.jpg', ...)` with the
   cache headers from §3.
3. Insert the `photos` row.
4. Mark affected `zips` rows `stale`.

### Zip rebuild trigger
When the browser finishes a batch it calls `POST /api/admin/zips/rebuild` for the
gallery. This enqueues one queue message per stale zip. A manual **Rebuild Downloads**
button in the admin UI does the same thing, for when something looks wrong.

---

## 7. ZIP Generation

### Which zips exist
> **Rule: every level that directly contains photos gets its own ZIP.**

- Wedding gallery (photos at root, no sub-galleries) → one gallery-level ZIP.
- Soccer gallery (no photos at root, 12 sub-galleries) → 12 sub-gallery ZIPs, no
  gallery-level ZIP.
- If `zip_includes_subs = 1`, additionally build a gallery-level ZIP containing
  everything, with sub-gallery names as folders inside the archive. **Default off.**

### Building
Queue consumer, one zip per message:

1. Set `status = 'building'`.
2. Query all photos for the scope, ordered by filename.
3. Open an **R2 multipart upload**.
4. Stream a **store-mode (level 0) ZIP** using `fflate`'s streaming API. JPEGs are
   already compressed — deflate wastes CPU for near-zero gain. Store mode makes this
   an I/O job rather than a CPU job, which is what keeps it inside Worker limits.
5. Buffer output into ~10 MB chunks; upload each as a multipart part as it fills.
   Never buffer the whole archive — Worker memory is 128 MB.
6. Complete the multipart upload to `z/{zip_id}.zip`.
7. Set `status = 'ready'`, record `size_bytes`, `photo_count`, `built_at`.
8. Delete the previous archive object if the zip is being rebuilt.

### Details that matter
- **Filenames inside the archive** are the original `filename`. On collision, append
  `-2`, `-3`, etc.
- **ZIP64** must be enabled — required above 4 GB or 65,535 entries. `fflate` handles
  this; just don't disable it.
- **Subrequest limit:** each photo read is one subrequest, capped at 1,000 per
  invocation. At ~20 photos per team this is a non-issue, and a large wedding at
  800 photos still fits. If a gallery ever exceeds ~900 photos, the consumer must
  split across multiple queue messages, resuming the multipart upload by persisting
  the upload ID and part list. **Implement the guard and fail loudly rather than
  silently truncating the archive.**
- On failure: `status = 'failed'`, store the error, abort the multipart upload so no
  orphaned parts accrue.

### Client-facing behavior
- `status = 'ready'` → button reads "Download All (1.2 GB)".
- `status` is `stale` or `building` → button is disabled and reads
  "Preparing download…", with the page polling every 5s.
- `status = 'failed'` → button hidden; individual downloads still work.

---

## 8. Downloads and Image Quality

This is the requirement most likely to be quietly gotten wrong, so it is specified
explicitly.

**The grid shows thumbnails. The lightbox shows the full-size image.**

- Grid `<img src>` → `{PUBLIC_BUCKET_URL}/p/{id}/t.jpg`
- Lightbox `<img src>` → `{PUBLIC_BUCKET_URL}/p/{id}/f.jpg`

A parent who right-clicks and saves *from the lightbox* gets the full-quality file.
Nobody saves from a thumbnail grid without opening the image first.

**Do not use `srcset` on gallery images.** The browser chooses which candidate to save
on right-click, and that choice is not controllable — it would silently hand out
thumbnails on some devices.

### Explicit download routes
`<a download>` is ignored for cross-origin URLs, so downloads route through the Worker:

- `GET /d/{photo_id}` — streams `p/{id}/f.jpg` from R2 with
  `Content-Disposition: attachment; filename="{original filename}"`
- `GET /z/{zip_id}` — streams `z/{id}.zip` with an attachment disposition and a
  sensible filename (`2026-Soccer-Wildcats.zip`). Must pass through `Range` requests
  so interrupted multi-gigabyte downloads can resume.

Both routes check the gallery session cookie.

Every lightbox gets a visible **Download** button hitting `/d/{photo_id}` — the
obvious path should be the correct one, with right-click as the fallback.

---

## 9. Routes

### Public
| Method | Path | Notes |
|---|---|---|
| GET | `/{gallery}` | Password gate, then gallery view |
| GET | `/{gallery}/{sub}` | Sub-gallery view |
| POST | `/api/gallery/{slug}/auth` | Body `{ password }`; sets cookie |
| GET | `/api/gallery/{slug}` | Gallery JSON; requires cookie |
| GET | `/d/{photo_id}` | Single photo download |
| GET | `/z/{zip_id}` | Archive download |

### Admin (behind Cloudflare Access)
| Method | Path |
|---|---|
| GET | `/admin/*` |
| GET / POST | `/api/admin/galleries` |
| GET / PATCH / DELETE | `/api/admin/galleries/{id}` |
| POST / PATCH / DELETE | `/api/admin/subgalleries[/{id}]` |
| POST | `/api/admin/photos` |
| DELETE | `/api/admin/photos/{id}` |
| POST | `/api/admin/galleries/{id}/zips/rebuild` |
| GET | `/api/admin/stats` |

---

## 10. Client UI

Mobile-first. Most traffic is a parent on a phone following a link from a team email.

### Password screen
Gallery title, a single password field, submit. No branding chrome beyond the CBC logo.
Wrong password → inline error, no lockout.

### Gallery view
- If the gallery has sub-galleries: a card grid, each card showing the sub-gallery
  cover photo, title, and photo count.
- If the gallery has root-level photos: a justified photo grid plus a **Download All**
  button in the header.
- Both can appear at once — sub-gallery cards first, then loose photos.

### Sub-gallery view
Back link, title, **Download All** button, justified photo grid.

### Photo grid
- Justified rows using the stored `width`/`height` so layout settles before images
  load — no reflow jank.
- Lazy-load with `loading="lazy"`.
- Tap opens the lightbox.

### Lightbox
- Full-size image, prev/next arrows, close.
- Keyboard: arrows, Escape.
- Swipe on touch devices.
- Visible Download button.
- Preload the adjacent image in each direction.

---

## 11. Admin UI

- **Gallery list** — title, slug, photo count, storage used, created date.
- **Gallery editor** — title, slug, description, password, cover photo picker,
  `zip_includes_subs` toggle.
- **Sub-gallery management** — create, rename, reorder, delete, set cover.
- **Upload** — drag a folder tree or select files; live progress; retry list for
  failures.
- **Photo management** — grid view, multi-select delete, set as cover.
- **Share** — two copy buttons, clearly labeled: *Copy link* and
  *Copy link with password*.
- **Downloads** — per-zip status with a Rebuild button.
- **Storage** — total R2 usage and estimated monthly cost.

---

## 12. Operational Concerns

Easy to skip during the build, expensive to retrofit after clients are using it.

### Keep galleries out of search engines
Client wedding photos must not end up in Google Images. Required:
- `X-Robots-Tag: noindex, nofollow` on all public gallery routes **and** on the R2
  custom domain responses.
- `robots.txt` disallowing everything.
- `<meta name="robots" content="noindex">` on gallery pages.

The unguessable-URL model provides no protection here — a single client sharing a
link somewhere crawlable is enough to index the whole gallery.

### R2 is not the archive of record
Masters live on Joshua's own hardware, split across Lightroom and Capture One. The
gallery is a delivery mechanism only — **do not build backup or archival features into
it.** If R2 lost everything tomorrow, the correct response is to re-upload, not to
restore.

One cheap safety net is still worth having, because the *metadata* has no copy
anywhere: periodically export the D1 tables to R2 or the homelab, so gallery
structure, slugs, and passwords can be rebuilt without reconstructing them by hand.
D1 Time Travel also gives 30-day point-in-time restore at no cost and no setup.

### Deletes should be recoverable
Deleting a gallery cascades to hundreds of R2 objects and is irreversible. Implement
`deleted_at` soft-delete on galleries and sub-galleries, with actual R2 purge deferred
to a manual "empty trash" action. A typo in the admin UI should not be a client
incident.

### Orphaned R2 objects
If an R2 write succeeds and the D1 insert then fails, the object is billed forever and
referenced by nothing. Always write to R2 first, insert second, and delete the object
on insert failure. A periodic reconciliation job comparing R2 keys against `assets`
rows is worth adding once the app is real.

### Duplicate uploads
Re-dropping a folder should not silently double every photo. Check
`filename + size_bytes` within the target gallery on upload and skip or prompt on
match.

### Upload verification
After a 1,300-file batch, show a count reconciliation — files selected, uploaded,
skipped, failed. Silent partial success is the failure mode that gets discovered by a
client noticing their kid's photos are missing.

### iOS download behavior
This will generate support questions. On iOS Safari, the download button saves to
**Files**, not the camera roll — parents expect Photos. Long-pressing the image in the
lightbox and choosing *Add to Photos* does what they want. Show a small platform-aware
hint on iOS. Similarly, a multi-gigabyte ZIP is close to useless on a phone, which is
another reason individual downloads deserve the better UX for the sports galleries.

---

## 13. Future Work

Not in scope for Phase 1. The `assets` schema in §4 is already shaped to accommodate
Phases 2 and 3 without migration.

### Phase 2 — Video delivery (`kind = 'video'`)
Typically 1–4 files per project.
- **Upload is the hard part.** Worker request bodies cap at 100 MB, so video cannot go
  through the Worker. This is the trigger to implement presigned R2 multipart uploads.
- **Playback needs no transcoding.** R2 honors Range requests, so a plain `<video>`
  element pointed at the R2 URL streams progressively with working scrubbing.
  Cloudflare Stream is unnecessary at this volume.
- **Codec matters.** Deliver H.264/AAC in MP4 for in-browser playback. ProRes and HEVC
  will not play in most browsers; if a master file is delivered, treat it as
  download-only alongside a web-playable version.
- **Poster frames** use the same browser-side trick as thumbnails: load into a hidden
  `<video>`, seek a few seconds in, draw to canvas, upload the JPEG.
- **Exclude videos from ZIPs by default.** A 12 GB archive helps nobody.
- Storage roughly triples, landing near $1.50/month.

### Phase 3 — Guest uploads (`source = 'guest'`)
Disposable-camera-style contribution: guests at a wedding upload photos via a QR code
on table cards.

This inverts the trust model — Phase 1 has exactly one writer, and this adds a public
write endpoint. Minimum requirements:
- Cloudflare Turnstile on the upload page (free, native).
- Per-IP rate limiting, file size cap, and **magic-byte validation** rather than
  trusting file extensions.
- An upload window that opens and closes on set dates.
- **Moderation is not optional.** Guest uploads land as `status = 'pending'` and
  require approval before appearing in the gallery. An open bar plus an unmoderated
  public feed is a situation worth avoiding entirely.
- Browser-side resizing matters more here than for admin uploads — fifty guests
  pushing 5 MB phone photos over reception wifi needs the client-side pipeline that
  already exists.
- Worth noting this is a sellable feature, not just a cost saving; standalone apps in
  this space charge $20–100 per event.

### Unscheduled
- **Athlete filtering** — tagging assets with jersey numbers or names so parents can
  filter to their kid. Would need an `asset_tags` table. Desirable but not urgent.
- Automatic expiry with a warning email before deletion.
- Client email delivery of gallery links (Mailtrap SMTP or an n8n webhook).
- Simple per-gallery view counter — not to track *who*, just to answer "did they ever
  open it?"

---

## 14. Cost Model

At the expected workload — roughly 6 galleries per year, kept about a year, web-sized
JPEGs, plus pre-generated archives roughly doubling stored bytes:

| Item | Estimate |
|---|---|
| Storage (~25 GB, minus 10 GB free tier) | ~$0.22/mo |
| Class A ops (writes) | Well under the 1M free tier |
| Class B ops (reads) | Well under the 10M free tier, and edge-cached |
| Egress | $0.00 — R2 never charges egress |
| Workers / D1 / Queues | Covered by the existing $5 Workers plan |

**Effective marginal cost: under $1/month**, versus $180/year for ShootProof.

The free-egress property is what makes this viable — the same gallery downloaded by
forty parents costs nothing extra.

---

## 15. Implementation Order

1. Schema, bindings, Wrangler config, Cloudflare Access policy.
2. Admin CRUD for galleries and sub-galleries (no photos yet).
3. Upload pipeline with browser-side thumbnailing — the riskiest piece; validate EXIF
   orientation on real phone photos early.
4. Public gallery views, password gate, photo grid, lightbox.
5. Single-photo download route.
6. ZIP queue consumer and streaming multipart build.
7. Share-link copy buttons, storage stats, polish.

Ship 1–5 first. Individual downloads make the app genuinely usable without archives,
which de-risks the one component with real platform constraints.