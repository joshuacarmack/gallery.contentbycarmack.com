// Thumbnail generation in a Web Worker (SPECS.md §6). createImageBitmap with
// imageOrientation: 'from-image' applies EXIF rotation — the single most
// common bug in this kind of pipeline.

const LONGEST_EDGE = 600;
const JPEG_QUALITY = 0.82;

export interface ThumbRequest {
  seq: number;
  file: File;
}

export interface ThumbResponse {
  seq: number;
  thumb?: Blob;
  width?: number;
  height?: number;
  error?: string;
}

self.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { seq, file } = e.data;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width, height } = bitmap;
    const scale = Math.min(1, LONGEST_EDGE / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));

    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, tw, th);
    bitmap.close();

    const thumb = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const msg: ThumbResponse = { seq, thumb, width, height };
    self.postMessage(msg);
  } catch (err) {
    const msg: ThumbResponse = { seq, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(msg);
  }
};
