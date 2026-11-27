import { createServer as http } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { connection } from './server.mjs';
import { endpoint } from './endpoint.mjs';

export function gateway(env = process.env, call = connection(env), keySet) {
  const handle = endpoint(env, call, keySet);
  return http(async (req, res) => {
    try {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req);
      const request = new Request('http://127.0.0.1' + req.url, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      });
      const result = await handle(request);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  gateway().listen(
    Number(process.env.MAGICWORD_MCP_PORT || 8792),
    process.env.MAGICWORD_MCP_BIND || '127.0.0.1',
    () => console.log('Remote MCP gateway listening.'),
  );
}
