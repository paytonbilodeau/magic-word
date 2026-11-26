// The funnel's truth: how far each lead actually got, read from the thread itself rather than any stored stage (the
// history import only ever wrote "opener" or "link_sent", which made Get to know → Link sent look like 100%).
// A move counts when it happened in the conversation: they answered the get-to-know or a qualifying question, they got
// the pitch, they got the Skool link after the pitch, or a verified join came out of the DMs (set or asked).

import { LINK_RE as LINK } from "./brand";
import { TAP } from "./joins";
import type { Env } from "./setter";

export const MOVES = ["opener", "lead", "qualify", "pitch", "link_sent", "joined"] as const;
export type Move = (typeof MOVES)[number];

const KNOW = /what'?s ur (main )?biz|what do (u|you) do|whats ur page about|what u got going on|how'?s that (been )?going|hows that (been )?going|hows it goin|what got u (interested|curious)|what kinda (biz|business|work)/i;
const QUALIFY = /mind if i ask|implementing ai|started (using|implementing) ai|using ai (in|for|at all)|main thing u'?d want|biggest bottleneck|biggest thing holding|what'?s holding u back/i;
const PITCH = /open to joining|literally what i help (people|ppl) with|want the link\?|interested in joining|down to join/i;

// Walk the thread in order. Asking only counts once they answer with real words (not a button tap).
export function furthestMove(thread: { role: string; text: string }[], joinedFromDms = false): Move {
  let best = 0;
  let asked = 0; // the move a question is waiting on
  for (const m of thread) {
    if (m.role === "bot") {
      if (PITCH.test(m.text)) best = Math.max(best, 3);
      if (LINK.test(m.text) && best >= 3) best = Math.max(best, 4);
      if (QUALIFY.test(m.text)) asked = Math.max(asked, 2);
      else if (KNOW.test(m.text)) asked = Math.max(asked, 1);
    } else if (asked && !TAP.test(m.text.trim())) {
      best = Math.max(best, asked);
      asked = 0;
    }
  }
  return MOVES[joinedFromDms ? 5 : best];
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Cron: (re)read every lead active in the last 30 days whose thread changed since we last looked. Reads 90 leads per
// query (D1 caps bound parameters at 100) and saves each chunk as it goes, so a run cut short keeps what it did.
// Threads active in the last 5 minutes are always re-read: a bubble stamped earlier than the one before it doesn't move
// last_at, so a read that landed mid-send would otherwise never see the link.
export async function refreshMoves(env: Env, now: number, batch = 900): Promise<number> {
  const { results: due } = await env.DB.prepare(
    `SELECT subscriber_id, last_at FROM leads WHERE last_at > ?1 AND members IS NULL AND (move_at IS NULL OR move_at < last_at OR last_at > ?3) ORDER BY last_at DESC LIMIT ?2`,
  )
    .bind(now - WINDOW_MS, batch, now - 5 * 60_000)
    .all<{ subscriber_id: string; last_at: number }>();
  for (let i = 0; i < due.length; i += 90) {
    const chunk = due.slice(i, i + 90);
    const ids = chunk.map((l) => l.subscriber_id);
    const marks = ids.map((_, k) => `?${k + 1}`).join(",");
    const { results: msgs } = await env.DB.prepare(`SELECT subscriber_id, role, text FROM messages WHERE subscriber_id IN (${marks}) ORDER BY id`)
      .bind(...ids)
      .all<{ subscriber_id: string; role: string; text: string }>();
    const { results: joined } = await env.DB.prepare(
      `SELECT DISTINCT subscriber_id FROM joins WHERE subscriber_id IN (${marks}) AND confidence = 'confirmed' AND path IN ('set', 'asked')`,
    )
      .bind(...ids)
      .all<{ subscriber_id: string }>();
    const threads = new Map<string, { role: string; text: string }[]>();
    for (const m of msgs) (threads.get(m.subscriber_id) ?? threads.set(m.subscriber_id, []).get(m.subscriber_id)!).push(m);
    const fromDms = new Set(joined.map((j) => j.subscriber_id));
    await env.DB.batch(
      chunk.map((l) =>
        env.DB.prepare(`UPDATE leads SET move = ?2, move_at = ?3 WHERE subscriber_id = ?1`).bind(
          l.subscriber_id,
          furthestMove(threads.get(l.subscriber_id) ?? [], fromDms.has(l.subscriber_id)),
          l.last_at,
        ),
      ),
    );
  }
  return due.length;
}
