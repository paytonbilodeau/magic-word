import app from './index.ts';
import { ORIGIN } from './brand';
import { connection } from '../mcp/server.mjs';
import { endpoint, isMetadata } from '../mcp/endpoint.mjs';

export { LiveHub } from './index.ts';

export default {
  ...app,
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path !== '/mcp' && !isMetadata(path)) return app.fetch(req, env, ctx);
    if (!env.ADMIN_PASSWORD) return new Response('Owner setup required', { status: 503 });
    const publicUrl = env.MAGICWORD_MCP_PUBLIC_URL || ORIGIN + '/mcp';
    try {
      const call = connection(
        {
          MAGICWORD_URL: new URL(publicUrl).origin,
          MAGICWORD_ADMIN_PASSWORD: env.ADMIN_PASSWORD,
        },
        (url, init) => app.fetch(new Request(url, init), env, ctx),
      );
      return await endpoint({ ...env, MAGICWORD_MCP_PUBLIC_URL: publicUrl }, call)(req);
    } catch {
      return new Response('MCP unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
