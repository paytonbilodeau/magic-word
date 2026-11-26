// What lets the setter run threads on its own: pausing when the owner answers by hand (and resuming after),
// follow-up nudges inside the 24h window, and the autopilot disclosure line.

import * as db from "./db";
import type { MetaEvent } from "./meta";

const HOUR = 60 * 60 * 1000;

// Autopilot sends as soon as the draft is ready, whatever REPLY_DELAY_MAX_S says: the read pause and typing dots
// (src/setter.ts) are the human delay, and Meta's messaging policy wants automated replies out within 30 seconds.
// The owner dropped the extra random wait 2026-10-29.
export const AUTOPILOT_MAX_DELAY_MS = 0;

// California's bot law covers sales bots: the first autopilot reply in a thread can say so, once. Off: the owner
// turned it off 2026-10-28 ("we can sort this out later"); flip DISCLOSE to bring the line back.
export const DISCLOSE = false;
export const DISCLOSURE = "(heads up, i use an AI assistant to help me reply fast)";

// Nudge 1 goes 3h after our last message, nudge 2 6h after that. None is drafted later than 20h after the lead's
// last message, which leaves room to approve it before the 24h window shuts.
export const FOLLOWUP_GAPS_MS = [3 * HOUR, 6 * HOUR];
export const FOLLOWUP_CUTOFF_MS = 20 * HOUR;

// Settings the owner sets on /admin/settings (D1 `settings`), with defaults when unset.
export async function pauseOnManualReply(d1: D1Database): Promise<boolean> {
  return (await db.getSetting(d1, "pause_on_manual_reply")) !== "false";
}

// 0 = a manual-reply pause never lifts on its own.
export async function autoResumeHours(d1: D1Database): Promise<number> {
  const v = await db.getSetting(d1, "auto_resume_hours");
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n >= 0 ? n : 6;
}

// Call before sending anything from this Worker, so the echo is known as ours even if it lands first.
export async function markOutgoing(d1: D1Database, subscriberId: string, texts: string[], now: number): Promise<void> {
  if (!texts.length) return;
  await d1.batch(texts.map((t) => d1.prepare(`INSERT INTO outbox (subscriber_id, text, created_at) VALUES (?1, ?2, ?3)`).bind(subscriberId, t, now)));
}

export async function clearOutgoing(d1: D1Database, subscriberId: string, now: number): Promise<void> {
  await d1.prepare(`DELETE FROM outbox WHERE subscriber_id = ?1 AND created_at = ?2`).bind(subscriberId, now).run();
}

async function claimOutgoing(d1: D1Database, subscriberId: string, text: string, at: number): Promise<boolean> {
  const r = await d1
    .prepare(
      `DELETE FROM outbox WHERE rowid = (SELECT rowid FROM outbox WHERE subscriber_id = ?1 AND text = ?2 AND created_at > ?3 ORDER BY rowid LIMIT 1)`,
    )
    .bind(subscriberId, text, at - 10 * 60 * 1000)
    .run();
  return Boolean(r.meta.changes);
}

async function sentByUs(d1: D1Database, subscriberId: string, text: string, at: number): Promise<boolean> {
  const row = await d1
    .prepare(`SELECT 1 FROM drafts WHERE subscriber_id = ?1 AND status IN ('sending', 'sent') AND created_at > ?3 AND instr(bubbles, json_quote(?2)) > 0`)
    .bind(subscriberId, text, at - 10 * 60 * 1000)
    .first();
  return Boolean(row);
}

// An echo is a message sent from the account. Ours (already recorded, or in the outbox) changes nothing. Anything
// else stops a scheduled nudge, and if the owner typed it themselves the AI steps back from that thread.
export async function handleEcho(d1: D1Database, ev: MetaEvent): Promise<void> {
  if (!(await db.recordEcho(d1, ev.lead_id, ev.text, ev.mid, ev.at))) return;
  if (await claimOutgoing(d1, ev.lead_id, ev.text, ev.at)) return;
  // Belt and braces: a bubble of a draft we sent in the last few minutes is ours even when its outbox row is gone
  // (an echo racing the send's cleanup paused a live thread on 2026-10-28).
  if (await sentByUs(d1, ev.lead_id, ev.text, ev.at)) return;
  await d1.prepare(`UPDATE leads SET followup_due_at = NULL WHERE subscriber_id = ?1`).bind(ev.lead_id).run();
  // Messenger marks app sends (Manychat, other tools) with app_id; the owner typing in the Instagram app has none.
  // Instagram's docs don't list the field, so log it until a live echo confirms it.
  if (ev.app_id) {
    console.log(`echo from app ${ev.app_id} for ${ev.lead_id}: not a manual reply`);
    return;
  }
  if (await automated(d1, ev)) return;
  if (!(await pauseOnManualReply(d1))) return;
  // Pauses the owner (or a handoff) set stay as they are; a repeat manual reply restarts the resume clock.
  await d1
    .prepare(
      `UPDATE leads SET status = 'paused', paused_reason = 'manual_reply', paused_at = ?2
       WHERE subscriber_id = ?1 AND (status IN ('active', 'done') OR (status = 'paused' AND paused_reason = 'manual_reply'))`,
    )
    .bind(ev.lead_id, ev.at)
    .run();
}

