import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { verifyAccessJwt } from './lib/access';
import { adminApi } from './routes/admin';
import { downloads, publicApi } from './routes/public';
import { handleZipBatch, type ZipJob } from './zip-consumer';

const app = new Hono<{ Bindings: Env }>();

// Keep client galleries out of search engines (§12).
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
});

app.onError((err, c) => {
  console.error(
    JSON.stringify({ event: 'unhandled_error', path: c.req.path, error: err.message }),
  );
  return c.json({ error: 'internal_error' }, 500);
});

// Cloudflare Access sits in front of /admin/* and /api/admin/*, but the Worker
// verifies the JWT itself — the route alone is not trusted (§5).
const accessGuard = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.raw.headers.get('Cf-Access-Jwt-Assertion') ?? undefined;
  const ok = await verifyAccessJwt(token, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD);
  if (!ok) return c.text('Forbidden', 403);
  await next();
});
app.use('/admin/*', accessGuard);
app.use('/admin', accessGuard);
app.use('/api/admin/*', accessGuard);

app.route('/api/admin', adminApi);
app.route('/api/gallery', publicApi);
app.route('/', downloads); // /d/:photoId and /z/:zipId

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

// Everything else — gallery pages, admin SPA, static files — comes from the
// assets binding (SPA fallback serves index.html for client-routed paths).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  queue: handleZipBatch,
} satisfies ExportedHandler<Env, ZipJob>;
