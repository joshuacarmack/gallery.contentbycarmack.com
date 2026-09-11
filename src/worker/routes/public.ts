import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { makeGalleryCookie, verifyGalleryCookie } from '../lib/cookies';
import type {
  PhotoInfo,
  PublicGallery,
  PublicSubgallery,
  SubgalleryCard,
  ZipInfo,
  ZipStatus,
} from '../../shared/types';

type Ctx = { Bindings: Env };

export const publicApi = new Hono<Ctx>();
export const downloads = new Hono<Ctx>();

interface GalleryRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  shoot_date: string | null;
  cover_photo_id: string | null;
  password: string | null;
  zip_includes_subs: number;
}

interface ZipRow {
  id: string;
  subgallery_id: string | null;
  status: ZipStatus;
  size_bytes: number | null;
  photo_count: number | null;
}

async function getLiveGallery(db: D1Database, slug: string): Promise<GalleryRow | null> {
  return db
    .prepare(
      `SELECT id, slug, title, description, shoot_date, cover_photo_id, password, zip_includes_subs
       FROM galleries WHERE slug = ? AND deleted_at IS NULL`,
    )
    .bind(slug)
    .first<GalleryRow>();
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function hasGalleryAccess(
  c: { req: { raw: Request } },
  gallery: GalleryRow,
  secret: string,
): Promise<boolean> {
  if (gallery.password === null) return true;
  const cookie = readCookie(c.req.raw, `g_${gallery.id}`);
  return verifyGalleryCookie(gallery.id, cookie, secret);
}

function zipInfo(row: ZipRow | null | undefined): ZipInfo | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    size_bytes: row.size_bytes,
    photo_count: row.photo_count,
  };
}

// kind = 'photo' excludes dedicated splash images (see admin.ts) — those are
// never meant to appear in a grid or a download.
const PHOTO_SELECT = `SELECT id, filename, width, height, size_bytes FROM assets
  WHERE gallery_id = ? AND status = 'approved' AND kind = 'photo'`;

// POST /api/gallery/:slug/auth — password check, sets session cookie
publicApi.post('/:slug/auth', async (c) => {
  const gallery = await getLiveGallery(c.env.DB, c.req.param('slug'));
  if (!gallery) return c.json({ error: 'not_found' }, 404);
  if (gallery.password === null) return c.json({ ok: true });

  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (typeof body.password !== 'string' || body.password !== gallery.password) {
    return c.json({ error: 'wrong_password' }, 401);
  }
  const cookie = await makeGalleryCookie(gallery.id, c.env.COOKIE_SECRET);
  setCookie(c, cookie.name, cookie.value, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: cookie.maxAge,
    path: '/',
  });
  return c.json({ ok: true });
});

