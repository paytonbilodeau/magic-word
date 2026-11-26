// Skool join verification. Every few minutes the cron reads the newest Skool members (same auth_token cookie as
// ~/Projects/skool's Workers) and matches each new one to the DM lead they most likely came from, on evidence the
// setter already has: a click on that lead's tracked link right before the join, the click's city vs the city Skool
// recorded, their name, "just joined" in the thread, and a Skool link having been sent to them. No join question.

import { LINK_RE, SKOOL_GROUPS, skoolLinkSql } from "./brand";
import * as db from "./db";
import type { Env } from "./setter";

const GROUP = SKOOL_GROUPS[0];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const SYNC_EVERY_MS = 10 * 60_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;


export interface Member {
  member_id: string;
  first: string;
  last: string;
  handle: string;
  joined_at: number;
  location: string | null; // "manila (philippines)"
  source: string | null; // "Where did you hear about Your Community?" answer
}

interface SkoolUser {
  name?: string;
  firstName?: string;
  lastName?: string;
  member?: { id?: string; createdAt?: string; approvedAt?: string; metadata?: { requestLocation?: string; survey?: string } };
}

export function parseMember(u: SkoolUser): Member | null {
  const m = u.member;
  // approvedAt = when they got in (a rejoin gets a new one); Skool sorts the members list by it, newest first.
  const at = Date.parse(m?.approvedAt ?? m?.createdAt ?? "");
  if (!m?.id || !Number.isFinite(at)) return null;
  let source: string | null = null;
  try {
    const survey = JSON.parse(m.metadata?.survey ?? "{}") as { survey?: { question?: string; answer?: string }[] };
    source = survey.survey?.find((q) => /hear about/i.test(q.question ?? ""))?.answer ?? null;
  } catch {
    source = null;
  }
  return {
    member_id: m.id,
    first: u.firstName ?? "",
    last: u.lastName ?? "",
    handle: u.name ?? "",
    joined_at: at,
    location: m.metadata?.requestLocation ?? null,
    source,
  };
}

// The newest active members (Skool lists them newest first): the members page's server props.
export async function fetchNewestMembers(token: string, page = 1): Promise<Member[]> {
  const res = await fetch(`https://www.skool.com/${GROUP}/-/members?${new URLSearchParams({ t: "active", p: String(page) })}`, {
    headers: { "User-Agent": UA, Cookie: `auth_token=${token}` },
  });
  const html = await res.text();
  const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!res.ok || !data) throw new Error(`skool members page ${res.status}: no page data (auth token expired?)`);
  const users = ((JSON.parse(data[1]) as { props?: { pageProps?: { users?: SkoolUser[] } } }).props?.pageProps?.users ?? []) as SkoolUser[];
  return users.map(parseMember).filter((m): m is Member => m !== null);
}

export const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// How strongly a lead's Instagram name and handle point at this Skool member.
export function nameScore(member: Pick<Member, "first" | "last">, leadName: string | null, username: string | null): number {
  const first = norm(member.first).split(" ")[0] ?? "";
  const last = norm(member.last).split(" ").at(-1) ?? "";
  const name = ` ${norm(leadName ?? "")} `;
  const user = norm(username ?? "").replace(/ /g, "");
  const has = (w: string) => w.length >= 3 && (name.includes(` ${w} `) || user.includes(w));
  if (has(first) && has(last)) return 35;
  return (has(first) ? 15 : 0) + (has(last) ? 15 : 0);
}

