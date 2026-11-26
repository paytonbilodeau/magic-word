export interface Lead {
  subscriber_id: string;
  username: string | null;
  first_name: string | null;
  status: "active" | "paused" | "flagged" | "done";
  stage: string;
  last_inbound_at: number | null;
  created_at: number;
  test: number;
  last_at?: number | null; // newest message, kept by triggers (migrations/inbox.sql)
  profile_pic?: string | null;
  mc_id: string | null;
  paused_reason: PauseReason | null;
  paused_at: number | null;
  followup_due_at: number | null;
  disclosed_at: number | null;
  drafting_until: number | null;
  ai_on?: number; // 1 = the AI runs here even with the master switch off (migrations/ai_test.sql)
  members?: string | null; // group chats: JSON [{id, username}] of everyone but you (migrations/groups.sql)
}

// Why a lead is paused. Only "manual_reply" (the owner answered by hand) resumes on its own.
export type PauseReason = "admin" | "handoff" | "manual_reply";

export interface Message {
  id: number;
  subscriber_id: string;
  role: "lead" | "bot";
  text: string;
  created_at: number;
  mid: string | null;
  sender?: string | null; // group chats: the member who wrote it
}

export interface Draft {
  id: number;
  subscriber_id: string;
  after_message_id: number;
  action: "reply" | "stop" | "react" | "handoff" | "flag" | "follow_up";
  bubbles: string; // JSON string[]
  stage: string | null;
  note: string | null;
  status: "pending" | "sending" | "sent" | "rejected" | "superseded" | "expired" | "failed";
  send_after: number | null;
  error: string | null;
  created_at: number;
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;

// Group chats are leads `g:<Instagram thread id>` (src/sync.ts). The AI never answers one, and the Send API can't reach one.
export const isGroup = (subscriberId: string) => subscriberId.startsWith("g:");

// A thread's newest-message pointer after messages moved in or out of it (the trigger in migrations/inbox.sql only sees inserts).
export async function repoint(db: D1Database, subscriberId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE leads SET last_msg_id = (SELECT MAX(id) FROM messages WHERE subscriber_id = ?1),
         last_at = COALESCE((SELECT created_at FROM messages WHERE id = (SELECT MAX(id) FROM messages WHERE subscriber_id = ?1)), created_at)
       WHERE subscriber_id = ?1`,
    )
    .bind(subscriberId)
    .run();
}
const DUP_MS = 2 * 60 * 1000;

// Meta's reviewers (and the owner's own tests) put this in a DM or comment; those threads are all the reviewer login sees.
export const isTest = (text: string) => /\bsettertest\b/i.test(text);

// Returns false when this message was already recorded (webhook retry, or the other pipe got it first).
export async function recordInbound(
  db: D1Database,
  m: { subscriber_id: string; username: string | null; first_name: string | null; text: string; mid?: string; mc_id?: string },
  now: number,
): Promise<boolean> {
  // Accounts with a role on the app get each DM down both pipes (Meta webhook and Manychat). Same lead, same
  // text, one side without a mid = one message.
  const dup = await db
    .prepare(`SELECT id, mid FROM messages WHERE subscriber_id = ?1 AND role = 'lead' AND text = ?2 AND created_at > ?3 ORDER BY id DESC LIMIT 1`)
    .bind(m.subscriber_id, m.text, now - DUP_MS)
    .first<{ id: number; mid: string | null }>();
  if (dup && (!m.mid || !dup.mid)) {
    await db.batch([
      db.prepare(`UPDATE messages SET mid = COALESCE(mid, ?2) WHERE id = ?1`).bind(dup.id, m.mid ?? null),
      db.prepare(`UPDATE leads SET mc_id = COALESCE(?2, mc_id) WHERE subscriber_id = ?1`).bind(m.subscriber_id, m.mc_id ?? null),
    ]);
    return false;
  }
  const ins = await db
    .prepare(`INSERT OR IGNORE INTO messages (subscriber_id, role, text, created_at, mid) VALUES (?1, 'lead', ?2, ?3, ?4)`)
    .bind(m.subscriber_id, m.text, now, m.mid ?? null)
    .run();
  if (!ins.meta.changes) return false;
  await db.batch([
    db
      .prepare(
        `INSERT INTO leads (subscriber_id, username, first_name, last_inbound_at, created_at, test, mc_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
         ON CONFLICT (subscriber_id) DO UPDATE SET
           username = COALESCE(excluded.username, username),
           mc_id = COALESCE(excluded.mc_id, mc_id),
           name_key = CASE WHEN excluded.first_name IS NOT first_name AND excluded.first_name IS NOT NULL THEN NULL ELSE name_key END,
           first_name = COALESCE(excluded.first_name, first_name),
           last_inbound_at = excluded.last_inbound_at,
           test = MAX(test, excluded.test),
           status = CASE WHEN status = 'done' THEN 'active' ELSE status END`, // a closed lead who writes again is live again
      )
      .bind(m.subscriber_id, m.username, m.first_name, now, isTest(m.text) ? 1 : 0, m.mc_id ?? null),
    // The lead said more, so any draft still waiting answers a stale thread.
    db.prepare(`UPDATE drafts SET status = 'superseded' WHERE subscriber_id = ?1 AND status = 'pending'`).bind(m.subscriber_id),
  ]);
  return true;
}

// A message sent from the account by anything other than this Worker (the owner by hand, Manychat).
// Someone already answered, so a waiting draft is stale. Returns true when it was a message we hadn't recorded.
export async function recordEcho(db: D1Database, subscriberId: string, text: string, mid: string, now: number): Promise<boolean> {
  // Bubbles we sent through Manychat were stored without a mid; their echo claims the match instead of adding a copy.
  // One batch, so our own insert can't land between the claim and the insert (that doubled bubbles, 2026-10-29).
  const [claimed, ins] = await db.batch([
    db
      .prepare(
        `UPDATE messages SET mid = ?3 WHERE id = (SELECT id FROM messages WHERE subscriber_id = ?1 AND role = 'bot' AND mid IS NULL AND text = ?2
           AND created_at > ?4 ORDER BY id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM messages WHERE mid = ?3) RETURNING id`,
      )
      .bind(subscriberId, text, mid, now - 10 * 60 * 1000),
    db.prepare(`INSERT OR IGNORE INTO messages (subscriber_id, role, text, created_at, mid) VALUES (?1, 'bot', ?2, ?3, ?4) RETURNING id`).bind(subscriberId, text, now, mid),
  ]);
  if (claimed.results.length || !ins.results.length) return false; // our own send, already recorded
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO leads (subscriber_id, created_at) VALUES (?1, ?2)`).bind(subscriberId, now),
    db.prepare(`UPDATE drafts SET status = 'superseded' WHERE subscriber_id = ?1 AND status = 'pending'`).bind(subscriberId),
  ]);
  return true;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
}

