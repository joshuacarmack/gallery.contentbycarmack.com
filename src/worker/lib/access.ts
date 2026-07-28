// Cloudflare Access JWT verification for /admin/* and /api/admin/* (SPECS.md §5).
// The Access policy sits in front, but the Worker must still verify the
// Cf-Access-Jwt-Assertion header itself.
//
// When ACCESS_TEAM_DOMAIN is empty (local dev), verification is bypassed.

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

// JWKS cache. Module-level state is config-scoped (same for every request),
// not request-scoped, so this is safe across requests.
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function verifyAccessJwt(
  token: string | undefined,
  teamDomain: string,
  aud: string,
): Promise<boolean> {
  if (!teamDomain) return true; // local dev bypass
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256') return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return false;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return false;
  if (payload.iss !== `https://${teamDomain}`) return false;
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return false;

  let keys: Jwk[];
  try {
    keys = await getJwks(teamDomain);
  } catch {
    return false;
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation may have happened since the cache was filled; refetch once.
    jwksCache = null;
    try {
      keys = await getJwks(teamDomain);
    } catch {
      return false;
    }
  }
  const found = keys.find((k) => k.kid === header.kid);
  if (!found) return false;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: found.kty, n: found.n, e: found.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
}