// Manychat's flows echo like the owner typing (Instagram echoes carry no app id, confirmed 2026-10-29 when a Manychat lead
// magnet paused 4 threads in one night). Tell them apart by shape: the Instagram app can't send a button card, and a
// flow sends the same text to lots of people while the owner's hand replies are one-offs.
async function automated(d1: D1Database, ev: MetaEvent): Promise<boolean> {
  if (ev.text.startsWith("[template]")) return true;
  const row = await d1
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT subscriber_id FROM messages WHERE text = ?1 AND role = 'bot' AND subscriber_id != ?2 LIMIT 3)`)
    .bind(ev.text, ev.lead_id)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= 3;
}

export async function resumeManualPauses(d1: D1Database, now: number): Promise<void> {
  const hours = await autoResumeHours(d1);
  if (!hours) return;
  await d1
    .prepare(
      `UPDATE leads SET status = 'active', paused_reason = NULL, paused_at = NULL
       WHERE status = 'paused' AND paused_reason = 'manual_reply' AND paused_at <= ?1`,
    )
    .bind(now - hours * HOUR)
    .run();
}

// After we send a reply or nudge: book the next nudge, or none once two went out or the window is too far gone.
export async function scheduleFollowUp(d1: D1Database, lead: db.Lead, draft: db.Draft, now: number): Promise<void> {
  const row = await d1
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE subscriber_id = ?1 AND action = 'follow_up' AND status = 'sent' AND after_message_id = ?2`)
    .bind(lead.subscriber_id, draft.after_message_id)
    .first<{ n: number }>();
  const gap = FOLLOWUP_GAPS_MS[row?.n ?? 0];
  const due = gap === undefined ? null : now + gap;
  const ok = due !== null && lead.last_inbound_at !== null && due <= lead.last_inbound_at + FOLLOWUP_CUTOFF_MS && draft.stage !== "joined" && draft.stage !== "closed";
  await d1.prepare(`UPDATE leads SET followup_due_at = ?2 WHERE subscriber_id = ?1`).bind(lead.subscriber_id, ok ? due : null).run();
}

// Active leads whose nudge is due: we spoke last, nothing waiting in the queue, still well inside the window.
export async function leadsNeedingFollowUp(d1: D1Database, now: number, onlyAiOn = false): Promise<db.Lead[]> {
  const { results } = await d1
    .prepare(
      `SELECT l.* FROM leads l
       WHERE l.status = 'active'${onlyAiOn ? " AND l.ai_on = 1" : ""} AND l.followup_due_at <= ?1 AND l.last_inbound_at > ?2
         AND (SELECT role FROM messages WHERE subscriber_id = l.subscriber_id ORDER BY id DESC LIMIT 1) = 'bot'
         AND NOT EXISTS (SELECT 1 FROM drafts WHERE subscriber_id = l.subscriber_id AND status IN ('pending', 'sending'))
         AND NOT EXISTS (SELECT 1 FROM lead_tags WHERE subscriber_id = l.subscriber_id AND tag IN ('friend', 'member'))`,
    )
    .bind(now, now - FOLLOWUP_CUTOFF_MS)
    .all<db.Lead>();
  return results;
}

// Only one of the cron and the webhook fast path drafts a lead at a time.
export const DRAFT_LOCK_MS = 90_000;

export async function lockLead(d1: D1Database, subscriberId: string, now: number): Promise<boolean> {
  const r = await d1
    .prepare(`UPDATE leads SET drafting_until = ?2 WHERE subscriber_id = ?1 AND COALESCE(drafting_until, 0) <= ?3`)
    .bind(subscriberId, now + DRAFT_LOCK_MS, now)
    .run();
  return Boolean(r.meta.changes);
}

export async function unlockLead(d1: D1Database, subscriberId: string): Promise<void> {
  await d1.prepare(`UPDATE leads SET drafting_until = NULL WHERE subscriber_id = ?1`).bind(subscriberId).run();
}
