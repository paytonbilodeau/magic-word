// Additional adapters support inbound private text, keyword replies and human replies.
// These channel rules are independent from the Instagram graph editor.
import { z } from 'zod';
import { pageCommentRules, processPageComments } from './page_comments';
import { matches } from './comments';
import { verifySignature } from './meta';
import type { Env } from './setter';

const channelType = z.enum(['telegram', 'messenger', 'whatsapp']);
type Channel = z.infer<typeof channelType>;
type Event = { id: string; contact: string; text: string; at: number };
type Delivered = { state: 'accepted' | 'rejected' | 'unknown'; provider_id: string | null };
const minDay = 24 * 60 * 60 * 1000;
const update = z.object({
  update_id: z.int(),
  message: z
    .object({
      chat: z.object({ id: z.int(), type: z.string() }),
      from: z.object({ is_bot: z.boolean() }).optional(),
      text: z.string(),
      date: z.int(),
    })
    .optional(),
});
const wa = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(),
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});
const fb = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z.object({ mid: z.string(), text: z.string(), is_echo: z.boolean().optional() }),
});
const metaEnvelope = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      messaging: z.array(z.unknown()).optional(),
      changes: z
        .array(
          z.object({
            field: z.string(),
            value: z.object({
              metadata: z.object({ phone_number_id: z.string() }).optional(),
              messages: z.array(z.unknown()).optional(),
            }),
          }),
        )
        .optional(),
    }),
  ),
});

