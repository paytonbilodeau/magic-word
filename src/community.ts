// What's true in the community right now, read from Skool for the setter: the call schedule, how many members and how
// many are active, what's in the classroom. Refreshed every 6 hours with the same auth_token cookie as joins and the
// roster, saved as setting `community_facts`, and handed to the model next to the product knowledge, so "when are the
// calls?" or "how active is it?" gets today's answer instead of a handoff.

import { SKOOL_GROUPS } from "./brand";
import * as db from "./db";
import type { Env } from "./setter";

const GROUP = SKOOL_GROUPS[0];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const MIN = 60_000;
const EVERY_MS = 6 * 60 * MIN;
const RETRY_MS = 30 * MIN;

export interface SkoolEvent {
  startTime: string;
  endTime: string;
  metadata?: { title?: string; description?: string; location?: string; timezone?: string };
}
export interface SkoolCourse {
  metadata?: { title?: string; desc?: string; numModules?: number };
}
export interface Community {
  members: number;
  daily: number[]; // active members per day, newest first
  weekly: number | null; // active in the last 7 days
  events: SkoolEvent[];
  courses: SkoolCourse[];
  tz: string;
}

async function page<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://www.skool.com/${GROUP}${path}`, { headers: { "User-Agent": UA, Cookie: `auth_token=${token}` } });
  const html = await res.text();
  const data = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!res.ok || !data) throw new Error(`skool ${path} page ${res.status}: no page data (auth token expired?)`);
  return ((JSON.parse(data[1]) as { props?: { pageProps?: T } }).props?.pageProps ?? {}) as T;
}

async function activeMembers(token: string, groupId: string, term: "daily" | "weekly"): Promise<number[]> {
  const res = await fetch(`https://api2.skool.com/groups/${groupId}/admin-metrics?range=30d&amt=${term}`, { headers: { "User-Agent": UA, Cookie: `auth_token=${token}` } });
  if (!res.ok) throw new Error(`skool admin-metrics ${term} ${res.status}`);
  return ((await res.json()) as { active_members?: { value: number }[] }).active_members?.map((p) => p.value) ?? [];
}

export async function fetchCommunity(token: string): Promise<Community> {
  const about = await page<{ currentGroup?: { id?: string; metadata?: { totalMembers?: number } } }>(token, "/about");
  const groupId = about.currentGroup?.id;
  if (!groupId) throw new Error("skool about page: no group id");
  const [cal, room, daily, weekly] = await Promise.all([
    page<{ events?: SkoolEvent[]; timezone?: string }>(token, "/calendar"),
    page<{ allCourses?: SkoolCourse[] }>(token, "/classroom"),
    activeMembers(token, groupId, "daily"),
    activeMembers(token, groupId, "weekly"),
  ]);
  return {
    members: about.currentGroup?.metadata?.totalMembers ?? 0,
    daily,
    weekly: weekly[0] ?? null,
    events: cal.events ?? [],
    courses: room.allCourses ?? [],
    tz: cal.events?.[0]?.metadata?.timezone || cal.timezone || "America/Chicago",
  };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The block the model reads. Calls that happen on the same time slot twice or more in the calendar's window are the
// regular schedule; anything else still ahead is listed on its own. No "next call" line: it would go stale between
// refreshes, and the model doesn't know today's date.
export function renderCommunity(c: Community, now: number): string {
  const zone = c.tz === "America/Chicago" ? "Central" : c.tz;
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: c.tz, ...o }).format(d);
  const time = (d: Date) => fmt(d, { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(/\s/g, "").toLowerCase();
  const day = (d: Date) => fmt(d, { weekday: "short" });
  const date = (d: Date) => `${day(d)} ${fmt(d, { month: "short", day: "numeric" })} at ${time(d)} ${zone}`;

  const slots = new Map<string, { title: string; span: string; days: Set<string>; desc: string; zoom: boolean; count: number }>();
  for (const e of c.events) {
    const start = new Date(e.startTime);
    const title = e.metadata?.title?.trim() || "Group call";
    const span = `${time(start).replace(/(am|pm)$/, (m) => (time(new Date(e.endTime)).endsWith(m) ? "" : m))}-${time(new Date(e.endTime))}`;
    const key = `${title}|${span}`;
    const s = slots.get(key) ?? { title, span, days: new Set<string>(), desc: e.metadata?.description?.trim() ?? "", zoom: /zoom/i.test(e.metadata?.location ?? ""), count: 0 };
    s.days.add(day(start));
    s.count++;
    slots.set(key, s);
  }
  const regular = [...slots.values()].filter((s) => s.count >= 2);
  const oneOffs = c.events.filter((e) => new Date(e.startTime).getTime() > now && !regular.some((s) => s.title === (e.metadata?.title?.trim() || "Group call")));

  const d = c.daily.slice(0, 7);
  const lines = [
    `# Live community facts (read from Skool ${fmt(new Date(now), { month: "short", day: "numeric" })}; these are current, answer from them)`,
    `Members: ${c.members}.${d.length ? ` Active on a normal day: about ${Math.min(...d)}-${Math.max(...d)} members (yesterday ${d[0]}).` : ""}${c.weekly ? ` Active in the last 7 days: ${c.weekly}.` : ""}`,
  ];
  if (regular.length || oneOffs.length) {
    lines.push(`Group calls (times ${zone}):`);
    for (const s of regular) {
      const days = [...s.days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).join(" and ");
      lines.push(`- ${s.title}: every ${days}, ${s.span}${s.zoom ? " on Zoom" : ""}.${s.desc ? ` ${s.desc}` : ""}`);
    }
    for (const e of oneOffs) lines.push(`- ${e.metadata?.title?.trim() || "Group call"}: ${date(new Date(e.startTime))}.`);
  }
  const courses = c.courses.filter((x) => x.metadata?.title);
  if (courses.length) {
    lines.push(`Classroom (${courses.length} courses):`);
    for (const x of courses) {
      const m = x.metadata!;
      lines.push(`- ${m.title!.trim()}${m.numModules ? ` (${m.numModules} lessons)` : ""}${m.desc?.trim() ? `: ${m.desc.trim()}` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function refreshCommunity(env: Env, now: number, fetcher: (token: string) => Promise<Community> = fetchCommunity): Promise<void> {
  if (!env.SKOOL_AUTH_TOKEN) return;
  if (now - Number((await db.getSetting(env.DB, "community_at")) ?? 0) < EVERY_MS) return;
  try {
    await db.setSetting(env.DB, "community_facts", renderCommunity(await fetcher(env.SKOOL_AUTH_TOKEN), now));
    await db.setSetting(env.DB, "community_at", String(now));
  } catch (e) {
    await db.setSetting(env.DB, "community_at", String(now - EVERY_MS + RETRY_MS)); // try again in 30 min, keep the old facts
    throw e;
  }
}
