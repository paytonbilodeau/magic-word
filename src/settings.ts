// Settings the owner changes from /admin/settings, stored in the D1 `settings` table. Each falls back to the
// wrangler var of the same meaning, so an empty table behaves exactly like before the page existed.

import type { Env } from "./setter";

export interface Config {
  autopilot: boolean; // AUTOPILOT
  reply_delay_min_s: number; // REPLY_DELAY_MIN_S
  reply_delay_max_s: number; // REPLY_DELAY_MAX_S
  skool_link: string; // SKOOL_LINK
  track_links: boolean; // {{SKOOL_LINK}} goes out as /l/<code> and clicks are logged
  pause_on_manual_reply: boolean; // read by the agent's auto-pause: a hand-sent DM pauses the AI on that thread
  auto_resume_hours: number; // ...and resumes it after this many hours (0 = stay paused)
}

export const KEYS = [
  "autopilot",
  "reply_delay_min_s",
  "reply_delay_max_s",
  "skool_link",
  "track_links",
  "pause_on_manual_reply",
  "auto_resume_hours",
] as const;
type Key = (typeof KEYS)[number];

const num = (v: string | undefined, fallback: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

export async function getConfig(env: Env): Promise<Config> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${KEYS.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...KEYS)
    .all<{ key: Key; value: string }>();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value])) as Partial<Record<Key, string>>;
  return {
    autopilot: (s.autopilot ?? env.AUTOPILOT) === "true",
    reply_delay_min_s: num(s.reply_delay_min_s, num(env.REPLY_DELAY_MIN_S, 60)),
    reply_delay_max_s: num(s.reply_delay_max_s, num(env.REPLY_DELAY_MAX_S, 240)),
    skool_link: s.skool_link || env.SKOOL_LINK,
    track_links: s.track_links === "true", // off until the owner turns it on
    pause_on_manual_reply: (s.pause_on_manual_reply ?? "true") === "true",
    auto_resume_hours: num(s.auto_resume_hours, 12),
  };
}

export async function saveConfig(db: D1Database, c: Config): Promise<void> {
  await db.batch(
    KEYS.map((k) =>
      db.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(k, String(c[k])),
    ),
  );
}

// The Env every entry point hands down (cron, webhooks, admin): the stored settings layered over the wrangler
// vars, so setter.ts and comments.ts keep reading env.AUTOPILOT / env.SKOOL_LINK and get the owner's values.
export async function withSettings(env: Env): Promise<Env> {
  const c = await getConfig(env);
  return {
    ...env,
    AUTOPILOT: String(c.autopilot),
    REPLY_DELAY_MIN_S: String(c.reply_delay_min_s),
    REPLY_DELAY_MAX_S: String(c.reply_delay_max_s),
    SKOOL_LINK: c.skool_link,
  };
}
