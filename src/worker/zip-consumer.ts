// ZIP builder (SPECS.md §7): streams a store-mode ZIP through an R2 multipart
// upload. Never buffers the whole archive — parts are exactly PART_SIZE bytes
// (R2 requires uniform part sizes except the last).

import { Zip, ZipPassThrough } from 'fflate';

export interface ZipJob {
  zipId: string;
}

const PART_SIZE = 10 * 1024 * 1024; // 10 MiB
// Each photo read is one subrequest; the invocation cap is 1,000. Fail loudly
// rather than silently truncating (§7).
const MAX_PHOTOS_PER_BUILD = 900;

interface ZipRow {
  id: string;
  gallery_id: string;
  subgallery_id: string | null;
}

interface PhotoRow {
  id: string;
  filename: string;
  size_bytes: number;
  sub_title: string | null;
}

/** Accumulates ZIP output and uploads exact PART_SIZE parts as they fill. */
class PartUploader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private parts: R2UploadedPart[] = [];
  private partNumber = 1;
  totalBytes = 0;

  constructor(private mpu: R2MultipartUpload) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.totalBytes += chunk.length;
  }

  private takeExact(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  async drain(): Promise<void> {
    while (this.buffered >= PART_SIZE) {
      const part = this.takeExact(PART_SIZE);
      this.parts.push(await this.mpu.uploadPart(this.partNumber++, part));
    }
  }

  async finish(): Promise<R2UploadedPart[]> {
    await this.drain();
    if (this.buffered > 0) {
      const part = this.takeExact(this.buffered);
      this.parts.push(await this.mpu.uploadPart(this.partNumber++, part));
    }
    return this.parts;
  }
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

function sanitizeEntry(name: string): string {
  return name.replace(/[\\:*?"<>|]/g, '_').replace(/^\/+/, '');
}

async function buildZip(env: Env, zipId: string): Promise<void> {
  const zip = await env.DB.prepare(
    `SELECT z.id, z.gallery_id, z.subgallery_id FROM zips z WHERE z.id = ?`,
  )
    .bind(zipId)
    .first<ZipRow>();
  if (!zip) return; // row was deleted since enqueue — nothing to do

  await env.DB.prepare(`UPDATE zips SET status = 'building', error = NULL WHERE id = ?`)
    .bind(zipId)
    .run();

  const gallery = await env.DB.prepare(
    `SELECT zip_includes_subs FROM galleries WHERE id = ?`,
  )
    .bind(zip.gallery_id)
    .first<{ zip_includes_subs: number }>();
  if (!gallery) throw new Error('gallery missing');

  // Gallery-level zip spans sub-galleries (as folders) only when the toggle is on.
  const spanSubs = zip.subgallery_id === null && gallery.zip_includes_subs === 1;

  let photos: PhotoRow[];
  if (zip.subgallery_id !== null) {
    photos = (
      await env.DB.prepare(
        `SELECT a.id, a.filename, a.size_bytes, NULL AS sub_title FROM assets a
         WHERE a.subgallery_id = ? AND a.status = 'approved' ORDER BY a.filename`,
      )
        .bind(zip.subgallery_id)
        .all<PhotoRow>()
    ).results;
  } else if (spanSubs) {
    photos = (
      await env.DB.prepare(
        `SELECT a.id, a.filename, a.size_bytes, s.title AS sub_title FROM assets a
         LEFT JOIN subgalleries s ON s.id = a.subgallery_id
         WHERE a.gallery_id = ? AND a.status = 'approved' AND a.kind = 'photo'
           AND (a.subgallery_id IS NULL OR s.deleted_at IS NULL)
         ORDER BY s.title, a.filename`,
      )
        .bind(zip.gallery_id)
        .all<PhotoRow>()
    ).results;
  } else {
    photos = (
      await env.DB.prepare(
        // kind = 'photo' excludes dedicated splash images — never downloadable.
        `SELECT a.id, a.filename, a.size_bytes, NULL AS sub_title FROM assets a
         WHERE a.gallery_id = ? AND a.subgallery_id IS NULL AND a.status = 'approved' AND a.kind = 'photo'
         ORDER BY a.filename`,
      )
        .bind(zip.gallery_id)
        .all<PhotoRow>()
    ).results;
  }

  if (photos.length === 0) {
    await env.BUCKET.delete(`z/${zipId}.zip`);
    await env.DB.prepare(`DELETE FROM zips WHERE id = ?`).bind(zipId).run();
    return;
  }
  if (photos.length > MAX_PHOTOS_PER_BUILD) {
    throw new Error(
      `zip scope has ${photos.length} photos, over the ${MAX_PHOTOS_PER_BUILD} single-invocation ` +
        `limit — split the build across multiple messages (SPECS.md §7) before this gallery ships`,
    );
  }

  const mpu = await env.BUCKET.createMultipartUpload(`z/${zipId}.zip`, {
    httpMetadata: { contentType: 'application/zip' },
  });
  const uploader = new PartUploader(mpu);

  try {
    let zipError: Error | null = null;
    const zipper = new Zip((err, dat) => {
      if (err) zipError = err;
      else uploader.push(dat);
    });

    const usedNames = new Set<string>();
    for (const photo of photos) {
      const obj = await env.BUCKET.get(`p/${photo.id}/f.jpg`);
      if (!obj) throw new Error(`missing R2 object for photo ${photo.id} (${photo.filename})`);
      const data = new Uint8Array(await obj.arrayBuffer());

      const base = photo.sub_title ? `${sanitizeEntry(photo.sub_title)}/` : '';
      const entryName = base + uniqueName(sanitizeEntry(photo.filename), usedNames);

      // ZipPassThrough = store mode (level 0); JPEGs are already compressed.
      const entry = new ZipPassThrough(entryName);
      zipper.add(entry);
      entry.push(data, true);
      if (zipError) throw zipError;
      await uploader.drain();
    }
    zipper.end();
    if (zipError) throw zipError;

    const parts = await uploader.finish();
    await mpu.complete(parts);
  } catch (e) {
    // Abort so no orphaned parts accrue (§7).
    try {
      await mpu.abort();
    } catch {
      // best effort — the upload may already be gone
    }
    throw e;
  }

  await env.DB.prepare(
    `UPDATE zips SET status = 'ready', size_bytes = ?, photo_count = ?, error = NULL, built_at = ?
     WHERE id = ?`,
  )
    .bind(uploader.totalBytes, photos.length, Math.floor(Date.now() / 1000), zipId)
    .run();
}

export async function handleZipBatch(batch: MessageBatch<ZipJob>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await buildZip(env, msg.body.zipId);
      msg.ack();
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ event: 'zip_build_failed', zipId: msg.body.zipId, error: errText, attempt: msg.attempts }));
      if (msg.attempts >= 3) {
        await env.DB.prepare(`UPDATE zips SET status = 'failed', error = ? WHERE id = ?`)
          .bind(errText, msg.body.zipId)
          .run();
        msg.ack();
      } else {
        // Transient failure — put it back to stale and let the queue retry.
        await env.DB.prepare(`UPDATE zips SET status = 'stale', error = ? WHERE id = ?`)
          .bind(errText, msg.body.zipId)
          .run();
        msg.retry();
      }
    }
  }
}