// SQL: lead `l` spoke last. Our bubbles after their last message answer it, except a handoff's hold-on line ("lemme
// double check that for u"), which leaves them waiting on a real answer.
export const leadSpokeLast = (l: string) => {
  const last = `(SELECT MAX(id) FROM messages WHERE subscriber_id = ${l}.subscriber_id AND role = 'lead')`;
  return `(${last} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages b WHERE b.subscriber_id = ${l}.subscriber_id AND b.role = 'bot' AND b.id > ${last}
    AND NOT EXISTS (SELECT 1 FROM drafts h WHERE h.subscriber_id = b.subscriber_id AND h.action = 'handoff' AND h.status = 'sent'
      AND h.after_message_id = ${last} AND instr(h.bubbles, json_quote(b.text)) > 0)))`;
};

// Active leads whose thread ends on an unanswered lead message with no draft yet, quiet for `quietMs`,
// still inside the 24h window. A handoff doesn't count as an answer: a lead with one is active again only after a resume.
export async function leadsNeedingDraft(db: D1Database, now: number, quietMs: number, onlyAiOn = false): Promise<Lead[]> {
  const { results } = await db
    .prepare(
      `SELECT l.* FROM leads l
       WHERE l.status = 'active'${onlyAiOn ? " AND l.ai_on = 1" : ""}
         AND l.last_inbound_at <= ?1 AND l.last_inbound_at > ?2
         AND ${leadSpokeLast("l")}
         AND NOT EXISTS (SELECT 1 FROM lead_tags WHERE subscriber_id = l.subscriber_id AND tag = 'friend')
         AND (SELECT MAX(id) FROM messages WHERE subscriber_id = l.subscriber_id AND role = 'lead')
             > COALESCE((SELECT MAX(after_message_id) FROM drafts WHERE subscriber_id = l.subscriber_id AND status != 'superseded' AND action != 'handoff'), 0)`,
    )
    .bind(now - quietMs, now - WINDOW_MS)
    .all<Lead>();
  return results;
}

