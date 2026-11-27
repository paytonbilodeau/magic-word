import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, connection } from './server.mjs';

import { hostedCredentials } from './hosted-profile.mjs';

const hosted = !process.env.MAGICWORD_URL && !process.env.MAGICWORD_DATA_DIR && hostedCredentials();
let call;
if (process.env.MAGICWORD_URL) {
  call = connection();
} else if (hosted) {
  call = connection({ MAGICWORD_URL: hosted.url, MAGICWORD_ADMIN_PASSWORD: hosted.password });
} else {
  // Local by default: a new AI session can use the sample store even when the browser server is closed.
  const demo = await import('../scripts/runtime.mjs');
  call = connection({ MAGICWORD_PASSWORD_FILE: demo.secretFile }, (url, init) =>
    demo.worker.fetch(new Request(url, init), demo.env, demo.ctx),
  );
}
if (hosted?.composio) {
  const { withComposio } = await import('./composio.mjs');
  call = withComposio(call, hosted.composio);
}
await createServer(call, process.env.MAGICWORD_READ_ONLY === '1').connect(new StdioServerTransport());