function events(channel: Channel, data: unknown, env: Env): Event[] {
  if (channel === 'telegram') {
    const parsed = update.safeParse(data);
    if (!parsed.success) return [];
    const m = parsed.data.message;
    return m && m.chat.type === 'private' && !m.from?.is_bot
      ? [{ id: String(parsed.data.update_id), contact: String(m.chat.id), text: m.text, at: m.date * 1000 }]
      : [];
  }
  const parsed = metaEnvelope.safeParse(data);
  if (
    !parsed.success ||
    parsed.data.object !== (channel === 'messenger' ? 'page' : 'whatsapp_business_account')
  )
    return [];
  const result: Event[] = [];
  for (const e of parsed.data.entry) {
    if (channel === 'messenger' && e.id === env.FB_PAGE_ID) {
      for (const raw of e.messaging || []) {
        const p = fb.safeParse(raw);
        if (!p.success) continue;
        const m = p.data;
        if (!m.message.is_echo && m.recipient.id === env.FB_PAGE_ID && m.sender.id !== e.id)
          result.push({ id: m.message.mid, contact: m.sender.id, text: m.message.text, at: m.timestamp });
      }
    } else if (channel === 'whatsapp') {
      for (const c of e.changes || []) {
        if (c.field !== 'messages' || c.value.metadata?.phone_number_id !== env.WA_PHONE_ID) continue;
        for (const raw of c.value.messages || []) {
          const p = wa.safeParse(raw);
          if (p.success) {
            const m = p.data;
            result.push({ id: m.id, contact: m.from, text: m.text.body, at: Number(m.timestamp) * 1000 });
          }
        }
      }
    }
  }
  return result;
}
function configured(c: Channel, e: Env) {
  if (c === 'telegram') return !!(e.TG_BOT_TOKEN && e.TG_WEBHOOK_SECRET);
  return !!(
    e.CHANNEL_META_SECRET &&
    e.CHANNEL_VERIFY_TOKEN &&
    (c === 'messenger' ? e.FB_PAGE_ID && e.FB_PAGE_TOKEN : e.WA_PHONE_ID && e.WA_TOKEN)
  );
}
async function deliver(
  channel: Channel,
  contact: string,
  text: string,
  env: Env,
  toComment = false,
): Promise<Delivered> {
  const base = 'https://graph.facebook.com/v26.0/';
  const url =
    channel === 'telegram'
      ? 'https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage'
      : base + (channel === 'messenger' ? env.FB_PAGE_ID : env.WA_PHONE_ID) + '/messages';
  const body =
    channel === 'telegram'
      ? { chat_id: contact, text }
      : channel === 'messenger'
        ? {
            recipient: toComment ? { comment_id: contact } : { id: contact },
            messaging_type: 'RESPONSE',
            message: { text },
          }
        : { messaging_product: 'whatsapp', to: contact, type: 'text', text: { body: text } };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (channel !== 'telegram')
    headers.Authorization = 'Bearer ' + (channel === 'messenger' ? env.FB_PAGE_TOKEN : env.WA_TOKEN);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { state: response.status >= 500 ? 'unknown' : 'rejected', provider_id: null };
    const data = (await response.json()) as {
      result?: { message_id: number };
      message_id?: string;
      messages?: { id: string }[];
    };
    const id = data.result?.message_id ?? data.message_id ?? data.messages?.[0]?.id;
    return { state: id ? 'accepted' : 'unknown', provider_id: id ? String(id) : null };
  } catch {
    return { state: 'unknown', provider_id: null };
  }
}
export async function channelWebhook(req: Request, env: Env, channel: Channel, now = Date.now()) {
  if (!configured(channel, env)) return new Response('Channel is disconnected', { status: 503 });
  const q = new URL(req.url).searchParams;
  if (req.method === 'GET' && channel !== 'telegram') {
    const ok = q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === env.CHANNEL_VERIFY_TOKEN;
    return new Response(ok ? q.get('hub.challenge') : 'Forbidden', { status: ok ? 200 : 403 });
  }
  if (req.method !== 'POST') return new Response('POST required', { status: 405 });
  const raw = await req.text();
  const authentic =
    channel === 'telegram'
      ? req.headers.get('X-Telegram-Bot-Api-Secret-Token') === env.TG_WEBHOOK_SECRET
      : await verifySignature(env.CHANNEL_META_SECRET!, raw, req.headers.get('x-hub-signature-256'));
  if (!authentic) return new Response('Invalid signature', { status: 401 });
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (channel === 'messenger')
    await processPageComments(input, env, now, (id, text) => deliver('messenger', id, text, env, true));
  for (const m of events(channel, input, env)) {
    if (!Number.isSafeInteger(m.at) || m.at > now + 60_000 || !m.text) continue;
    const rules = await env.DB.prepare(
      'SELECT id,keyword,reply FROM channel_rules WHERE channel=?1 AND enabled=1 ORDER BY id',
    )
      .bind(channel)
      .all<{ id: number; keyword: string; reply: string }>();
    const rule = rules.results.find((r) => matches(r.keyword, m.text));
    const active = Boolean(rule && now - m.at < minDay);
    const claim = await env.DB.prepare(
      'INSERT OR IGNORE INTO channel_events(channel,event_id,contact,text,at,rule_id,reply,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)',
    )
      .bind(
        channel,
        m.id,
        m.contact,
        m.text,
        m.at,
        rule?.id ?? null,
        active ? rule!.reply : null,
        active ? 'sending' : 'received',
      )
      .run();
    if (!claim.meta.changes || !active) continue;
    const receipt = await deliver(channel, m.contact, rule!.reply, env);
    await env.DB.prepare('UPDATE channel_events SET state=?3,provider_id=?4 WHERE channel=?1 AND event_id=?2')
      .bind(channel, m.id, receipt.state, receipt.provider_id)
      .run();
  }
  return Response.json({ received: true });
}
const ruleInput = z.object({
  channel: channelType,
  keyword: z.string().trim().min(1).max(200),
  reply: z.string().trim().min(1).max(1000),
  enabled: z.boolean(),
});
const replyInput = z.object({
  channel: channelType,
  contact: z.string().regex(/^\d+$/),
  text: z.string().trim().min(1).max(1000),
  request_id: z.uuid(),
});
export async function channelAdmin(req: Request, env: Env, op: string, now = Date.now()) {
  if (op === 'page-comments') return pageCommentRules(req, env);
  const q = new URL(req.url).searchParams;
  if (req.method === 'GET') {
    if (op === 'connections')
      return Response.json(Object.fromEntries(channelType.options.map((k) => [k, configured(k, env)])));
    if (op === 'rules')
      return Response.json((await env.DB.prepare('SELECT * FROM channel_rules ORDER BY id').all()).results);
    if (op === 'inbox') {
      const offset = Math.max(0, Number(q.get('offset')) || 0);
      const rows = await env.DB.prepare(
        "SELECT * FROM (SELECT channel,event_id,contact,text,reply,at,state,provider_id FROM channel_events UNION ALL SELECT channel,request_id,contact,NULL,text,at,state,provider_id FROM channel_manual) WHERE (?1='' OR channel=?1) AND (?2='' OR contact=?2) ORDER BY at DESC,event_id LIMIT 50 OFFSET ?3",
      )
        .bind(q.get('channel') || '', q.get('contact') || '', offset)
        .all();
      return Response.json(rows.results);
    }
  }
  if (req.method === 'POST') {
    const body = await req.json().catch(() => null);
    if (op === 'rule') {
      const p = ruleInput.safeParse(body);
      if (!p.success) return new Response('Invalid rule', { status: 400 });
      const a = p.data;
      return Response.json(
        await env.DB.prepare(
          'INSERT INTO channel_rules(channel,keyword,reply,enabled) VALUES(?1,?2,?3,?4) ON CONFLICT(channel,keyword) DO UPDATE SET reply=excluded.reply,enabled=excluded.enabled RETURNING id,enabled',
        )
          .bind(a.channel, a.keyword, a.reply, Number(a.enabled))
          .first(),
      );
    }
    if (op === 'reply') {
      const p = replyInput.safeParse(body);
      if (!p.success) return new Response('Invalid reply', { status: 400 });
      const a = p.data;
      const prior = await env.DB.prepare('SELECT * FROM channel_manual WHERE request_id=?1')
        .bind(a.request_id)
        .first<{
          channel: string;
          contact: string;
          text: string;
          state: string;
          provider_id: string | null;
        }>();
      if (prior)
        return prior.channel === a.channel && prior.contact === a.contact && prior.text === a.text
          ? Response.json({ state: prior.state, provider_id: prior.provider_id })
          : new Response('Request ID already used', { status: 409 });
      const last = await env.DB.prepare(
        'SELECT max(at) AS at FROM channel_events WHERE channel=?1 AND contact=?2',
      )
        .bind(a.channel, a.contact)
        .first<{ at: number | null }>();
      if (!configured(a.channel, env) || !last?.at || now - last.at >= minDay)
        return Response.json(
          { error: 'A configured channel and recent inbound message are required.' },
          { status: 409 },
        );
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO channel_manual VALUES(?1,?2,?3,?4,?5,'sending',NULL)",
      )
        .bind(a.request_id, a.channel, a.contact, a.text, now)
        .run();
      if (!claim.meta.changes) return new Response('Request already in progress', { status: 409 });
      const receipt = await deliver(a.channel, a.contact, a.text, env);
      await env.DB.prepare('UPDATE channel_manual SET state=?2,provider_id=?3 WHERE request_id=?1')
        .bind(a.request_id, receipt.state, receipt.provider_id)
        .run();
      return Response.json(receipt);
    }
  }
  return new Response('Unknown operation', { status: 404 });
}
