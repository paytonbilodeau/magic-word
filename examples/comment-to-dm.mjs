// Run an actual MCP client against an isolated sample inbox. No provider account is needed.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = await mkdtemp(join(tmpdir(), 'magic-word-example-'));
const client = new Client({ name: 'guide-example', version: '1' });
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../mcp/stdio.mjs', import.meta.url))],
      env: { MAGICWORD_DATA_DIR: dir },
      stderr: 'pipe',
    }),
  );
  assert.equal((await call('status')).mode, 'demo');
  const tools = await client.listTools();
  const { id } = await call('create_flow', { template: 'comment' });
  const { graph } = await call('get_flow', { id });
  const media_id = '123456789';
  graph.trigger = { ...graph.trigger, keyword: 'GUIDE', media_id, public_reply: null };
  const messages = graph.nodes.filter((node) => node.kind === 'message');
  messages[0].data.bubbles[0].text = 'Want the guide? Tap below.';
  messages[1].data.bubbles[0].text = 'Here is your guide.';
  messages[1].data.bubbles[0].buttons[0].url = 'https://example.com/guide';
  await call('rename_flow', { id, name: 'Send the guide' });
  await call('save_draft', { id, graph });
  await call('publish_flow', { id, confirm: true });
  const match = await call('match_comment', { text: 'GUIDE please', media_id });
  assert.equal(match.matched?.id, id);
  assert.equal(match.delivered, false);
  assert.equal((await call('match_comment', { text: 'Just looking', media_id })).matched, null);
  console.log('“GUIDE please” → Send the guide\n“Just looking” → no match\nMessages sent: 0');
  console.log('MCP tools discovered: ' + tools.tools.length);
} finally {
  try {
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
