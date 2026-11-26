// Who's already a customer. The whole Skool roster (active + churned tabs of the members page) is read a few pages at a
// time and matched to DM leads, so the setter never pitches a paying member and knows when someone it's talking to
// left. A match needs real identity: the Instagram link on their Skool profile, a verified DM join (src/joins.ts), or
// their exact full name on both sides with nobody else sharing it. Matched leads are tagged `member` or `churned`.

import { COMMUNITY, SKOOL_GROUPS } from "./brand";
import { norm } from "./joins";
import type { Env } from "./setter";
import * as db from "./db";

const GROUP = SKOOL_GROUPS[0];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const PAGE = 30; // Skool's members page size
const EVERY_MS = 10 * 60_000;
const PAGES_PER_RUN = 3; // Skool's WAF blocks an IP after about 250 page reads in 10 minutes; joins.ts reads here too
const DAY = 24 * 60 * 60_000;
const TABS = ["active", "churned"] as const;
type Tab = (typeof TABS)[number];

export interface RosterRow {
  member_id: string;
  name: string;
  fullname: string;
  handle: string;
  ig: string | null;
  status: Tab;
  joined_at: number | null;
  left_at: number | null;
  ltv_cents: number;
}

interface SkoolUser {
  name?: string;
  firstName?: string;
  lastName?: string;
  metadata?: { linkInstagram?: string };
  member?: { id?: string; approvedAt?: string; createdAt?: string; metadata?: { removedAt?: number; mbsltv?: number } };
}

// "https://www.instagram.com/_zebrazed/", "instagram.com/x?igsh=..", "@x", "x" -> "x"
export function igHandle(link: string | undefined): string | null {
  const m = (link ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : null;
}

export function parseRosterUser(u: SkoolUser, status: Tab): RosterRow | null {
  const m = u.member;
  if (!m?.id) return null;
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  const joined = Date.parse(m.approvedAt ?? m.createdAt ?? "");
  const removed = Number(m.metadata?.removedAt ?? 0); // nanoseconds
  return {
    member_id: m.id,
    name,
    fullname: norm(name),
    handle: u.name ?? "",
    ig: igHandle(u.metadata?.linkInstagram),
    status,
    joined_at: Number.isFinite(joined) ? joined : null,
    left_at: status === "churned" && removed ? Math.round(removed / 1e6) : null,
    ltv_cents: Number(m.metadata?.mbsltv ?? 0),
  };
}

export async function fetchRosterPage(token: string, tab: Tab, page: number): Promise<{ rows: RosterRow[]; total: number }> {
  const res = await fetch(`https://www.skool.com/${GROUP}/-/members?${new URLSearchParams({ t: tab, p: String(page) })}`, {
    headers: { "User-Agent": UA, Cookie: `auth_token=${token}` },
  });
  const html = await res.text();
  const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!res.ok || !data) throw new Error(`skool ${tab} members page ${res.status}: no page data (auth token expired?)`);
  const pp = (JSON.parse(data[1]) as { props?: { pageProps?: { users?: SkoolUser[]; total?: number } } }).props?.pageProps ?? {};
  return { rows: (pp.users ?? []).map((u) => parseRosterUser(u, tab)).filter((r): r is RosterRow => r !== null), total: pp.total ?? 0 };
}

// Upserts a page of the roster; returns the leads already matched to those members (their tag may need to change).
export async function saveRoster(d1: D1Database, rows: RosterRow[], now: number): Promise<string[]> {
  if (!rows.length) return [];
  const res = await d1.batch(
    rows.map((r) =>
      d1
        .prepare(
          `INSERT INTO roster (member_id, name, fullname, handle, ig, status, joined_at, left_at, ltv_cents, seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (member_id) DO UPDATE SET name = ?2, fullname = ?3, handle = ?4, ig = ?5, status = ?6, joined_at = ?7,
             left_at = ?8, ltv_cents = ?9, seen_at = ?10, checked_at = CASE WHEN roster.ig IS NOT ?5 THEN 0 ELSE roster.checked_at END
           RETURNING subscriber_id`,
        )
        .bind(r.member_id, r.name, r.fullname, r.handle, r.ig, r.status, r.joined_at, r.left_at, r.ltv_cents, now),
    ),
  );
  return res.flatMap((x) => (x.results as { subscriber_id: string | null }[]).map((y) => y.subscriber_id)).filter((s): s is string => Boolean(s));
}

