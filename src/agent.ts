// Owner-only structured reads shared by local and remote MCP clients. Keep credentials out of every response.
import { socialRead } from './social-reads';
import { youtubeRead } from './youtube';
import { manualReply, windowLeft } from './dashboard';
import { getLead } from './db';
import { z } from 'zod';
import { editorGraph, graphStats, validate } from './graph';
import { findTrigger, type Trigger } from './comments';
import { keyMetrics, TEMPLATES } from './admin_flows';
import { getConfig } from './settings';
import { friendHandles, getSetting } from './db';
import { aiBlocker } from './ready';
import { recentMedia, recentStories } from './meta';
import type { Env } from './setter';

export async function agentRead(env: Env, req: Request, view: string): Promise<Response> {
  if (req.method === 'POST' && view === 'resolve_privacy') {
    const schema = z.object({
      code: z.uuid(),
      lead: z.string().regex(/^\d+$/),
      identity_verified: z.literal(true),
      external_copies_reviewed: z.literal(true),
      confirm: z.literal(true),
    });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response('Verified identity and request required', { status: 400 });
    const { code, lead } = parsed.data;
    const row = await env.DB.prepare('SELECT subject,state FROM deletion_requests WHERE code=?1')
      .bind(code)
      .first<{ subject: string; state: string }>();
    if (!row || row.state !== 'pending' || row.subject !== lead)
      return Response.json(
        { error: 'The pending request must match the verified identifier.' },
        { status: 409 },
      );
    const byLead = [
      'messages',
      'drafts',
      'outbox',
      'flow_runs',
      'flow_sends',
      'flow_starts',
      'flow_hits',
      'clicks',
      'links',
      'lead_tags',
      'comments',
      'contact_fields',
      'ig_manual_requests',
      'joins',
      'roster',
      'ai_usage',
      'leads',
    ];
    const statements = [
      env.DB.prepare(
        'DELETE FROM flow_taps WHERE send_id IN (SELECT id FROM flow_sends WHERE subscriber_id=?1)',
      ).bind(lead),
      env.DB.prepare(
        'DELETE FROM media_cache WHERE mid IN (SELECT mid FROM messages WHERE subscriber_id=?1)',
      ).bind(lead),
      ...byLead.map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE subscriber_id=?1`).bind(lead)),
      env.DB.prepare('DELETE FROM errors WHERE ref=?1').bind(lead),
      env.DB.prepare(
        "UPDATE deletion_requests SET subject='',state='completed' WHERE subject=?1 AND state='pending'",
      ).bind(lead),
    ];
    await env.DB.batch(statements);
    return Response.json({
      state: 'completed',
      scope: 'matching structured Instagram records in this database',
    });
  }
  if (req.method === 'POST' && view === 'reply') {
    const schema = z.object({
      lead: z.string().regex(/^(g:)?[0-9]+$/),
      text: z.string().trim().min(1).max(1000),
      reply_to: z.string().max(300).optional(),
      request_id: z.uuid(),
      confirm: z.literal(true),
    });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response('Invalid reply', { status: 400 });
    const a = parsed.data;
    const payload = JSON.stringify([a.lead, a.text, a.reply_to ?? null]);
    const existing = await env.DB.prepare('SELECT payload,state FROM ig_manual_requests WHERE id=?1')
      .bind(a.request_id)
      .first<{ payload: string; state: string }>();
    if (existing)
      return existing.payload !== payload
        ? new Response('Request ID already used', { status: 409 })
        : Response.json({ state: existing.state }, { status: existing.state === 'accepted' ? 200 : 409 });
    const person = await getLead(env.DB, a.lead);
    if (
      !person ||
      !windowLeft(person, Date.now()) ||
      (!(await getSetting(env.DB, 'ig_token')) && !env.MANYCHAT_API_KEY)
    )
      return Response.json(
        { error: 'A connected account and a recent inbound message are required.' },
        { status: 409 },
      );
    const claimed = await env.DB.prepare(
      "INSERT OR IGNORE INTO ig_manual_requests VALUES(?1,?2,?3,'sending')",
    )
      .bind(a.request_id, a.lead, payload)
      .run();
    if (!claimed.meta.changes) return new Response('Request in progress', { status: 409 });
    const error = await manualReply(env, person, [a.text], Date.now(), a.reply_to);
    const state = error ? 'unconfirmed' : 'accepted';
    await env.DB.prepare('UPDATE ig_manual_requests SET state=?1 WHERE id=?2')
      .bind(state, a.request_id)
      .run();
    return Response.json(error ? { state, error } : { state }, { status: error ? 409 : 200 });
  }
  if (req.method === 'POST' && view === 'field') {
    const body = (await req.json().catch(() => null)) as {
      lead?: unknown;
      name?: unknown;
      value?: unknown;
    } | null;
    if (
      !body ||
      typeof body.lead !== 'string' ||
      !/^(g:)?[0-9]+$/.test(body.lead) ||
      typeof body.name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(body.name) ||
      typeof body.value !== 'string' ||
      body.value.length > 1000
    )
      return new Response('Invalid contact field', { status: 400 });
    if (!(await env.DB.prepare('SELECT 1 FROM leads WHERE subscriber_id=?1').bind(body.lead).first()))
      return new Response('Unknown contact', { status: 404 });
    await env.DB.prepare(
      'INSERT INTO contact_fields VALUES(?1,?2,?3,?4) ON CONFLICT(subscriber_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    )
      .bind(body.lead, body.name, body.value, Date.now())
      .run();
    return Response.json({ saved: true });
  }
  if (req.method !== 'GET') return new Response('GET required', { status: 405 });
  const q = new URL(req.url).searchParams;
  const page = Math.max(0, Math.floor(Number(q.get('offset')) || 0));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(q.get('limit')) || 25)));
  const id = Number(q.get('id'));
  const lead = q.get('lead') || '';
  const rows = async (sql: string, ...args: (string | number)[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...args)
        .all()
    ).results;
  const ok = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  switch (view) {
    case 'instagram_live_media':
    case 'instagram_live_comments':
    case 'instagram_live_inbox': {
      const token = await getSetting(env.DB, 'ig_token');
      if (!token) return Response.json({ error: 'Connect the Instagram account to this host or enable its local Composio connection.' }, { status: 409 });
      try {
        const data = await socialRead(async (_channel, url) => {
          const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (!res.ok) throw Error('Instagram returned HTTP ' + res.status);
          return res.json();
        }, view, limit, q.get('media') || undefined);
        return ok(data);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Instagram is unavailable.' }, { status: 502 });
      }
    }
    case 'youtube_videos':
    case 'youtube_comments':
      return youtubeRead(env, view, Math.min(limit, 50));
    case 'status':
      return ok({
        mode: env.HOST_MODE || 'worker',
        instagram_connected: Boolean(await getSetting(env.DB, 'ig_token')),
        ai_blocker: aiBlocker(env),
        config: await getConfig(env),
        last_webhook: await getSetting(env.DB, 'webhook_at'),
      });
    case 'templates':
      return ok(
        Object.entries(TEMPLATES).map(([key, t]) => ({
          key,
          name: t.name,
          description: t.desc,
          graph: t.graph(),
        })),
      );
    case 'flows':
      return ok(
        await rows(
          'SELECT id,name,source,keyword,folder,media_id,enabled,updated_at,published_at,deleted_at FROM triggers WHERE (?1 = 1 OR deleted_at IS NULL) ORDER BY id DESC LIMIT ?2 OFFSET ?3',
          q.get('trash') === 'true' ? 1 : 0,
          limit,
          page,
        ),
      );
    case 'flow': {
      const t = await env.DB.prepare('SELECT * FROM triggers WHERE id=?1').bind(id).first<Trigger>();
      if (!t) return new Response('Unknown automation', { status: 404 });
      const graph = await editorGraph(env.DB, t);
      return ok({
        id,
        name: t.name,
        enabled: !!t.enabled,
        deleted: !!t.deleted_at,
        graph,
        validation: validate(graph),
        metrics: await keyMetrics(env, id, 'admin'),
        nodes: await graphStats(env.DB, id),
      });
    }
    case 'comment_match': {
      const t = await findTrigger(env.DB, {
        media_id: q.get('media_id') || '',
        text: q.get('text') || '',
        comment_id: 'simulation',
        lead_id: 'simulation',
        username: null,
      });
      return ok({ matched: t ? { id: t.id, name: t.name, keyword: t.keyword } : null, delivered: false });
    }
    case 'contacts':
      return ok(
        await rows(
          "SELECT l.subscriber_id,l.username,l.first_name,l.status,l.stage,l.last_inbound_at,(SELECT group_concat(tag) FROM lead_tags WHERE subscriber_id=l.subscriber_id) AS tags FROM leads l WHERE (?1='' OR instr(lower(COALESCE(l.username,'') || ' ' || COALESCE(l.first_name,'')),lower(?1))>0) AND (?2='' OR EXISTS(SELECT 1 FROM lead_tags t WHERE t.subscriber_id=l.subscriber_id AND t.tag=?2)) ORDER BY l.last_inbound_at DESC,l.subscriber_id LIMIT ?3 OFFSET ?4",
          q.get('search') || '',
          q.get('tag') || '',
          limit,
          page,
        ),
      );
    case 'thread':
      return ok(
        await rows(
          'SELECT id,role,text,mid,created_at FROM messages WHERE subscriber_id=?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3',
          lead,
          limit,
          page,
        ),
      );
    case 'comments':
      return ok(
        await rows(
          "SELECT comment_id,subscriber_id,media_id,text,status,trigger_id,created_at FROM comments WHERE (?1='' OR media_id=?1) ORDER BY created_at DESC,comment_id LIMIT ?2 OFFSET ?3",
          q.get('media_id') || '',
          limit,
          page,
        ),
      );
    case 'fields':
      return ok(
        await rows(
          'SELECT name,value,updated_at FROM contact_fields WHERE subscriber_id=?1 ORDER BY name LIMIT ?2 OFFSET ?3',
          lead,
          limit,
          page,
        ),
      );
    case 'privacy_requests':
      return ok(
        await rows(
          "SELECT code,subject,state,created_at FROM deletion_requests WHERE state='pending' ORDER BY created_at LIMIT ?1 OFFSET ?2",
          limit,
          page,
        ),
      );
    case 'tags':
      return ok(
        await rows(
          'SELECT tag,count(*) AS contacts FROM lead_tags GROUP BY tag ORDER BY contacts DESC,tag LIMIT ?1 OFFSET ?2',
          limit,
          page,
        ),
      );
    case 'metrics':
      return ok(
        await rows(
          "SELECT (SELECT count(*) FROM leads) AS contacts,(SELECT count(*) FROM messages WHERE role='lead') AS inbound_messages,(SELECT count(*) FROM flow_sends WHERE status='sent') AS flow_messages,(SELECT count(*) FROM flow_taps) AS taps,(SELECT count(*) FROM comments WHERE status='queued') AS queued_comments",
        ),
      );
    case 'health':
      return ok(
        await rows(
          'SELECT kind,count(*) AS count,max(created_at) AS last_at FROM errors WHERE created_at>?1 GROUP BY kind ORDER BY last_at DESC',
          Date.now() - 7 * 86400000,
        ),
      );
    case 'flow_audience':
      return ok(
        await rows(
          "SELECT s.subscriber_id,count(*) AS sends,max(s.created_at) AS last_sent FROM flow_sends s WHERE s.trigger_id=?1 AND s.status='sent' AND (?2='all' OR (?2='opened' AND s.seen_at IS NOT NULL) OR (?2='clicked' AND EXISTS (SELECT 1 FROM flow_taps t WHERE t.send_id=s.id))) GROUP BY s.subscriber_id ORDER BY last_sent DESC,s.subscriber_id LIMIT ?3 OFFSET ?4",
          id,
          q.get('set') || 'all',
          limit,
          page,
        ),
      );
    case 'preferences':
      return ok({
        settings: await getConfig(env),
        excluded: await friendHandles(env.DB),
        learned: await getSetting(env.DB, 'learned_knowledge'),
        icebreakers: await getSetting(env.DB, 'ice_breakers'),
        menu: await getSetting(env.DB, 'main_menu'),
        folders: await getSetting(env.DB, 'automation_folders'),
      });
    case 'media': {
      const token = await getSetting(env.DB, 'ig_token');
      if (!token) return Response.json({ error: 'Connect Instagram to read media.' }, { status: 409 });
      return ok(q.get('kind') === 'stories' ? await recentStories(token) : await recentMedia(token, limit));
    }
    default:
      return new Response('Unknown view', { status: 404 });
  }
}