export async function history(db: D1Database, subscriberId: string, limit = 40): Promise<Message[]> {
  const { results } = await db
    .prepare(`SELECT * FROM (SELECT * FROM messages WHERE subscriber_id = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id`)
    .bind(subscriberId, limit)
    .all<Message>();
  return results;
}

export async function getLead(db: D1Database, subscriberId: string): Promise<Lead | null> {
  return db.prepare(`SELECT * FROM leads WHERE subscriber_id = ?1`).bind(subscriberId).first<Lead>();
}

export async function getDraft(db: D1Database, id: number): Promise<Draft | null> {
  return db.prepare(`SELECT * FROM drafts WHERE id = ?1`).bind(id).first<Draft>();
}

// A pause with no reason is the owner's own (never auto-resumed). Anything but active cancels a scheduled nudge.
export async function setLeadStatus(db: D1Database, subscriberId: string, status: Lead["status"], reason: PauseReason = "admin"): Promise<void> {
  await db
    .prepare(
      `UPDATE leads SET status = ?2, paused_reason = CASE WHEN ?2 = 'paused' THEN ?3 END, paused_at = NULL,
         followup_due_at = CASE WHEN ?2 = 'active' THEN followup_due_at END
       WHERE subscriber_id = ?1`,
    )
    .bind(subscriberId, status, reason)
    .run();
  // A resume drops the handoff/flag that paused it, or that draft keeps counting as the answer and the AI never replies.
  if (status === "active") await clearHandoff(db, subscriberId);
}

export async function clearHandoff(db: D1Database, subscriberId: string): Promise<void> {
  await db
    .prepare(`UPDATE drafts SET status = 'superseded' WHERE subscriber_id = ?1 AND status = 'pending' AND action IN ('handoff', 'flag')`)
    .bind(subscriberId)
    .run();
}

export async function setDraftStatus(db: D1Database, id: number, status: Draft["status"], error: string | null = null): Promise<void> {
  await db.prepare(`UPDATE drafts SET status = ?2, error = ?3 WHERE id = ?1`).bind(id, status, error).run();
}

// Friends & family: the AI never DMs them. A lead tagged `friend` (Settings or the thread's tags), or an @username on
// the Settings list for someone who hasn't DMed yet (setting `friends`, a JSON list of lowercase usernames).
export const FRIEND = "friend";
export async function friendHandles(d1: D1Database): Promise<string[]> {
  try {
    return JSON.parse((await getSetting(d1, "friends")) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export async function isFriend(d1: D1Database, lead: Pick<Lead, "subscriber_id" | "username">): Promise<boolean> {
  if (await d1.prepare(`SELECT 1 FROM lead_tags WHERE subscriber_id = ?1 AND tag = ?2`).bind(lead.subscriber_id, FRIEND).first()) return true;
  return Boolean(lead.username && (await friendHandles(d1)).includes(lead.username.toLowerCase()));
}
