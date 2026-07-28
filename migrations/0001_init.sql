-- CBC Gallery initial schema (SPECS.md §4, plus soft-delete from §12)

CREATE TABLE galleries (
  id                  TEXT PRIMARY KEY,          -- nanoid(21)
  slug                TEXT NOT NULL UNIQUE,      -- "soccer2026"
  title               TEXT NOT NULL,             -- "2026 Soccer"
  description         TEXT,
  password            TEXT,                      -- plaintext; NULL = public
  cover_photo_id      TEXT REFERENCES assets(id) ON DELETE SET NULL,
  zip_includes_subs   INTEGER NOT NULL DEFAULT 0, -- top-level zip spans sub-galleries
  deleted_at          INTEGER,                   -- soft delete; purge is manual
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
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (gallery_id, slug)
);

-- NOTE: named `assets`, not `photos` — future-proofing for video delivery and
-- guest uploads (SPECS.md §12). Unused columns cost nothing now.
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
-- SQLite treats NULLs as distinct in UNIQUE constraints, so the gallery-level
-- zip (subgallery_id IS NULL) needs its own uniqueness guarantee.
CREATE UNIQUE INDEX idx_zips_gallery_level ON zips(gallery_id) WHERE subgallery_id IS NULL;
