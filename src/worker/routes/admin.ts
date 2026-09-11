import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type {
  AdminGalleryDetail,
  AdminGallerySummary,
  AdminStats,
  AdminSubgallery,
  AdminZip,
  PhotoInfo,
  UploadResult,
} from '../../shared/types';

type Ctx = { Bindings: Env };

export const adminApi = new Hono<Ctx>();

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function badRequest(msg: string) {
  return Response.json({ error: msg }, { status: 400 });
}

// Ensure a zips row exists for a scope and mark it stale.
async function markZipStale(
  db: D1Database,
  galleryId: string,
  subgalleryId: string | null,
): Promise<void> {
  if (subgalleryId === null) {
    await db
      .prepare(
        `INSERT INTO zips (id, gallery_id, subgallery_id, status) VALUES (?, ?, NULL, 'stale')
         ON CONFLICT (gallery_id) WHERE subgallery_id IS NULL
         DO UPDATE SET status = 'stale'`,
      )
      .bind(nanoid(21), galleryId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO zips (id, gallery_id, subgallery_id, status) VALUES (?, ?, ?, 'stale')
         ON CONFLICT (gallery_id, subgallery_id)
         DO UPDATE SET status = 'stale'`,
      )
      .bind(nanoid(21), galleryId, subgalleryId)
      .run();
  }
}

// ---- Galleries ----

adminApi.get('/galleries', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.id, g.slug, g.title, g.password, g.deleted_at, g.created_at,
            (SELECT COUNT(*) FROM assets a WHERE a.gallery_id = g.id AND a.kind = 'photo') AS photo_count,
            (SELECT COALESCE(SUM(a.size_bytes), 0) FROM assets a WHERE a.gallery_id = g.id AND a.kind = 'photo') AS size_bytes
     FROM galleries g ORDER BY g.created_at DESC`,
  ).all<AdminGallerySummary>();
  return c.json(rows.results);
});

adminApi.post('/galleries', async (c) => {
  const body = await c.req.json<{
    slug?: string;
    title?: string;
    description?: string;
    password?: string;
  }>();
  if (!body.title?.trim()) return badRequest('title required');
  const slug = (body.slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return badRequest('invalid slug');

  const id = nanoid(21);
  const t = now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO galleries (id, slug, title, description, password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, slug, body.title.trim(), body.description ?? null, body.password || null, t, t)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return badRequest('slug already in use');
    throw e;
  }
  return c.json({ id, slug }, 201);
});