// GET /api/gallery/:slug — gallery JSON; requires cookie if password-protected
publicApi.get('/:slug', async (c) => {
  const gallery = await getLiveGallery(c.env.DB, c.req.param('slug'));
  if (!gallery) return c.json({ error: 'not_found' }, 404);
  if (!(await hasGalleryAccess(c, gallery, c.env.COOKIE_SECRET))) {
    return c.json({ locked: true, title: gallery.title }, 401);
  }

  const [subs, rootPhotos, zips] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.slug, s.title, s.sort_order, s.cover_photo_id,
              (SELECT COUNT(*) FROM assets a
                 WHERE a.subgallery_id = s.id AND a.status = 'approved') AS photo_count
       FROM subgalleries s
       WHERE s.gallery_id = ? AND s.deleted_at IS NULL
       ORDER BY s.sort_order, s.title`,
    )
      .bind(gallery.id)
      .all<SubgalleryCard>(),
    c.env.DB.prepare(`${PHOTO_SELECT} AND subgallery_id IS NULL ORDER BY filename`)
      .bind(gallery.id)
      .all<PhotoInfo>(),
    c.env.DB.prepare(
      `SELECT id, subgallery_id, status, size_bytes, photo_count
       FROM zips WHERE gallery_id = ? AND subgallery_id IS NULL`,
    )
      .bind(gallery.id)
      .all<ZipRow>(),
  ]);

  const body: PublicGallery = {
    slug: gallery.slug,
    title: gallery.title,
    description: gallery.description,
    shoot_date: gallery.shoot_date,
    cover_photo_id: gallery.cover_photo_id,
    bucket_url: c.env.PUBLIC_BUCKET_URL,
    subgalleries: subs.results,
    photos: rootPhotos.results,
    zip: zipInfo(zips.results[0]),
  };
  return c.json(body);
});

// GET /api/gallery/:slug/:sub — sub-gallery photos
publicApi.get('/:slug/:sub', async (c) => {
  const gallery = await getLiveGallery(c.env.DB, c.req.param('slug'));
  if (!gallery) return c.json({ error: 'not_found' }, 404);
  if (!(await hasGalleryAccess(c, gallery, c.env.COOKIE_SECRET))) {
    return c.json({ locked: true, title: gallery.title }, 401);
  }

  const sub = await c.env.DB.prepare(
    `SELECT id, slug, title, cover_photo_id FROM subgalleries
     WHERE gallery_id = ? AND slug = ? AND deleted_at IS NULL`,
  )
    .bind(gallery.id, c.req.param('sub'))
    .first<{ id: string; slug: string; title: string; cover_photo_id: string | null }>();
  if (!sub) return c.json({ error: 'not_found' }, 404);

  const [photos, zip] = await Promise.all([
    c.env.DB.prepare(
      `${PHOTO_SELECT} AND subgallery_id = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, filename`,
    )
      .bind(gallery.id, sub.id, sub.cover_photo_id)
      .all<PhotoInfo>(),
    c.env.DB.prepare(
      `SELECT id, subgallery_id, status, size_bytes, photo_count
       FROM zips WHERE subgallery_id = ?`,
    )
      .bind(sub.id)
      .first<ZipRow>(),
  ]);

  const body: PublicSubgallery = {
    gallery_slug: gallery.slug,
    gallery_title: gallery.title,
    slug: sub.slug,
    title: sub.title,
    bucket_url: c.env.PUBLIC_BUCKET_URL,
    photos: photos.results,
    zip: zipInfo(zip),
  };
  return c.json(body);
});

// ---- Download routes (§8) ----

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

async function galleryAccessById(
  c: { req: { raw: Request } },
  db: D1Database,
  galleryId: string,
  secret: string,
): Promise<boolean> {
  const gallery = await db
    .prepare(`SELECT id, slug, title, description, password, zip_includes_subs
              FROM galleries WHERE id = ? AND deleted_at IS NULL`)
    .bind(galleryId)
    .first<GalleryRow>();
  if (!gallery) return false;
  return hasGalleryAccess(c, gallery, secret);
}

// GET /d/:photoId — single photo, full quality, attachment disposition
downloads.get('/d/:photoId', async (c) => {
  const photo = await c.env.DB.prepare(
    `SELECT id, gallery_id, filename FROM assets WHERE id = ? AND status = 'approved'`,
  )
    .bind(c.req.param('photoId'))
    .first<{ id: string; gallery_id: string; filename: string }>();
  if (!photo) return c.text('Not found', 404);
  if (!(await galleryAccessById(c, c.env.DB, photo.gallery_id, c.env.COOKIE_SECRET))) {
    return c.text('Forbidden', 403);
  }

  const obj = await c.env.BUCKET.get(`p/${photo.id}/f.jpg`);
  if (!obj) return c.text('Not found', 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('content-length', String(obj.size));
  headers.set(
    'content-disposition',
    `attachment; filename="${sanitizeFilename(photo.filename)}"`,
  );
  return new Response(obj.body, { headers });
});

// GET /z/:zipId — archive download with Range passthrough for resume
downloads.get('/z/:zipId', async (c) => {
  const zip = await c.env.DB.prepare(
    `SELECT z.id, z.gallery_id, z.status, g.title AS gallery_title, s.title AS sub_title
     FROM zips z
     JOIN galleries g ON g.id = z.gallery_id
     LEFT JOIN subgalleries s ON s.id = z.subgallery_id
     WHERE z.id = ?`,
  )
    .bind(c.req.param('zipId'))
    .first<{
      id: string;
      gallery_id: string;
      status: string;
      gallery_title: string;
      sub_title: string | null;
    }>();
  if (!zip || zip.status !== 'ready') return c.text('Not found', 404);
  if (!(await galleryAccessById(c, c.env.DB, zip.gallery_id, c.env.COOKIE_SECRET))) {
    return c.text('Forbidden', 403);
  }

  const rangeHeader = c.req.raw.headers.get('range');
  const obj = await c.env.BUCKET.get(
    `z/${zip.id}.zip`,
    rangeHeader ? { range: c.req.raw.headers } : undefined,
  );
  if (!obj) return c.text('Not found', 404);

  const name = sanitizeFilename(
    [zip.gallery_title, zip.sub_title].filter(Boolean).join('-').replace(/\s+/g, '-'),
  );
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-type', 'application/zip');
  headers.set('content-disposition', `attachment; filename="${name || 'gallery'}.zip"`);

  if (rangeHeader && obj.range && 'offset' in obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});