// "I joined" means joining: "just joined", "signed up", "bought it", a bare "I'm in". Not "I'm in the AI world".
const JOINED =
  /\b(just joined|i joined|joined (the |ur |your )?(community|skool|group|it)|just signed up|i signed up|signed up|paid and joined|just bought|bought it|landed and posted)\b|^\W*(yes\W+)?(bro\W+)?(i'?m|i’m|im) in\W*(now|bro|brother|g|fam)?\W*$/i;
const regionName = (code: string | null) => {
  try {
    return code ? (new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? "").toLowerCase() : "";
  } catch {
    return "";
  }
};

interface Candidate {
  subscriber_id: string;
  score: number;
  identity: boolean; // their name, the name they typed, or their own link opened within the hour: says WHO joined
  support: number; // independent signals beside that (said they joined, link sent, Instagram source, click city)
  evidence: string[];
}

// Every lead with any evidence around this join, best first. Leads already matched to an earlier join are out:
// one person joins once (a rejoin gets a new approval but the same lead is rarely two members).
export async function candidates(d1: D1Database, member: Member): Promise<Candidate[]> {
  const t = member.joined_at;
  const city = (member.location ?? "").replace(/\s*\(.*$/, "").trim();
  const country = member.location?.match(/\(([^)]+)\)/)?.[1]?.trim() ?? "";
  const { results: taken } = await d1
    .prepare(`SELECT subscriber_id FROM joins WHERE subscriber_id IS NOT NULL AND confidence != 'none' AND member_id != ?1`)
    .bind(member.member_id)
    .all<{ subscriber_id: string }>();
  const claimed = new Set(taken.map((r) => r.subscriber_id));
  const by = new Map<string, Candidate>();
  const get = (id: string) => {
    const c = by.get(id) ?? { subscriber_id: id, score: 0, identity: false, support: 0, evidence: [] };
    by.set(id, c);
    return c;
  };
  const add = (id: string, pts: number, why: string, kind: "identity" | "support") => {
    const c = get(id);
    c.score += pts;
    c.evidence.push(why);
    if (kind === "identity") c.identity = true;
    else c.support++;
  };

  // 1. Opened their own tracked Skool link shortly before joining, and from where.
  const { results: clicks } = await d1
    .prepare(`SELECT subscriber_id, MAX(created_at) at, country, city FROM clicks WHERE created_at BETWEEN ?1 AND ?2 GROUP BY subscriber_id`)
    .bind(t - 3 * HOUR, t + 5 * MIN)
    .all<{ subscriber_id: string; at: number; country: string | null; city: string | null }>();
  // A click alone only says someone was on the page: joins from YouTube land every hour, so a click near a stranger's
  // join is timing, not identity (2026-10-29 paired Jammu, Helston and Panama clicks with Phoenix, UK and Italian
  // joiners). It says WHO only when it came from where the member signed up; from another country it counts for nothing.
  for (const c of clicks) {
    const gap = Math.max(0, Math.round((t - c.at) / MIN));
    const sameCity = Boolean(city && c.city && norm(c.city) === norm(city));
    const sameCountry = Boolean(country && c.country && norm(regionName(c.country)) === norm(country));
    if (country && c.country && !sameCountry) continue;
    const where = sameCity ? `${c.city}, Skool says ${member.location}` : sameCountry ? `${regionName(c.country)}, same country as the join` : null;
    const pts = (gap <= 15 ? 45 : gap <= 60 ? 35 : 20) + (sameCity ? 20 : sameCountry ? 10 : 0);
    add(c.subscriber_id, pts, `opened their Skool link ${gap} min before joining${where ? ` from ${where}` : ""}`, gap <= 60 && where ? "identity" : "support");
  }

  // 2. Said they joined within 3 hours after (or just before, "joining now").
  const { results: said } = await d1
    .prepare(`SELECT subscriber_id, text FROM messages WHERE role = 'lead' AND created_at BETWEEN ?1 AND ?2`)
    .bind(t - 10 * MIN, t + 3 * HOUR)
    .all<{ subscriber_id: string; text: string }>();
  for (const s of said) if (JOINED.test(s.text) && !get(s.subscriber_id).evidence.some((e) => e.startsWith("said"))) add(s.subscriber_id, 25, `said "${s.text.slice(0, 60)}"`, "support");

  // 3. Was sent the Skool link in the week before (by the setter, Manychat or by hand; any slug in brand.ts).
  const { results: sent } = await d1
    .prepare(
      `SELECT DISTINCT subscriber_id FROM messages WHERE role = 'bot' AND created_at BETWEEN ?1 AND ?2
         AND (${skoolLinkSql("text")} OR instr(text, '/l/') > 0)`,
    )
    .bind(t - 7 * DAY, t)
    .all<{ subscriber_id: string }>();
  const sentTo = new Set(sent.map((s) => s.subscriber_id));

  // 4. Anyone active lately whose Instagram name is the member's full name.
  const first = norm(member.first).split(" ")[0] ?? "";
  if (first.length >= 3) {
    const { results: named } = await d1
      .prepare(`SELECT subscriber_id, first_name, username FROM leads WHERE last_at BETWEEN ?1 AND ?2 AND instr(lower(first_name), ?3) > 0`)
      .bind(t - 14 * DAY, t + DAY, first)
      .all<{ subscriber_id: string; first_name: string | null; username: string | null }>();
    for (const n of named) if (nameScore(member, n.first_name, n.username) >= 35) get(n.subscriber_id);
  }

  for (const c of by.values()) {
    const lead = await db.getLead(d1, c.subscriber_id);
    const pts = lead ? nameScore(member, lead.first_name, lead.username) : 0;
    const who = lead?.first_name || lead?.username;
    const told = c.evidence.some((e) => e.startsWith("said"));
    if (pts >= 35) add(c.subscriber_id, 35, `name matches (${who})`, "identity");
    // A nickname ("Kuba" for Jakub) plus "just joined" right at the join is them.
    else if (pts && told) add(c.subscriber_id, pts + 20, `partial name match (${who}) and said they joined right then`, "identity");
    else if (pts) add(c.subscriber_id, pts, `partial name match (${who})`, "support");
    // Told us their real name in the thread ("I'm Nils Hartmann").
    if (member.first && member.last && pts < 35) {
      const full = `${member.first} ${member.last}`.toLowerCase();
      const hit = await d1.prepare(`SELECT 1 FROM messages WHERE subscriber_id = ?1 AND role = 'lead' AND instr(lower(text), ?2) > 0`).bind(c.subscriber_id, full).first();
      if (hit) add(c.subscriber_id, 35, `typed "${member.first} ${member.last}" in the DMs`, "identity");
    }
    if (sentTo.has(c.subscriber_id)) add(c.subscriber_id, 10, "got the Skool link this week", "support");
    if (member.source && /instagram/i.test(member.source)) add(c.subscriber_id, 10, `told Skool they heard about it on ${member.source}`, "support");
  }
  return [...by.values()].filter((c) => c.score > 0 && !claimed.has(c.subscriber_id)).sort((a, b) => b.score - a.score);
}

export interface Match {
  subscriber_id: string | null;
  score: number;
  confidence: "confirmed" | "likely" | "none";
  evidence: string[];
}

// Confirmed = proof of who (name, typed name, their link opened within the hour, or a nickname + "just joined") plus an
// independent signal, and nobody else with proof of who. Likely = proof of who alone. "Said they joined" with no proof
// of who is never a match: whoever happened to join that minute isn't evidence (the backtest paired strangers that way).
export function decideMatch(cands: Candidate[]): Match {
  const named = cands.filter((c) => c.identity);
  const [best] = named;
  if (best) {
    const rival = named[1];
    const confidence = best.support >= 1 && !rival ? "confirmed" : "likely";
    return { subscriber_id: best.subscriber_id, score: best.score, confidence, evidence: rival ? [...best.evidence, `another lead also matches (${rival.score})`] : best.evidence };
  }
  return { subscriber_id: null, score: cands[0]?.score ?? 0, confidence: "none", evidence: [] };
}

// Was this join set in the DMs? Reads the thread up to the join. Set = they replied in a real conversation (not just
// button taps) and we pitched or sent the link after they started talking; asked = we only handed over the link they
// asked for; self = nobody pitched them (the freebie, a video, or a chat that never got to the pitch).
export type JoinPath = "set" | "asked" | "self";
export const TAP = /^\[|send (me )?the link|^send it|get (the|it) |^tap in|^link\b|yes,? send it over|^notify me|^get updates/i;
const PITCH = new RegExp(`open to joining|want the link|here'?s the link|${LINK_RE.source}`, "i");
const TEMPLATE = /^(\[|yoooo did you get a chance|ayyo did the|here's the free|here's the full|glad you tapped|yo+!? it's setterbot|\?$|yo$|https?:\/\/\S+$)/i;
export async function joinPath(d1: D1Database, subscriberId: string, joinedAt: number): Promise<JoinPath> {
  const { results: thread } = await d1
    .prepare(`SELECT role, text FROM messages WHERE subscriber_id = ?1 AND created_at <= ?2 ORDER BY id`)
    .bind(subscriberId, joinedAt)
    .all<{ role: string; text: string }>();
  const first = thread.findIndex((m) => m.role === "lead" && !TAP.test(m.text.trim()));
  if (first < 0) return "self";
  const after = thread.slice(first);
  const real = after.filter((m) => m.role === "lead" && !TAP.test(m.text.trim())).length;
  const ours = after.filter((m) => m.role === "bot");
  const pitched = ours.some((m) => PITCH.test(m.text));
  const talked = ours.filter((m) => !TEMPLATE.test(m.text.trim())).length;
  if (pitched && real >= 2 && talked >= 2) return "set";
  return pitched ? "asked" : "self";
}

export async function recordJoin(d1: D1Database, member: Member, match: Match, now: number): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO joins (member_id, name, handle, joined_at, location, source, subscriber_id, score, confidence, evidence, created_at, path)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      member.member_id,
      `${member.first} ${member.last}`.trim(),
      member.handle,
      member.joined_at,
      member.location,
      member.source,
      match.subscriber_id,
      match.score,
      match.confidence,
      JSON.stringify(match.evidence),
      now,
      match.subscriber_id ? await joinPath(d1, match.subscriber_id, member.joined_at) : null,
    )
    .run();
  // The funnel re-reads this lead's furthest move (a join from the DMs is the last one).
  if (match.subscriber_id) await d1.prepare(`UPDATE leads SET move_at = NULL WHERE subscriber_id = ?1`).bind(match.subscriber_id).run();
  if (match.confidence !== "confirmed" || !match.subscriber_id) return;
  // A verified member: no more nudges, and the stage says so.
  await d1.batch([
    d1.prepare(`UPDATE leads SET stage = 'joined', followup_due_at = NULL WHERE subscriber_id = ?1`).bind(match.subscriber_id),
    d1.prepare(`INSERT OR IGNORE INTO lead_tags (subscriber_id, tag, created_at) VALUES (?1, 'member', ?2)`).bind(match.subscriber_id, now),
  ]);
}

// Cron: every 10 minutes, match any member who joined since the newest one we've seen. The first run looks back 30
// days, which backfills the history and doubles as a backtest of the matcher.
const FIRST_RUN_LOOKBACK_MS = 30 * DAY;
export async function syncJoins(env: Env & { SKOOL_AUTH_TOKEN?: string }, now: number, fetchMembers: (token: string, page: number) => Promise<Member[]> = fetchNewestMembers): Promise<number> {
  // Joins matched before `path` existed get it once.
  const { results: unclassified } = await env.DB.prepare(`SELECT member_id, subscriber_id, joined_at FROM joins WHERE subscriber_id IS NOT NULL AND path IS NULL LIMIT 50`).all<{
    member_id: string;
    subscriber_id: string;
    joined_at: number;
  }>();
  for (const j of unclassified)
    await env.DB.batch([
      env.DB.prepare(`UPDATE joins SET path = ?2 WHERE member_id = ?1`).bind(j.member_id, await joinPath(env.DB, j.subscriber_id, j.joined_at)),
      env.DB.prepare(`UPDATE leads SET move_at = NULL WHERE subscriber_id = ?1`).bind(j.subscriber_id),
    ]);
  if (!env.SKOOL_AUTH_TOKEN) return 0;
  const last = Number((await db.getSetting(env.DB, "joins_sync_at")) ?? 0);
  if (now - last < SYNC_EVERY_MS) return 0;
  await db.setSetting(env.DB, "joins_sync_at", String(now));
  // Done up to here: only moved after a full pass, so a run cut short just resumes (recorded joins are skipped).
  const since = Number((await db.getSetting(env.DB, "joins_watermark")) ?? 0) || now - FIRST_RUN_LOOKBACK_MS;
  const fetched: Member[] = [];
  for (let page = 1; page <= 25; page++) {
    const batch = await fetchMembers(env.SKOOL_AUTH_TOKEN, page);
    fetched.push(...batch.filter((m) => m.joined_at > since));
    if (!batch.length || batch.some((m) => m.joined_at <= since)) break;
  }
  const { results: done } = await env.DB.prepare(`SELECT member_id FROM joins WHERE joined_at > ?1`).bind(since).all<{ member_id: string }>();
  const skip = new Set(done.map((d) => d.member_id));
  const fresh = fetched.filter((m) => !skip.has(m.member_id)).sort((a, b) => a.joined_at - b.joined_at);
  for (const m of fresh) await recordJoin(env.DB, m, decideMatch(await candidates(env.DB, m)), now);
  if (fetched.length) await db.setSetting(env.DB, "joins_watermark", String(Math.max(...fetched.map((m) => m.joined_at))));
  return fresh.length;
}