// Fills leads.name_key (their Instagram name folded like the roster's: "𝑮𝒂𝒆𝒍 𝑴𝒐𝒓𝒆𝒏𝒐" = "gael moreno"), a batch per run;
// the lead upsert clears it when their name changes. Returns how many it filled.
export async function fillNameKeys(d1: D1Database, limit = 5000): Promise<number> {
  const { results } = await d1
    .prepare(`SELECT subscriber_id, first_name FROM leads WHERE name_key IS NULL LIMIT ?1`)
    .bind(limit)
    .all<{ subscriber_id: string; first_name: string | null }>();
  for (let i = 0; i < results.length; i += 500) {
    await d1.batch(
      results.slice(i, i + 500).map((l) => d1.prepare(`UPDATE leads SET name_key = ?2 WHERE subscriber_id = ?1`).bind(l.subscriber_id, norm(l.first_name ?? ""))),
    );
  }
  return results.length;
}

// Matches roster members nobody has tied to a lead yet (each re-checked at most daily) and returns the leads matched.
export async function matchRoster(d1: D1Database, now: number, limit = 2500): Promise<string[]> {
  await fillNameKeys(d1);
  const { results: open } = await d1
    .prepare(`SELECT member_id, fullname, ig FROM roster WHERE subscriber_id IS NULL AND checked_at < ?1 ORDER BY checked_at LIMIT ?2`)
    .bind(now - DAY, limit)
    .all<{ member_id: string; fullname: string; ig: string | null }>();
  const matched: string[] = [];
  // Lists go in as one JSON parameter, so a chunk can be big: each one costs a scan of the leads table.
  for (let i = 0; i < open.length; i += 500) {
    const chunk = open.slice(i, i + 500);
    const json = (xs: unknown[]) => JSON.stringify(xs);
    const igs = chunk.map((r) => r.ig).filter((x): x is string => Boolean(x));
    // Exact full names only, two real words or more ("Nils Hartmann", not "Nils" or "E G").
    const names = chunk.map((r) => r.fullname).filter((n) => n.split(" ").filter((w) => w.length >= 2).length >= 2);
    const [byIg, byJoin, byName, shared] = await d1.batch([
      d1.prepare(`SELECT subscriber_id, lower(username) AS k FROM leads WHERE username IN (SELECT value FROM json_each(?1))`).bind(json(igs)),
      d1.prepare(`SELECT subscriber_id, member_id AS k FROM joins WHERE confidence = 'confirmed' AND member_id IN (SELECT value FROM json_each(?1))`).bind(json(chunk.map((r) => r.member_id))),
      d1.prepare(`SELECT subscriber_id, name_key AS k FROM leads WHERE name_key IN (SELECT value FROM json_each(?1))`).bind(json(names)),
      d1.prepare(`SELECT fullname AS k, COUNT(*) AS n FROM roster WHERE fullname IN (SELECT value FROM json_each(?1)) GROUP BY fullname`).bind(json(names)),
    ]);
    const rows = <T>(r: D1Result) => r.results as T[];
    const ig = new Map(rows<{ subscriber_id: string; k: string }>(byIg).map((x) => [x.k, x.subscriber_id]));
    const join = new Map(rows<{ subscriber_id: string; k: string }>(byJoin).map((x) => [x.k, x.subscriber_id]));
    const leadsByName = new Map<string, string[]>();
    for (const x of rows<{ subscriber_id: string; k: string }>(byName)) leadsByName.set(x.k, [...(leadsByName.get(x.k) ?? []), x.subscriber_id]);
    const members = new Map(rows<{ k: string; n: number }>(shared).map((x) => [x.k, x.n]));
    const writes = chunk.map((r) => {
      const named = leadsByName.get(r.fullname);
      const hit: [string, string] | null =
        r.ig && ig.has(r.ig)
          ? [ig.get(r.ig)!, "ig"]
          : join.has(r.member_id)
            ? [join.get(r.member_id)!, "join"]
            : named?.length === 1 && members.get(r.fullname) === 1
              ? [named[0], "name"]
              : null;
      if (hit) matched.push(hit[0]);
      return d1
        .prepare(`UPDATE roster SET subscriber_id = ?2, matched_by = ?3, checked_at = ?4 WHERE member_id = ?1`)
        .bind(r.member_id, hit?.[0] ?? null, hit?.[1] ?? null, now);
    });
    await d1.batch(writes);
  }
  return matched;
}

