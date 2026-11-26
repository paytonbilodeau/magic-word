// Link click tracking: with track_links on, {{SKOOL_LINK}} goes out as <worker>/l/<code>. Opening it logs the click
// against the lead and 302s to the real Skool link.

import { fillLink } from "./manychat";
import { getConfig } from "./settings";
import type { Env } from "./setter";

import { ORIGIN as BASE_URL } from "./brand";
export { BASE_URL };

// Instagram's link-preview crawler fetches every link the moment it's sent; that isn't the lead opening it.
const CRAWLER = /facebookexternalhit|facebookcatalog|meta-externalagent|instagram.*bot|bot\b|crawler|spider|preview/i;

function newCode(): string {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => abc[b % abc.length]).join("");
}

export async function trackedLink(db: D1Database, subscriberId: string, url: string, now: number): Promise<string> {
  await db
    .prepare(`INSERT OR IGNORE INTO links (code, subscriber_id, url, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(newCode(), subscriberId, url, now)
    .run();
  const row = await db.prepare(`SELECT code FROM links WHERE subscriber_id = ?1 AND url = ?2`).bind(subscriberId, url).first<{ code: string }>();
  return `${BASE_URL}/l/${row!.code}`;
}

export type Magnet = { id: number; name: string; urls: string[] };

// Automations whose messages hand out links (in the text or on URL buttons), with their name and every link.
async function magnets(db: D1Database, where: string, ...binds: unknown[]): Promise<Magnet[]> {
  const { results } = await db
    .prepare(`SELECT t.id, t.name, n.data FROM flow_nodes n JOIN triggers t ON t.id = n.trigger_id WHERE n.kind = 'message' AND ${where} ORDER BY t.id`)
    .bind(...binds)
    .all<{ id: number; name: string | null; data: string }>();
  const by = new Map<number, { name: string; urls: Set<string> }>();
  for (const r of results) {
    const urls = by.get(r.id)?.urls ?? new Set<string>();
    by.set(r.id, { name: r.name || "a free guide", urls });
    const m = JSON.parse(r.data) as { bubbles?: { text?: string; buttons?: { url?: string }[] }[] };
    for (const b of m.bubbles ?? []) {
      for (const u of b.text?.match(/https?:\/\/\S+/g) ?? []) urls.add(u);
      for (const x of b.buttons ?? []) if (x.url && !x.url.includes("{{")) urls.add(x.url);
    }
  }
  return [...by].filter(([, m]) => m.urls.size).map(([id, m]) => ({ id, name: m.name, urls: [...m.urls] }));
}

// The lead magnet behind the newest automation they triggered. The setter resends it as {{GUIDE_LINK}} when the
// flow's button didn't deliver (desktop never shows buttons).
export async function leadMagnet(db: D1Database, subscriberId: string): Promise<Magnet | null> {
  const where = `n.trigger_id = (SELECT trigger_id FROM flow_starts WHERE subscriber_id = ?1 AND trigger_id > 0 ORDER BY created_at DESC LIMIT 1)`;
  return (await magnets(db, where, subscriberId))[0] ?? null;
}

// Every live automation's lead magnet: the setter sends one as {{GUIDE_LINK:<id>}} to anyone who asks for it in a
// DM, with or without commenting the keyword first.
export function liveMagnets(db: D1Database): Promise<Magnet[]> {
  return magnets(db, `t.id > 0 AND t.enabled = 1 AND t.deleted_at IS NULL`);
}

// fillLink, routed through /l/<code> when tracking is on. {{GUIDE_LINK}} becomes their lead magnet's link(s),
// {{GUIDE_LINK:<id>}} that live automation's.
export async function fillTracked(env: Env, subscriberId: string, bubbles: string[], now: number): Promise<string[]> {
  if (bubbles.some((b) => b.includes("{{GUIDE_LINK"))) {
    const own = await leadMagnet(env.DB, subscriberId);
    const live = await liveMagnets(env.DB);
    const guide = (id?: string) => (id ? live.find((m) => m.id === Number(id)) : own)?.urls.join("\n") ?? "";
    bubbles = bubbles.map((b) => b.replace(/\{\{GUIDE_LINK(?::(\d+))?\}\}/g, (_, id) => guide(id)).trim()).filter(Boolean);
  }
  if (!bubbles.some((b) => b.includes("{{SKOOL_LINK}}"))) return bubbles;
  const c = await getConfig(env);
  return fillLink(bubbles, c.track_links ? await trackedLink(env.DB, subscriberId, c.skool_link, now) : c.skool_link);
}

export async function handleClick(req: Request, env: Env, code: string, now: number): Promise<Response> {
  const link = await env.DB.prepare(`SELECT * FROM links WHERE code = ?1`).bind(code).first<{ code: string; subscriber_id: string; url: string }>();
  if (!link) return Response.redirect((await getConfig(env)).skool_link, 302);
  if (!CRAWLER.test(req.headers.get("User-Agent") ?? "")) {
    // Where they opened it: matched against the city Skool records when someone joins (src/joins.ts).
    const cf = (req as Request & { cf?: { country?: string; city?: string } }).cf;
    await env.DB.prepare(`INSERT INTO clicks (code, subscriber_id, created_at, country, city) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(code, link.subscriber_id, now, cf?.country ?? null, cf?.city ?? null)
      .run();
  }
  return Response.redirect(link.url, 302);
}
