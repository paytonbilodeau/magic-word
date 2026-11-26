import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from 'jose';
import { gateway } from './http.mjs';
import { connection } from './server.mjs';
const script = fileURLToPath(new URL('./stdio.mjs', import.meta.url));
async function client(data, readOnly = false) {
  const c = new Client({ name: 'acceptance', version: '1' });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: { MAGICWORD_DATA_DIR: data, MAGICWORD_READ_ONLY: readOnly ? '1' : '0' },
      stderr: 'pipe',
    }),
  );
  return c;
}
async function ok(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  assert.ok(!r.isError, name + ': ' + r.content[0].text);
  return JSON.parse(r.content[0].text);
}
async function fails(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  assert.equal(r.isError, true, name + ' must reject');
}
test('real stdio client operates the default offline store and reopens its data', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'magicword-mcp-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  let c = await client(temp);
  t.after(async () => {
    await c.close();
  });
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(names.length >= 48);
  assert.equal((await ok(c, 'status')).mode, 'demo');
  for (const section of [
    'dashboard',
    'automations',
    'contacts',
    'inbox',
    'ai',
    'settings',
    'profile',
    'help',
  ])
    assert.ok((await ok(c, 'console_view', { section })).text.length > 0);
  const people = await ok(c, 'contacts');
  const lead = people[0].subscriber_id;
  for (const [name, args] of Object.entries({
    templates: {},
    comments: {},
    thread: { lead },
    tags: {},
    metrics: {},
    preferences: {},
    health: {},
    privacy_requests: {},
    fields: { lead },
    channel_rules: {},
    channel_inbox: {},
    channel_connections: {},
    list_flows: {},
  }))
    await ok(c, name, args);
  const { id } = await ok(c, 'create_flow', { template: 'comment' });
  assert.ok(id > 6);
  await ok(c, 'rename_flow', { id, name: 'Acceptance flow' });
  const { graph } = await ok(c, 'get_flow', { id });
  graph.trigger.keyword = 'MAGICTEST';
  graph.trigger.media_id = null;
  await ok(c, 'save_draft', { id, graph });
  await fails(c, 'publish_flow', { id });
  await ok(c, 'publish_flow', { id, confirm: true });
  assert.equal((await ok(c, 'match_comment', { text: 'magictest please' })).matched.id, id);
  assert.equal((await ok(c, 'match_comment', { text: 'unmatched example' })).matched, null);
  await ok(c, 'flow_audience', { id, set: 'clicked' });
  await ok(c, 'tag_flow_audience', { id, set: 'all', tag: 'demo' });
  await ok(c, 'test_flow', { id });
  await ok(c, 'toggle_flow', { id, confirm: true });
  await ok(c, 'duplicate_flow', { id });
  await ok(c, 'manage_folder', { act: 'create', name: 'Examples', confirm: true });
  await ok(c, 'move_flow', { id, folder: 'Examples' });
  await ok(c, 'bulk_flows', { act: 'move', ids: [id], folder: '/', confirm: true });
  await ok(c, 'discard_flow', { id, confirm: true });
  await ok(c, 'delete_flow', { id, confirm: true });
  await ok(c, 'restore_flow', { id });
  await ok(c, 'delete_flow', { id, confirm: true });
  await ok(c, 'purge_flow', { id, confirm: true });
  await fails(c, 'get_flow', { id });
  await ok(c, 'tag_contact', { lead, action: 'tag', tag: 'sample' });
  assert.ok((await ok(c, 'contacts', { tag: 'sample' })).some((x) => x.subscriber_id === lead));
  await ok(c, 'save_contact_field', { lead, name: 'source', value: 'demo' });
  await ok(c, 'pause_contact', { lead, action: 'pause', confirm: true });
  await ok(c, 'pause_contact', { lead, action: 'resume', confirm: true });
  await ok(c, 'save_link_settings', { link: 'https://example.com', tracking: false });
  await ok(c, 'save_ai_settings', {
    min_seconds: 1,
    max_seconds: 3,
    pause_on_manual_reply: true,
    auto_resume_hours: 0,
  });
  await ok(c, 'save_learned_answers', { text: 'Example' });
  await ok(c, 'exclude_handle', { handle: 'demo', action: 'add' });
  for (const [name, args] of Object.entries({
    media: { kind: 'posts' },
    reply: { lead, text: 'example', request_id: crypto.randomUUID(), confirm: true },
    react: { lead, mid: 'absent', emoji: 'x', confirm: true },
    toggle_autopilot: { confirm: true },
    toggle_contact_ai: { lead, confirm: true },
    set_instagram_profile: { section: 'menu', lines: 'Example', confirm: true },
    reply_on_channel: {
      channel: 'telegram',
      contact: '11',
      text: 'hi',
      request_id: crypto.randomUUID(),
      confirm: true,
    },
  }))
    await fails(c, name, args);
  await ok(c, 'save_channel_rule', {
    channel: 'telegram',
    keyword: 'guide',
    reply: 'link',
    enabled: false,
    confirm: true,
  });
  await ok(c, 'save_page_comment_rule', {
    post_id: '55_123',
    keyword: 'guide',
    reply: 'Here it is',
    enabled: false,
    confirm: true,
  });
  assert.equal((await ok(c, 'page_comment_rules'))[0].post_id, '55_123');
  await c.close();
  c = await client(temp, true);
  assert.equal((await ok(c, 'fields', { lead }))[0].value, 'demo');
  assert.ok(!(await c.listTools()).tools.some((x) => x.name === 'publish_flow'));
});
test('HTTP MCP authenticates, negotiates, lists and calls through the official client', async (t) => {
  assert.throws(() => gateway({}, async () => {}));
  assert.throws(() => connection({ MAGICWORD_URL: 'http://public.example' }));
  const token = 'test-fixture-'.repeat(4);
  const service = gateway({ MAGICWORD_MCP_TOKEN: token }, async () => ({ mode: 'fixture' }));
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  t.after(() => service.close());
  const url = new URL('http://127.0.0.1:' + service.address().port + '/mcp');
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Origin: 'https://unrelated.invalid', Authorization: 'Bearer ' + token },
      })
    ).status,
    403,
  );
  const c = new Client({ name: 'remote', version: '1' });
  await c.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  t.after(() => c.close());
  assert.ok((await c.listTools()).tools.some((x) => x.name === 'publish_flow'));
  assert.equal((await ok(c, 'status')).mode, 'fixture');
});
test('OAuth discovery, owner binding, write scopes and resource audience', async (t) => {
  const cfg = {
    MAGICWORD_MCP_PUBLIC_URL: 'https://mcp.example.org/mcp',
    MAGICWORD_OAUTH_ISSUER: 'https://identity.example.org/',
    MAGICWORD_OAUTH_JWKS: 'https://identity.example.org/keys',
    MAGICWORD_OAUTH_SUBJECT: 'owner',
  };
  const pair = await generateKeyPair('ES256');
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'proof', alg: 'ES256' };
  const sign = (over = {}, signer = pair.privateKey) =>
    new SignJWT({
      scope: 'magic-word.read',
      sub: 'owner',
      iss: cfg.MAGICWORD_OAUTH_ISSUER,
      aud: cfg.MAGICWORD_MCP_PUBLIC_URL,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...over,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'proof' })
      .sign(signer);
  const app = gateway(
    cfg,
    async () => ({}),
    (url) => {
      assert.equal(url.href, cfg.MAGICWORD_OAUTH_JWKS);
      return createLocalJWKSet({ keys: [key] });
    },
  );
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  assert.equal(
    (await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json()).resource,
    cfg.MAGICWORD_MCP_PUBLIC_URL,
  );
  assert.equal(
    (await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  const other = await generateKeyPair('ES256');
  for (const invalid of [
    await sign({ sub: 'stranger' }),
    await sign({ aud: 'https://wrong.example/' }),
    await sign({ iss: 'https://wrong.example/' }),
    await sign({ exp: 1 }),
    await sign({ scope: 'other' }),
    await sign({}, other.privateKey),
  ]) {
    assert.equal(
      (await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + invalid } }))
        .status,
      401,
    );
  }
  for (const access of ['read', 'write']) {
    const token = await sign({
      scope: access === 'write' ? 'magic-word.read magic-word.write' : 'magic-word.read',
    });
    const c = new Client({ name: 'remote', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }),
    );
    assert.equal(
      (await c.listTools()).tools.some((x) => x.name === 'reply'),
      access === 'write',
    );
    await c.close();
  }
});
