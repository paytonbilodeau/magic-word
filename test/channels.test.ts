import { describe, it, expect, vi, afterEach } from 'vitest';
import { channelWebhook, channelAdmin } from '../src/channels';
import { hmacHex } from '../src/meta';
import { makeD1 } from './d1shim';
import type { Env } from '../src/setter';
const now = 1800000000000;
const env = () =>
  ({
    DB: makeD1(),
    TG_BOT_TOKEN: 'sample',
    TG_WEBHOOK_SECRET: 'fixture',
    CHANNEL_META_SECRET: 'meta',
    CHANNEL_VERIFY_TOKEN: 'verify',
    FB_PAGE_ID: '55',
    FB_PAGE_TOKEN: 'fb',
    WA_PHONE_ID: '99',
    WA_TOKEN: 'wa',
  }) as Env;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://test.invalid/', { method: 'POST', body: JSON.stringify(body), headers });
afterEach(() => vi.unstubAllGlobals());
describe.each(['telegram', 'messenger', 'whatsapp'] as const)('%s text replies', (channel) => {
  function payload(time: number) {
    if (channel === 'telegram')
      return {
        update_id: 42,
        message: { chat: { id: 77, type: 'private' }, text: 'GUIDE please', date: Math.floor(time / 1000) },
      };
    if (channel === 'messenger')
      return {
        object: 'page',
        entry: [
          {
            id: '55',
            messaging: [
              {
                sender: { id: '77' },
                recipient: { id: '55' },
                timestamp: time,
                message: { mid: 'm1', text: 'GUIDE please' },
              },
            ],
          },
        ],
      };
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'account',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '99' },
                messages: [
                  {
                    id: 'm1',
                    from: '77',
                    timestamp: String(time / 1000),
                    type: 'text',
                    text: { body: 'GUIDE please' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }
  async function signed(time = now) {
    const raw = payload(time);
    return post(
      raw,
      channel === 'telegram'
        ? { 'X-Telegram-Bot-Api-Secret-Token': 'fixture' }
        : { 'X-Hub-Signature-256': 'sha256=' + (await hmacHex('meta', JSON.stringify(raw))) },
    );
  }
  async function rule(e: Env) {
    await channelAdmin(
      post({ channel, keyword: 'guide', reply: 'Here it is', enabled: true }),
      e,
      'rule',
      now,
    );
  }
  it('accepts authenticated input exactly once across retries and records the outbound recipient and receipt', async () => {
    const e = env();
    await rule(e);
    const transport = vi.fn(async () =>
      Response.json({ message_id: 'ok', result: { message_id: 7 }, messages: [{ id: 'id' }] }),
    );
    vi.stubGlobal('fetch', transport);
    expect((await channelWebhook(post(payload(now)), e, channel, now)).status).toBe(401);
    for (let i = 0; i < 2; i++)
      expect((await channelWebhook(await signed(), e, channel, now)).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
    const [u, init] = (transport.mock.calls as unknown as [string, RequestInit][])[0];
    const b = JSON.parse(String(init.body));
    expect(u).toContain(
      channel === 'telegram' ? 'api.telegram.org' : channel === 'messenger' ? '/55/messages' : '/99/messages',
    );
    expect(b.chat_id ?? b.recipient?.id ?? b.to).toBe('77');
    const rows = (await (await channelAdmin(new Request('https://local'), e, 'inbox')).json()) as {
      state: string;
    }[];
    expect(rows[0].state).toBe('accepted');
  });
  it('keeps an uncertain delivery and suppresses replay', async () => {
    const e = env();
    await rule(e);
    const transport = vi.fn(async () => {
      throw Error('unknown');
    });
    vi.stubGlobal('fetch', transport);
    for (let i = 0; i < 2; i++) await channelWebhook(await signed(), e, channel, now);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await e.DB.prepare('SELECT state FROM channel_events').first()).toEqual({ state: 'unknown' });
  });
  it('checks the inbound window and the request ID before manual replies', async () => {
    const e = env();
    const transport = vi.fn(async () => Response.json({ message_id: 'ack' }));
    vi.stubGlobal('fetch', transport);
    const a = { channel, contact: '77', text: 'hello', request_id: crypto.randomUUID() };
    expect((await channelAdmin(post(a), e, 'reply', now)).status).toBe(409);
    await channelWebhook(await signed(), e, channel, now);
    for (let i = 0; i < 2; i++) expect((await channelAdmin(post(a), e, 'reply', now)).status).toBe(200);
    expect((await channelAdmin(post({ ...a, text: 'changed' }), e, 'reply', now)).status).toBe(409);
    expect(
      (await channelAdmin(post({ ...a, request_id: crypto.randomUUID() }), e, 'reply', now + 86400000))
        .status,
    ).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('records stale inbound events without sending and fails closed when disconnected', async () => {
    const e = env();
    await rule(e);
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await channelWebhook(await signed(now - 86400001), e, channel, now);
    expect(transport).not.toHaveBeenCalled();
    expect((await channelWebhook(await signed(), { DB: e.DB } as Env, channel, now)).status).toBe(503);
  });
});

describe('Facebook Page comment-to-DM', () => {
  const base = {
    item: 'comment',
    verb: 'add',
    comment_id: '100_20',
    post_id: '55_100',
    message: 'GUIDE please',
    from: { id: '77' },
    created_time: now / 1000,
  };
  const setup = async (e: Env) =>
    channelAdmin(
      post({ post_id: '55_100', keyword: 'guide', reply: 'Your guide', enabled: true }),
      e,
      'page-comments',
      now,
    );
  async function webhook(e: Env, over: Record<string, unknown> = {}, page = '55') {
    const body = {
      object: 'page',
      entry: [{ id: page, changes: [{ field: 'feed', value: { ...base, ...over } }] }],
    };
    return channelWebhook(
      post(body, { 'X-Hub-Signature-256': 'sha256=' + (await hmacHex('meta', JSON.stringify(body))) }),
      e,
      'messenger',
      now,
    );
  }
  it('addresses the comment once and keeps the Messenger window closed until a DM arrives', async () => {
    const e = env();
    await setup(e);
    const transport = vi.fn(async () => Response.json({ message_id: 'p1' }));
    vi.stubGlobal('fetch', transport);
    await webhook(e);
    await webhook(e);
    await webhook(e, { comment_id: '100_21' });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/55\/messages$/);
    expect(JSON.parse(String(init.body)).recipient).toEqual({ comment_id: '100_20' });
    expect((await e.DB.prepare('SELECT state FROM channel_events ORDER BY event_id').all()).results).toEqual([
      { state: 'accepted' },
      { state: 'already_replied' },
    ]);
    expect(
      (
        await channelAdmin(
          post({ channel: 'messenger', contact: '77', text: 'next', request_id: crypto.randomUUID() }),
          e,
          'reply',
          now,
        )
      ).status,
    ).toBe(409);
  });
  it('ignores unselected posts, Page activity, edits and unrelated words; records an expired matching comment', async () => {
    const e = env();
    await setup(e);
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    await webhook(e, { verb: 'edited' });
    await webhook(e, { from: { id: '55' } });
    await webhook(e, { post_id: '55_200' });
    await webhook(e, {}, '66');
    await webhook(e, { message: 'guideline' });
    await webhook(e, { created_time: (now - 7 * 86400000) / 1000 });
    expect(transport).not.toHaveBeenCalled();
    expect((await e.DB.prepare('SELECT state FROM channel_events').all()).results).toEqual([
      { state: 'expired' },
    ]);
  });
  it('holds an ambiguous send and permits a new person to request their own guide', async () => {
    const e = env();
    await setup(e);
    const transport = vi.fn(async () => {
      throw Error('unconfirmed');
    });
    vi.stubGlobal('fetch', transport);
    await webhook(e);
    await webhook(e, { comment_id: '100_21' });
    await webhook(e, { comment_id: '100_22', from: { id: '78' } });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      await e.DB.prepare("SELECT count(*) AS n FROM channel_events WHERE state='unknown'").first(),
    ).toEqual({ n: 2 });
    expect(
      (
        await channelAdmin(
          post({ post_id: '66_88', keyword: 'guide', reply: 'wrong Page', enabled: true }),
          e,
          'page-comments',
          now,
        )
      ).status,
    ).toBe(409);
  });
});
