// Batch upload pipeline (SPECS.md §6): Web Worker thumbnails, concurrency 4,
// 3 retries per file, per-file + overall progress. A single failure never
// aborts the batch.

import type { ThumbResponse } from './thumb.worker';

export type UploadStatus = 'queued' | 'processing' | 'uploading' | 'done' | 'skipped' | 'failed';

export interface UploadTask {
  file: File;
  subfolder: string | null; // folder name from a dropped tree (resolved to a sub-gallery by the caller)
  subgalleryId: string | null;
  status: UploadStatus;
  progress: number; // 0..1 upload progress for this file
  error?: string;
}

export interface BatchSummary {
  selected: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

// ---- Folder-tree walking (webkitGetAsEntry) ----

export interface WalkedDrop {
  topFolder: string | null; // set when a single folder was dropped
  files: { file: File; subfolder: string | null }[];
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FsFileEntry extends FsEntry {
  file(ok: (f: File) => void, err: (e: unknown) => void): void;
}
interface FsDirEntry extends FsEntry {
  createReader(): {
    readEntries(ok: (entries: FsEntry[]) => void, err: (e: unknown) => void): void;
  };
}

function readAllEntries(dir: FsDirEntry): Promise<FsEntry[]> {
  // readEntries returns results in batches of ≤100; keep reading until empty.
  return new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all: FsEntry[] = [];
    const step = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          step();
        }
      }, reject);
    step();
  });
}

function entryFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function isImage(file: File): boolean {
  return /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name) || file.type.startsWith('image/');
}

async function collectDir(
  dir: FsDirEntry,
  subfolder: string | null,
  out: WalkedDrop['files'],
): Promise<void> {
  for (const entry of await readAllEntries(dir)) {
    if (entry.isFile) {
      const file = await entryFile(entry as FsFileEntry);
      if (isImage(file)) out.push({ file, subfolder });
    } else if (entry.isDirectory) {
      // Two-level structure only: deeper folders flatten into their sub-gallery.
      await collectDir(entry as FsDirEntry, subfolder ?? entry.name, out);
    }
  }
}

/** Walks a drop. A single dropped folder maps: its root files → gallery root,
 *  each subfolder → a sub-gallery. Multiple dropped folders each become subs. */
export async function walkDataTransfer(dt: DataTransfer): Promise<WalkedDrop> {
  const items = [...dt.items].filter((i) => i.kind === 'file');
  const entries = items
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  const files: WalkedDrop['files'] = [];
  const dirs = entries.filter((e) => e.isDirectory);
  const singleFolder = dirs.length === 1 && entries.length === 1;
  let topFolder: string | null = null;

  for (const entry of entries) {
    if (entry.isFile) {
      const file = await entryFile(entry as unknown as FsFileEntry);
      if (isImage(file)) files.push({ file, subfolder: null });
    } else if (entry.isDirectory) {
      if (singleFolder) {
        topFolder = entry.name;
        await collectDir(entry as unknown as FsDirEntry, null, files);
      } else {
        await collectDir(entry as unknown as FsDirEntry, entry.name, files);
      }
    }
  }
  return { topFolder, files };
}

// ---- Thumbnail worker bridge ----

let worker: Worker | null = null;
let seqCounter = 0;
const pending = new Map<number, (r: ThumbResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./thumb.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ThumbResponse>) => {
      const resolve = pending.get(e.data.seq);
      pending.delete(e.data.seq);
      resolve?.(e.data);
    };
  }
  return worker;
}

function makeThumb(file: File): Promise<ThumbResponse> {
  return new Promise((resolve) => {
    const seq = ++seqCounter;
    pending.set(seq, resolve);
    getWorker().postMessage({ seq, file });
  });
}

// ---- Upload ----

function uploadOne(
  galleryId: string,
  task: UploadTask,
  thumb: Blob,
  width: number,
  height: number,
  onProgress: (frac: number) => void,
): Promise<{ skipped: boolean }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set('gallery_id', galleryId);
    if (task.subgalleryId) form.set('subgallery_id', task.subgalleryId);
    form.set('width', String(width));
    form.set('height', String(height));
    form.set('file', task.file, task.file.name);
    form.set('thumb', thumb, 't.jpg');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/photos');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { skipped?: boolean };
          resolve({ skipped: body.skipped === true });
        } catch {
          resolve({ skipped: false });
        }
      } else {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.send(form);
  });
}

export async function runBatch(
  galleryId: string,
  tasks: UploadTask[],
  onUpdate: () => void,
): Promise<BatchSummary> {
  let index = 0;

  async function processTask(task: UploadTask): Promise<void> {
    task.status = 'processing';
    onUpdate();
    const thumb = await makeThumb(task.file);
    if (thumb.error || !thumb.thumb || !thumb.width || !thumb.height) {
      task.status = 'failed';
      task.error = thumb.error ?? 'thumbnail failed';
      onUpdate();
      return;
    }
    task.status = 'uploading';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await uploadOne(galleryId, task, thumb.thumb, thumb.width, thumb.height, (f) => {
          task.progress = f;
          onUpdate();
        });
        task.status = res.skipped ? 'skipped' : 'done';
        task.progress = 1;
        onUpdate();
        return;
      } catch (e) {
        task.error = e instanceof Error ? e.message : String(e);
        task.progress = 0;
        if (attempt === MAX_ATTEMPTS) {
          task.status = 'failed';
          onUpdate();
        }
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      if (!task || task.status !== 'queued') continue;
      await processTask(task);
    }
  });
  await Promise.all(workers);

  return {
    selected: tasks.length,
    uploaded: tasks.filter((t) => t.status === 'done').length,
    skipped: tasks.filter((t) => t.status === 'skipped').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };
}

/** Uploads a dedicated splash-page image for a gallery: stored like a normal
 *  photo (full + thumb) but tagged kind='splash', so it never shows up in the
 *  photo grid, a ZIP, or any photo count — it's for the splash screen only. */
export function uploadSplashImage(
  galleryId: string,
  file: File,
  onProgress: (frac: number) => void,
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const thumb = await makeThumb(file);
      if (thumb.error || !thumb.thumb || !thumb.width || !thumb.height) {
        reject(new Error(thumb.error ?? 'thumbnail failed'));
        return;
      }
      const form = new FormData();
      form.set('gallery_id', galleryId);
      form.set('kind', 'splash');
      form.set('width', String(thumb.width));
      form.set('height', String(thumb.height));
      form.set('file', file, file.name);
      form.set('thumb', thumb.thumb, 't.jpg');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/photos');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as { id?: string; skipped?: boolean };
            if (!body.id) {
              throw new Error(
                body.skipped
                  ? 'a splash image with that filename and size is already set for this gallery'
                  : 'no id returned',
              );
            }
            resolve({ id: body.id });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
        }
      };
      xhr.send(form);
    })();
  });
}

/** Re-queue failed tasks for another run. */
export function requeueFailed(tasks: UploadTask[]): void {
  for (const t of tasks) {
    if (t.status === 'failed') {
      t.status = 'queued';
      t.progress = 0;
      t.error = undefined;
    }
  }
}
