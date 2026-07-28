// Gallery session cookies: HMAC-SHA256 over `{gallery_id}:{expiry}` (SPECS.md §5).

const COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function makeGalleryCookie(
  galleryId: string,
  secret: string,
): Promise<{ name: string; value: string; maxAge: number }> {
  const expiry = Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${galleryId}:${expiry}`),
  );
  return {
    name: `g_${galleryId}`,
    value: `${expiry}.${hex(sig)}`,
    maxAge: COOKIE_TTL_SECONDS,
  };
}

export async function verifyGalleryCookie(
  galleryId: string,
  cookieValue: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!cookieValue) return false;
  const dot = cookieValue.indexOf('.');
  if (dot < 1) return false;
  const expiry = cookieValue.slice(0, dot);
  const sigHex = cookieValue.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now() / 1000) return false;
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;

  const key = await hmacKey(secret);
  const sig = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
  // crypto.subtle.verify is constant-time.
  return crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    new TextEncoder().encode(`${galleryId}:${expiry}`),
  );
}
