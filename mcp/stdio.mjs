import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, connection } from './server.mjs';

let call;
if (process.env.MAGICWORD_URL) {
  call = connection();
} else {
  // Local by default: a new AI session can use the sample store even when the browser server is closed.
  const demo = await import('../scripts/runtime.mjs');
  call = connection({ MAGICWORD_PASSWORD_FILE: demo.secretFile }, (url, init) =>
    demo.worker.fetch(new Request(url, init), demo.env, demo.ctx),
  );
}
await createServer(call, process.env.MAGICWORD_READ_ONLY === '1').connect(new StdioServerTransport());