adminApi.get('/galleries/:id', async (c) => {
  const id = c.req.param('id');
  const gallery = await c.env.DB.prepare(`SELECT * FROM galleries WHERE id = ?`)
    .bind(id)
    .first<Omit<AdminGalleryDetail, 'subgalleries' | 'photos' | 'zips' | 'bucket_url' | 'cover_is_splash'>>();
  if (!gallery) return c.json({ error: 'not_found' }, 404);

  const [subs, photos, zips, coverAsset] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.gallery_id, s.slug, s.title, s.sort_order, s.cover_photo_id, s.deleted_at,
              (SELECT COUNT(*) FROM assets a WHERE a.subgallery_id = s.id) AS photo_count
       FROM subgalleries s WHERE s.gallery_id = ? AND s.deleted_at IS NULL
       ORDER BY s.sort_order, s.title`,
    )
      .bind(id)
      .all<AdminSubgallery>(),
    c.env.DB.prepare(
      // kind = 'photo' excludes a dedicated splash image set via the splash uploader.
      `SELECT id, filename, width, height, size_bytes FROM assets
       WHERE gallery_id = ? AND subgallery_id IS NULL AND kind = 'photo' ORDER BY filename`,
    )
      .bind(id)
      .all<PhotoInfo>(),
    c.env.DB.prepare(
      `SELECT id, gallery_id, subgallery_id, status, size_bytes, photo_count, error, built_at
       FROM zips WHERE gallery_id = ?`,
    )
      .bind(id)
      .all<AdminZip>(),
    gallery.cover_photo_id
      ? c.env.DB.prepare(`SELECT kind FROM assets WHERE id = ?`)
          .bind(gallery.cover_photo_id)
          .first<{ kind: string }>()
      : Promise.resolve(null),
  ]);

  const body: AdminGalleryDetail = {
    ...gallery,
    cover_is_splash: coverAsset?.kind === 'splash',
    bucket_url: c.env.PUBLIC_BUCKET_URL,
    subgalleries: subs.results,
    photos: photos.results,
    zips: zips.results,
  };
  return c.json(body);
});

adminApi.patch('/galleries/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (typeof body.title === 'string' && body.title.trim()) {
    sets.push('title = ?');
    vals.push(body.title.trim());
  }
  if (typeof body.slug === 'string') {
    const slug = body.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return badRequest('invalid slug');
    sets.push('slug = ?');
    vals.push(slug);
  }
  if ('description' in body) {
    sets.push('description = ?');
    vals.push(typeof body.description === 'string' ? body.description : null);
  }
  if ('password' in body) {
    sets.push('password = ?');
    vals.push(typeof body.password === 'string' && body.password !== '' ? body.password : null);
  }
  if ('cover_photo_id' in body) {
    sets.push('cover_photo_id = ?');
    vals.push(typeof body.cover_photo_id === 'string' ? body.cover_photo_id : null);
  }
  if ('shoot_date' in body) {
    sets.push('shoot_date = ?');
    vals.push(typeof body.shoot_date === 'string' && body.shoot_date !== '' ? body.shoot_date : null);
  }
  if ('zip_includes_subs' in body) {
    sets.push('zip_includes_subs = ?');
    vals.push(body.zip_includes_subs ? 1 : 0);
  }
  if (sets.length === 0) return badRequest('nothing to update');

  sets.push('updated_at = ?');
  vals.push(now(), id);
  try {
    const res = await c.env.DB.prepare(`UPDATE galleries SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals)
      .run();
    if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return badRequest('slug already in use');
    throw e;
  }
  if ('zip_includes_subs' in body) {
    // Nesting membership of the gallery-level zip just changed; the previously
    // built zip (if any) no longer reflects which photos it should contain.
    await markZipStale(c.env.DB, id, null);
  }
  return c.json({ ok: true });
});

