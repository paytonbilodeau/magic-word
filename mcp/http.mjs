// Optional single-owner remote MCP gateway. The console itself never accepts an OAuth token as an admin password.
import { createServer as http } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, connection } from './server.mjs';

const hash = (s) => createHash('sha256').update(s).digest();
export function gateway(env = process.env, call = connection(env), keySet = createRemoteJWKSet) {
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
  return http(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    if (
      oauth &&
      req.method === 'GET' &&
      (path === '/.well-known/oauth-protected-resource/mcp' ||
        path === '/.well-known/oauth-protected-resource')
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          resource,
          authorization_servers: [issuer],
          scopes_supported: ['magic-word.read', 'magic-word.write'],
          bearer_methods_supported: ['header'],
        }),
      );
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== publicUrl.origin) {
      res.writeHead(403).end();
      return;
    }
    const bearer = (req.headers.authorization || '').match(/^Bearer (\S+)$/i)?.[1];
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
    if (!authorized) {
      res
        .writeHead(401, {
          'WWW-Authenticate': oauth ? 'Bearer resource_metadata="' + metadata + '"' : 'Bearer',
        })
        .end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let size = 0,
      chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const server = createServer(call, readonly || env.MAGICWORD_READ_ONLY === '1');
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once('close', () => void server.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  gateway().listen(Number(process.env.MAGICWORD_MCP_PORT || 8792), process.env.MAGICWORD_MCP_BIND || '127.0.0.1', () =>
    console.log('Remote MCP gateway listening.'),
  );
}
