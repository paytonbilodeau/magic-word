import { createServer } from 'node:http';
import { live, port, bind, origin, secretFile, db, worker, env, pending, ctx } from './runtime.mjs';
const server = createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, origin);
    if (
      url.origin !== origin ||
      (!live && !['127.0.0.1', 'localhost'].includes((req.headers.host || '').split(':')[0]))
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      (!live || !env.META_IG_APP_ID) &&
      [
        '/auth/start',
        '/auth/login',
        '/auth/callback',
        '/meta',
      ].includes(url.pathname)
    ) {
      res.writeHead(409).end('Instagram is disconnected.');
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, env, ctx);
    const headers = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('Request failed');
  }
});
server.listen(port, bind, () =>
  console.log(
    'Magic Word ' +
      (live ? 'live host' : 'sample inbox') +
      ' at ' +
      origin +
      '/admin/dashboard\nLocal credentials: ' +
      secretFile,
  ),
);
let ticking = false;
const timer = live
  ? setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await worker.scheduled({}, env, { waitUntil: (p) => ctx.waitUntil(p) });
        await Promise.all([...pending]);
      } catch {
        console.error('Scheduled processing failed. Check the console health page.');
      } finally {
        ticking = false;
      }
    }, 60000)
  : null;
for (const sig of ['SIGINT', 'SIGTERM'])
  process.once(sig, () => {
    if (timer) clearInterval(timer);
    server.close(async () => {
      await Promise.allSettled([...pending]);
      db.close();
      process.exit(0);
    });
  });