// Soft delete (§12) — R2 purge is a separate, explicit action.
adminApi.delete('/galleries/:id', async (c) => {
  await c.env.DB.prepare(`UPDATE galleries SET deleted_at = ? WHERE id = ?`)
    .bind(now(), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

adminApi.post('/galleries/:id/restore', async (c) => {
  await c.env.DB.prepare(`UPDATE galleries SET deleted_at = NULL WHERE id = ?`)
    .bind(c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

// Hard delete: R2 objects then rows. Only allowed on soft-deleted galleries.
adminApi.post('/galleries/:id/purge', async (c) => {
  const id = c.req.param('id');
  const gallery = await c.env.DB.prepare(
    `SELECT id, deleted_at FROM galleries WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; deleted_at: number | null }>();
  if (!gallery) return c.json({ error: 'not_found' }, 404);
  if (gallery.deleted_at === null) {
    return badRequest('gallery must be moved to trash before purging');
  }

  const assets = await c.env.DB.prepare(`SELECT id FROM assets WHERE gallery_id = ?`)
    .bind(id)
    .all<{ id: string }>();
  const zips = await c.env.DB.prepare(`SELECT id FROM zips WHERE gallery_id = ?`)
    .bind(id)
    .all<{ id: string }>();

  const keys: string[] = [];
  for (const a of assets.results) keys.push(`p/${a.id}/f.jpg`, `p/${a.id}/t.jpg`);
  for (const z of zips.results) keys.push(`z/${z.id}.zip`);
  for (let i = 0; i < keys.length; i += 1000) {
    await c.env.BUCKET.delete(keys.slice(i, i + 1000));
  }
  await c.env.DB.prepare(`DELETE FROM galleries WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, deleted_objects: keys.length });
});

// ---- Sub-galleries ----

adminApi.post('/subgalleries', async (c) => {
  const body = await c.req.json<{
    gallery_id?: string;
    slug?: string;
    title?: string;
    sort_order?: number;
  }>();
  if (!body.gallery_id || !body.title?.trim()) return badRequest('gallery_id and title required');
  const slug = (body.slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return badRequest('invalid slug');

  const id = nanoid(21);
  try {
    await c.env.DB.prepare(
      `INSERT INTO subgalleries (id, gallery_id, slug, title, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, body.gallery_id, slug, body.title.trim(), body.sort_order ?? 0, now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return badRequest('slug already in use in this gallery');
    if (String(e).includes('FOREIGN KEY')) return badRequest('gallery not found');
    throw e;
  }
  return c.json({ id, slug }, 201);
});

adminApi.patch('/subgalleries/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof body.title === 'string' && body.title.trim()) {
    sets.push('title = ?');
    vals.push(body.title.trim());
  }
  if (typeof body.slug === 'string') {
    const slug = body.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) return badRequest('invalid slug');
    sets.push('slug = ?');
    vals.push(slug);
  }
  if (typeof body.sort_order === 'number') {
    sets.push('sort_order = ?');
    vals.push(body.sort_order);
  }
  if ('cover_photo_id' in body) {
    sets.push('cover_photo_id = ?');
    vals.push(typeof body.cover_photo_id === 'string' ? body.cover_photo_id : null);
  }
  if (sets.length === 0) return badRequest('nothing to update');
  vals.push(c.req.param('id'));
  try {
    const res = await c.env.DB.prepare(
      `UPDATE subgalleries SET ${sets.join(', ')} WHERE id = ?`,
    )
      .bind(...vals)
      .run();
    if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return badRequest('slug already in use in this gallery');
    throw e;
  }
  return c.json({ ok: true });
});

adminApi.delete('/subgalleries/:id', async (c) => {
  await c.env.DB.prepare(`UPDATE subgalleries SET deleted_at = ? WHERE id = ?`)
    .bind(now(), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

adminApi.post('/subgalleries/:id/restore', async (c) => {
  await c.env.DB.prepare(`UPDATE subgalleries SET deleted_at = NULL WHERE id = ?`)
    .bind(c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

adminApi.post('/subgalleries/:id/purge', async (c) => {
  const id = c.req.param('id');
  const sub = await c.env.DB.prepare(
    `SELECT id, gallery_id, deleted_at FROM subgalleries WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; gallery_id: string; deleted_at: number | null }>();
  if (!sub) return c.json({ error: 'not_found' }, 404);
  if (sub.deleted_at === null) {
    return badRequest('sub-gallery must be moved to trash before purging');
  }

  const assets = await c.env.DB.prepare(`SELECT id FROM assets WHERE subgallery_id = ?`)
    .bind(id)
    .all<{ id: string }>();
  const zips = await c.env.DB.prepare(`SELECT id FROM zips WHERE subgallery_id = ?`)
    .bind(id)
    .all<{ id: string }>();
  const keys: string[] = [];
  for (const a of assets.results) keys.push(`p/${a.id}/f.jpg`, `p/${a.id}/t.jpg`);
  for (const z of zips.results) keys.push(`z/${z.id}.zip`);
  for (let i = 0; i < keys.length; i += 1000) {
    await c.env.BUCKET.delete(keys.slice(i, i + 1000));
  }
  await c.env.DB.prepare(`DELETE FROM subgalleries WHERE id = ?`).bind(id).run();
  return c.json({ ok: true, deleted_objects: keys.length });
});

// ---- Photos ----

// POST /api/admin/photos — multipart: file, thumb, gallery_id, subgallery_id?,
// width, height, kind? ('photo' | 'splash'). R2 first, D1 second; R2 objects
// deleted on insert failure (§12). kind = 'splash' is a dedicated splash-page
// image: it's excluded from every grid/zip/count query and never downloadable.
adminApi.post('/photos', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  const thumb = form.get('thumb');
  const galleryId = form.get('gallery_id');
  const subRaw = form.get('subgallery_id');
  const kindRaw = form.get('kind');
  const width = Number(form.get('width'));
  const height = Number(form.get('height'));

  if (!(file instanceof File) || !(thumb instanceof File)) return badRequest('file and thumb required');
  if (typeof galleryId !== 'string' || !galleryId) return badRequest('gallery_id required');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return badRequest('width and height required');
  }
  const kind = kindRaw === 'splash' ? 'splash' : 'photo';
  const subgalleryId = kind === 'splash' ? null : typeof subRaw === 'string' && subRaw !== '' ? subRaw : null;
  const filename = file.name;
  if (!filename) return badRequest('filename missing');

  const gallery = await c.env.DB.prepare(
    `SELECT id, zip_includes_subs FROM galleries WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(galleryId)
    .first<{ id: string; zip_includes_subs: number }>();
  if (!gallery) return badRequest('gallery not found');
  if (subgalleryId) {
    const sub = await c.env.DB.prepare(
      `SELECT id FROM subgalleries WHERE id = ? AND gallery_id = ? AND deleted_at IS NULL`,
    )
      .bind(subgalleryId, galleryId)
      .first();
    if (!sub) return badRequest('sub-gallery not found');
  }

  // Duplicate check (§12): filename + size within the target scope + kind —
  // a splash upload should never be silently skipped because a real photo
  // happens to share its name and size, or vice versa.
  const dupe = await c.env.DB.prepare(
    `SELECT id FROM assets WHERE gallery_id = ? AND subgallery_id IS ? AND filename = ? AND size_bytes = ? AND kind = ?`,
  )
    .bind(galleryId, subgalleryId, filename, file.size, kind)
    .first();
  if (dupe) {
    const result: UploadResult = { skipped: true };
    return c.json(result);
  }

  const id = nanoid(21);
  const contentType = file.type || 'image/jpeg';
  await c.env.BUCKET.put(`p/${id}/f.jpg`, file, {
    httpMetadata: { contentType, cacheControl: IMMUTABLE_CACHE },
  });
  await c.env.BUCKET.put(`p/${id}/t.jpg`, thumb, {
    httpMetadata: { contentType: 'image/jpeg', cacheControl: IMMUTABLE_CACHE },
  });

  try {
    await c.env.DB.prepare(
      `INSERT INTO assets (id, gallery_id, subgallery_id, filename, width, height, size_bytes, created_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, galleryId, subgalleryId, filename, width, height, file.size, now(), kind)
      .run();
  } catch (e) {
    // Orphan prevention (§12): the D1 insert failed, remove the R2 objects.
    await c.env.BUCKET.delete([`p/${id}/f.jpg`, `p/${id}/t.jpg`]);
    throw e;
  }

  if (kind === 'photo') {
    await markZipStale(c.env.DB, galleryId, subgalleryId);
    if (subgalleryId && gallery.zip_includes_subs) {
      await markZipStale(c.env.DB, galleryId, null);
    }
  }

  const result: UploadResult = { id };
  return c.json(result, 201);
});

adminApi.delete('/photos/:id', async (c) => {
  const id = c.req.param('id');
  const photo = await c.env.DB.prepare(
    `SELECT id, gallery_id, subgallery_id, kind FROM assets WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; gallery_id: string; subgallery_id: string | null; kind: string }>();
  if (!photo) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.prepare(`DELETE FROM assets WHERE id = ?`).bind(id).run();
  await c.env.BUCKET.delete([`p/${id}/f.jpg`, `p/${id}/t.jpg`]);
  if (photo.kind === 'photo') {
    await markZipStale(c.env.DB, photo.gallery_id, photo.subgallery_id);
  }
  return c.json({ ok: true });
});

// GET /api/admin/photos?subgallery_id=… — photos for a sub-gallery (admin grid)
adminApi.get('/photos', async (c) => {
  const sub = c.req.query('subgallery_id');
  if (!sub) return badRequest('subgallery_id required');
  const rows = await c.env.DB.prepare(
    `SELECT id, filename, width, height, size_bytes FROM assets
     WHERE subgallery_id = ? ORDER BY filename`,
  )
    .bind(sub)
    .all<PhotoInfo>();
  return c.json(rows.results);
});

// ---- Zips ----

// Reconcile which zip rows should exist, then enqueue every stale/failed one.
adminApi.post('/galleries/:id/zips/rebuild', async (c) => {
  const galleryId = c.req.param('id');
  const gallery = await c.env.DB.prepare(
    `SELECT id, zip_includes_subs FROM galleries WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(galleryId)
    .first<{ id: string; zip_includes_subs: number }>();
  if (!gallery) return c.json({ error: 'not_found' }, 404);

  const counts = await c.env.DB.prepare(
    `SELECT subgallery_id, COUNT(*) AS n FROM assets
     WHERE gallery_id = ? AND status = 'approved' AND kind = 'photo' GROUP BY subgallery_id`,
  )
    .bind(galleryId)
    .all<{ subgallery_id: string | null; n: number }>();

  const rootCount = counts.results.find((r) => r.subgallery_id === null)?.n ?? 0;
  const totalCount = counts.results.reduce((s, r) => s + r.n, 0);
  const neededSubs = counts.results
    .filter((r) => r.subgallery_id !== null)
    .map((r) => r.subgallery_id as string);
  const needsGalleryLevel = rootCount > 0 || (gallery.zip_includes_subs === 1 && totalCount > 0);

  // Create any missing rows, and force existing rows back to stale — a manual
  // rebuild is an explicit request to regenerate, regardless of prior status.
  if (needsGalleryLevel) {
    await c.env.DB.prepare(
      `INSERT INTO zips (id, gallery_id, subgallery_id, status) VALUES (?, ?, NULL, 'stale')
       ON CONFLICT (gallery_id) WHERE subgallery_id IS NULL DO UPDATE SET status = 'stale'`,
    )
      .bind(nanoid(21), galleryId)
      .run();
  }
  for (const subId of neededSubs) {
    await c.env.DB.prepare(
      `INSERT INTO zips (id, gallery_id, subgallery_id, status) VALUES (?, ?, ?, 'stale')
       ON CONFLICT (gallery_id, subgallery_id) DO UPDATE SET status = 'stale'`,
    )
      .bind(nanoid(21), galleryId, subId)
      .run();
  }

  // Drop rows for scopes that no longer contain photos.
  const allRows = await c.env.DB.prepare(
    `SELECT id, subgallery_id FROM zips WHERE gallery_id = ?`,
  )
    .bind(galleryId)
    .all<{ id: string; subgallery_id: string | null }>();
  for (const row of allRows.results) {
    const needed =
      row.subgallery_id === null ? needsGalleryLevel : neededSubs.includes(row.subgallery_id);
    if (!needed) {
      await c.env.BUCKET.delete(`z/${row.id}.zip`);
      await c.env.DB.prepare(`DELETE FROM zips WHERE id = ?`).bind(row.id).run();
    }
  }

  // Enqueue every stale/failed zip.
  const pending = await c.env.DB.prepare(
    `SELECT id FROM zips WHERE gallery_id = ? AND status IN ('stale', 'failed')`,
  )
    .bind(galleryId)
    .all<{ id: string }>();
  if (pending.results.length > 0) {
    await c.env.ZIP_QUEUE.sendBatch(
      pending.results.map((z) => ({ body: { zipId: z.id } })),
    );
  }
  return c.json({ enqueued: pending.results.length });
});

// ---- Stats ----

adminApi.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM galleries WHERE deleted_at IS NULL) AS gallery_count,
       (SELECT COUNT(*) FROM assets WHERE kind = 'photo') AS photo_count,
       (SELECT COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind = 'photo') AS photo_bytes,
       (SELECT COALESCE(SUM(size_bytes), 0) FROM zips WHERE status = 'ready') AS zip_bytes`,
  ).first<{
    gallery_count: number;
    photo_count: number;
    photo_bytes: number;
    zip_bytes: number;
  }>();
  const photoBytes = row?.photo_bytes ?? 0;
  const zipBytes = row?.zip_bytes ?? 0;
  // Thumbnails are small; count originals twice as a rough proxy for f + t.
  const totalBytes = photoBytes + zipBytes;
  const freeTier = 10 * 1024 ** 3;
  const billable = Math.max(0, totalBytes - freeTier);
  const stats: AdminStats = {
    gallery_count: row?.gallery_count ?? 0,
    photo_count: row?.photo_count ?? 0,
    photo_bytes: photoBytes,
    zip_bytes: zipBytes,
    total_bytes: totalBytes,
    estimated_monthly_cost_usd: Math.round(billable * 0.015 / 1024 ** 3 * 100) / 100,
  };
  return c.json(stats);
});
