import { timingSafeEqual, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.mjs';

export const isMetadata = (path) =>
  path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource';

const hash = (s) => createHash('sha256').update(s).digest();
export function endpoint(env, call, keySet = createRemoteJWKSet) {
  const publicUrl = new URL(env.MAGICWORD_MCP_PUBLIC_URL || 'http://127.0.0.1:8792/mcp');
  if (
    publicUrl.pathname !== '/mcp' ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  )
    throw Error('Set the canonical /mcp endpoint.');
  if (
    publicUrl.protocol !== 'https:' &&
    !(publicUrl.protocol === 'http:' && publicUrl.hostname === '127.0.0.1')
  )
    throw Error('A public MCP endpoint needs HTTPS.');
  const issuer = env.MAGICWORD_OAUTH_ISSUER,
    subject = env.MAGICWORD_OAUTH_SUBJECT,
    jwks = env.MAGICWORD_OAUTH_JWKS;
  const oauth = Boolean(issuer || subject || jwks);
  if (
    oauth &&
    (!issuer || !subject || !jwks || !issuer.startsWith('https://') || !jwks.startsWith('https://'))
  )
    throw Error('Configure the HTTPS issuer, JWKS and authorized owner subject.');
  const token = env.MAGICWORD_MCP_TOKEN;
  if (!oauth && (!token || token.length < 32))
    throw Error('Set an independent random MCP token of 32+ characters or configure owner OAuth.');
  const keys = oauth ? keySet(new URL(jwks)) : null;
  const resource = publicUrl.href;
  const metadata = publicUrl.origin + '/.well-known/oauth-protected-resource/mcp';
  return async function handle(req) {
    const path = new URL(req.url).pathname;
    const reply = (status, headers = {}) =>
      new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
    if (oauth && req.method === 'GET' && isMetadata(path)) {
      return Response.json(
        {
          resource,
          authorization_servers: [issuer],
          scopes_supported: ['magic-word.read', 'magic-word.write'],
          bearer_methods_supported: ['header'],
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (path !== '/mcp') return reply(404);
    const origin = req.headers.get('Origin');
    if (origin && origin !== publicUrl.origin) return reply(403);
    const bearer = (req.headers.get('Authorization') || '').match(/^Bearer (\S+)$/i)?.[1];
    let authorized = false,
      readonly = true;
    if (bearer && oauth) {
      try {
        const { payload } = await jwtVerify(bearer, keys, {
          issuer,
          audience: resource,
          algorithms: ['RS256', 'ES256'],
          requiredClaims: ['exp', 'sub'],
        });
        const scopes = String(payload.scope || '').split(' ');
        authorized = payload.sub === subject && scopes.includes('magic-word.read');
        readonly = !scopes.includes('magic-word.write');
      } catch {
        /* Fail closed. */
      }
    } else if (bearer && token && !oauth) {
      authorized = timingSafeEqual(hash(token), hash(bearer));
      readonly = false;
    }
    if (!authorized)
      return reply(401, {
        'WWW-Authenticate': oauth ? 'Bearer resource_metadata="' + metadata + '"' : 'Bearer',
      });
    if (req.method !== 'POST') return reply(405, { Allow: 'POST' });
    const reader = req.body?.getReader();
    if (!reader) return reply(400);
    let size = 0;
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return reply(413);
      }
      chunks.push(value);
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(400);
    }
    const server = createServer(call, readonly || env.MAGICWORD_READ_ONLY === '1');
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const result = await transport.handleRequest(req, { parsedBody });
      result.headers.set('Cache-Control', 'no-store');
      return result;
    } finally {
      await server.close();
    }
  };
}
