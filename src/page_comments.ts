// A public comment permits one private reply addressed to the comment itself.
// Only an actual private inbound message can start the ordinary Messenger response window.
import { z } from 'zod';
import { matches } from './comments';
import type { Env } from './setter';

const postId = z.string().regex(/^\d+_\d+$/);
const input = z.object({
  post_id: postId,
  keyword: z.string().trim().min(1).max(200),
  reply: z.string().trim().min(1).max(1000),
  enabled: z.boolean(),
});
const envelope = z.object({
  object: z.literal('page'),
  entry: z.array(z.object({ id: z.string(), changes: z.array(z.unknown()).optional() })),
});
const change = z.object({
  field: z.literal('feed'),
  value: z.object({
    item: z.literal('comment'),
    verb: z.literal('add'),
    post_id: postId,
    comment_id: z.string().regex(/^\d+(?:_\d+)?$/),
    from: z.object({ id: z.string().regex(/^\d+$/) }),
    created_time: z.int().positive(),
    message: z.string().min(1),
  }),
});
type Receipt = { state: 'accepted' | 'rejected' | 'unknown'; provider_id: string | null };

export async function pageCommentRules(req: Request, env: Env) {
  if (req.method === 'GET')
    return Response.json(
      (await env.DB.prepare('SELECT * FROM page_comment_rules ORDER BY post_id,id').all()).results,
    );
  if (req.method !== 'POST') return new Response('GET or POST required', { status: 405 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response('A Page post ID, keyword and reply are required', { status: 400 });
  const rule = parsed.data;
  if (env.FB_PAGE_ID && rule.post_id.split('_')[0] !== env.FB_PAGE_ID)
    return new Response('Select a post from the connected Page', { status: 409 });
  const saved = await env.DB.prepare(
    'INSERT INTO page_comment_rules(post_id,keyword,reply,enabled) VALUES(?1,?2,?3,?4) ON CONFLICT(post_id,keyword) DO UPDATE SET reply=excluded.reply,enabled=excluded.enabled RETURNING id,post_id,enabled',
  )
    .bind(rule.post_id, rule.keyword, rule.reply, Number(rule.enabled))
    .first();
  return Response.json(saved);
}

export async function processPageComments(
  payload: unknown,
  env: Env,
  now: number,
  send: (id: string, text: string) => Promise<Receipt>,
) {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return;
  for (const entry of parsed.data.entry) {
    if (entry.id !== env.FB_PAGE_ID) continue;
    for (const raw of entry.changes ?? []) {
      const event = change.safeParse(raw);
      if (!event.success) continue;
      const c = event.data.value;
      const at = c.created_time * 1000;
      if (c.from.id === entry.id || c.post_id.split('_')[0] !== entry.id || at > now + 60_000) continue;
      const rules = await env.DB.prepare(
        'SELECT id,keyword,reply FROM page_comment_rules WHERE post_id=?1 AND enabled=1 ORDER BY id',
      )
        .bind(c.post_id)
        .all<{ id: number; keyword: string; reply: string }>();
      const rule = rules.results.find((option) => matches(option.keyword, c.message));
      if (!rule) continue;
      const withinWindow = now - at < 7 * 86400000;
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO channel_events(channel,event_id,contact,text,at,rule_id,reply,state) VALUES('facebook_comments',?1,?2,?3,?4,?5,?6,?7)",
      )
        .bind(
          c.comment_id,
          c.from.id,
          c.message,
          at,
          rule.id,
          withinWindow ? rule.reply : null,
          withinWindow ? 'sending' : 'expired',
        )
        .run();
      if (!claim.meta.changes || !withinWindow) continue;
      const person = await env.DB.prepare(
        'INSERT OR IGNORE INTO page_comment_claims(post_id,author_id,comment_id) VALUES(?1,?2,?3)',
      )
        .bind(c.post_id, c.from.id, c.comment_id)
        .run();
      if (!person.meta.changes) {
        await env.DB.prepare(
          "UPDATE channel_events SET state='already_replied',reply=NULL WHERE channel='facebook_comments' AND event_id=?1",
        )
          .bind(c.comment_id)
          .run();
        continue;
      }
      const receipt = await send(c.comment_id, rule.reply);
      await env.DB.prepare(
        "UPDATE channel_events SET state=?1, provider_id=?2 WHERE channel='facebook_comments' AND event_id=?3",
      )
        .bind(receipt.state, receipt.provider_id, c.comment_id)
        .run();
    }
  }
}
