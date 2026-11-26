// Right after a new inbound DM (inside the webhook's waitUntil): fill in voice notes, images, shares and story replies
// (src/media.ts), and on autopilot
// answer within Meta's 30 seconds instead of waiting for the next cron. The cron still covers anything this misses.

import * as db from "./db";
import { logError } from "./health";
import { enrichText, pendingMedia, senses } from "./media";
import { senderAction, type MetaEvent } from "./meta";
import { draftFor, sendable, sendDraft, type Env } from "./setter";

// Long enough for "hey" + "saw ur reel" to land as one burst, short enough to stay inside 30s with the model call.
export const BURST_MS = 5_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function enrichInbound(env: Env, ev: MetaEvent): Promise<void> {
  if (!pendingMedia(ev.text, ev.parts)) return;
  const text = await enrichText(ev.text, ev.parts, senses(env));
  if (text !== ev.text) await env.DB.prepare(`UPDATE messages SET text = ?2 WHERE mid = ?1`).bind(ev.mid, text).run();
}

// Like a person with the chat open: "seen" 2-4s after the message lands (while still waiting out the burst), then once
// they've stopped for BURST_MS, a 1-2s beat and the typing dots, which stay up while the model writes. The send
// counts that time toward the first bubble's typing.
export async function replySoon(env: Env, leadId: string, mid: string, sleep = pause): Promise<void> {
  // Their newest message. Our own bubbles still going out don't count: a message sent mid-reply gets answered too.
  const latest = async () =>
    (await env.DB.prepare(`SELECT mid FROM messages WHERE subscriber_id = ?1 AND role = 'lead' ORDER BY id DESC LIMIT 1`).bind(leadId).first<{ mid: string | null }>())?.mid;
  const lead = await db.getLead(env.DB, leadId);
  if (!lead || (await db.isFriend(env.DB, lead))) return; // friends & family: not even "seen"
  const token = env.TYPING === "true" && !lead?.mc_id ? await db.getSetting(env.DB, "ig_token") : null; // Manychat-routed: no indicators
  const cue = async (action: "mark_seen" | "typing_on" | "typing_off") => void (token && (await senderAction(token, leadId, action).catch(() => {})));
  const seen = 2000 + Math.random() * 2000;
  await sleep(seen);
  if ((await latest()) === mid) await cue("mark_seen");
  await sleep(BURST_MS - seen);
  if ((await latest()) !== mid) return; // they kept typing: that message runs its own
  await sleep(1000 + Math.random() * 1000);
  if ((await latest()) !== mid) return;
  const now = await db.getLead(env.DB, leadId); // The owner answering by hand pauses it
  if (now?.status !== "active") return;
  await cue("typing_on");
  const typingAt = Date.now();
  const draft = await draftFor(env, now, typingAt); // already answered (the owner, a flow): no draft
  if (!(JSON.parse(draft?.bubbles ?? "[]") as string[]).length) await cue("typing_off"); // nothing to say (a heart, handoff, flag)
  if (!draft?.send_after) return;
  if (env.SEND_QUEUE) return void (await env.SEND_QUEUE.send({ draft_id: draft.id, typing_at: token ? typingAt : undefined }));
  await sleep(Math.max(0, draft.send_after - Date.now()));
  const fresh = await db.getLead(env.DB, leadId);
  if (!fresh || !sendable(fresh, draft)) return;
  await sendDraft(env, draft, Date.now(), undefined, { auto: true, typingAt: token ? typingAt : undefined });
}

export async function afterInbound(env: Env, ev: MetaEvent): Promise<void> {
  try {
    await enrichInbound(env, ev);
    const one = env.AUTOPILOT !== "true" && (await env.DB.prepare(`SELECT ai_on FROM leads WHERE subscriber_id = ?1`).bind(ev.lead_id).first<{ ai_on: number }>())?.ai_on === 1;
    if (env.AUTOPILOT === "true" || one) await replySoon(env, ev.lead_id, ev.mid);
  } catch (e) {
    await logError(env.DB, "fast reply", ev.lead_id, e);
  }
}