// A lead's tag follows their roster rows: any active membership = `member`, otherwise `churned`.
export async function tagLeads(d1: D1Database, leads: string[], now: number): Promise<void> {
  const ids = [...new Set(leads)];
  for (let i = 0; i < ids.length; i += 90) {
    const { results } = await d1
      .prepare(
        `SELECT subscriber_id, MAX(status = 'active') AS active FROM roster WHERE subscriber_id IN (SELECT value FROM json_each(?1)) GROUP BY subscriber_id`,
      )
      .bind(JSON.stringify(ids.slice(i, i + 90)))
      .all<{ subscriber_id: string; active: number }>();
    await d1.batch(
      results.flatMap((r) => {
        const [on, off] = r.active ? ["member", "churned"] : ["churned", "member"];
        return [
          d1.prepare(`INSERT OR IGNORE INTO lead_tags (subscriber_id, tag, created_at) VALUES (?1, ?2, ?3)`).bind(r.subscriber_id, on, now),
          d1.prepare(`DELETE FROM lead_tags WHERE subscriber_id = ?1 AND tag = ?2`).bind(r.subscriber_id, off),
        ];
      }),
    );
  }
}

// Cron: a few roster pages every 10 minutes, cycling active then churned (a full lap takes a few hours), then matching.
export async function syncRoster(env: Env, now: number): Promise<void> {
  if (!env.SKOOL_AUTH_TOKEN) return;
  const last = Number((await db.getSetting(env.DB, "roster_at")) ?? 0);
  if (now - last < EVERY_MS) return;
  await db.setSetting(env.DB, "roster_at", String(now));
  let [tab, page] = ((await db.getSetting(env.DB, "roster_cursor")) ?? "active:1").split(":") as [Tab, string];
  let p = Number(page) || 1;
  const touched: string[] = [];
  for (let n = 0; n < PAGES_PER_RUN; n++) {
    const { rows, total } = await fetchRosterPage(env.SKOOL_AUTH_TOKEN, tab, p);
    touched.push(...(await saveRoster(env.DB, rows, now)));
    if (!rows.length || p * PAGE >= total) [tab, p] = [TABS[(TABS.indexOf(tab) + 1) % TABS.length], 1];
    else p++;
  }
  await db.setSetting(env.DB, "roster_cursor", `${tab}:${p}`);
  touched.push(...(await matchRoster(env.DB, now)));
  await tagLeads(env.DB, touched, now);
}

// What the setter should know about this lead as a customer, or null for a prospect.
export async function customerLine(d1: D1Database, leadId: string): Promise<string | null> {
  const r = await d1
    .prepare(`SELECT status, joined_at, left_at, ltv_cents FROM roster WHERE subscriber_id = ?1 ORDER BY status = 'active' DESC, joined_at DESC LIMIT 1`)
    .bind(leadId)
    .first<{ status: Tab; joined_at: number | null; left_at: number | null; ltv_cents: number }>();
  const month = (t: number | null) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "?");
  if (r?.status === "active") return `already a paying member of ${COMMUNITY} (joined ${month(r.joined_at)})`;
  if (r?.status === "churned")
    return `former member of ${COMMUNITY}: joined ${month(r.joined_at)}, left ${month(r.left_at)}, paid $${Math.round(r.ltv_cents / 100)} in total`;
  // A verified DM join the roster hasn't caught up with yet.
  const tagged = await d1.prepare(`SELECT 1 FROM lead_tags WHERE subscriber_id = ?1 AND tag = 'member'`).bind(leadId).first();
  return tagged ? `already a paying member of ${COMMUNITY}` : null;
}
