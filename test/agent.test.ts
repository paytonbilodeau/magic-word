import { it, expect, vi } from 'vitest';
import { agentRead } from '../src/agent';
import { makeD1 } from './d1shim';
import type { Env } from '../src/setter';
it('fulfills a verified matching deletion in one batch and preserves the other contact', async () => {
  const DB = makeD1();
  const env = { DB } as Env;
  const code = crypto.randomUUID();
  await DB.prepare("INSERT INTO deletion_requests VALUES(?1,'123','pending',0)").bind(code).run();
  for (const id of ['123', '234']) {
    await DB.prepare('INSERT INTO leads(subscriber_id,created_at) VALUES(?1,1)').bind(id).run();
    await DB.prepare("INSERT INTO contact_fields VALUES(?1,'email','example',0)").bind(id).run();
  }
  const req = (id: string) =>
    new Request('https://test.invalid', {
      method: 'POST',
      body: JSON.stringify({
        code,
        lead: id,
        confirm: true,
        identity_verified: true,
        external_copies_reviewed: true,
      }),
    });
  expect((await agentRead(env, req('234'), 'resolve_privacy')).status).toBe(409);
  expect((await agentRead(env, req('123'), 'resolve_privacy')).status).toBe(200);
  expect((await DB.prepare('SELECT subscriber_id FROM contact_fields').all()).results).toEqual([
    { subscriber_id: '234' },
  ]);
  expect(await DB.prepare('SELECT subject,state FROM deletion_requests').first()).toEqual({
    subject: '',
    state: 'completed',
  });
});

it('sends an Instagram manual reply once for a stable request ID', async () => {
  const DB = makeD1();
  const env = { DB, TRANSPORT: 'meta', SKOOL_LINK: 'https://example.com/guide' } as Env;
  await DB.prepare("INSERT INTO leads(subscriber_id,created_at,last_inbound_at) VALUES('123',?1,?1)")
    .bind(Date.now())
    .run();
  await DB.prepare("INSERT INTO settings(key,value) VALUES('ig_token','fixture')").run();
  const provider = vi.fn(async () => Response.json({ message_id: 'mid123' }));
  vi.stubGlobal('fetch', provider);
  try {
    const request_id = crypto.randomUUID();
    const send = (text: string) =>
      agentRead(
        env,
        new Request('https://test.invalid', {
          method: 'POST',
          body: JSON.stringify({ lead: '123', text, request_id, confirm: true }),
        }),
        'reply',
      );
    const first = await send('Your guide');
    expect(await first.text()).toContain('accepted');
    expect((await send('Your guide')).status).toBe(200);
    expect((await send('Something else')).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await DB.prepare("SELECT mid FROM messages WHERE role='bot'").first()).toEqual({ mid: 'mid123' });
  } finally {
    vi.unstubAllGlobals();
  }
});
