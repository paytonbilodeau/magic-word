// Usernames, names and profile pictures for the inbox. Instagram's CDN picture URLs expire, so they're linked (never
// stored as images) and looked up again every few days, newest threads first, a batch per cron tick.

import * as db from "./db";
import { fetchProfile } from "./meta";
import type { Env } from "./setter";

const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const PER_TICK = 40;

export async function saveProfile(d1: D1Database, leadId: string, p: { username: string | null; name: string | null; pic: string | null }, now: number): Promise<void> {
  await d1
    .prepare(
      `UPDATE leads SET username = COALESCE(?2, username), first_name = COALESCE(first_name, ?3), profile_pic = COALESCE(?4, profile_pic), profile_at = ?5
       WHERE subscriber_id = ?1`,
    )
    .bind(leadId, p.username, p.name, p.pic, now)
    .run();
}

export async function refreshProfiles(env: Env, now: number): Promise<void> {
  const token = await db.getSetting(env.DB, "ig_token");
  if (!token) return;
  const { results } = await env.DB.prepare(
    `SELECT subscriber_id FROM leads WHERE (profile_at IS NULL OR profile_at < ?1) AND members IS NULL ORDER BY COALESCE(last_at, created_at) DESC LIMIT ?2`,
  )
    .bind(now - STALE_MS, PER_TICK)
    .all<{ subscriber_id: string }>();
  for (const { subscriber_id } of results) await saveProfile(env.DB, subscriber_id, await fetchProfile(token, subscriber_id), now);
}
