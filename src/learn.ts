// The setter learns from the owner. When it hands a question off and the owner answers it themselves (from the Inbox or the IG
// app), Opus turns his answer into general facts and adds them to setting `learned_knowledge`, which the setter reads
// next to the product knowledge and the live Skool facts. Next time anyone asks the same thing, the AI answers it.
// Settings → "What the AI learned" shows the list to edit or delete.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MANUAL_NOTE } from "./dashboard";
import * as db from "./db";
import { KNOWLEDGE } from "./knowledge";
import { liveMagnets } from "./links";
import type { Env } from "./setter";
import { meter, type Meter } from "./usage";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const SETTLED_MS = 10 * MIN; // his answer is finished once he's been quiet this long
const GIVE_UP_MS = 2 * DAY; // no hand answer by then: nothing to learn

const LEARN_PROMPT = `You keep the knowledge base for the owner's Instagram DM setter, an AI that DMs as the owner to sell his Skool community, Your Community. The setter handed a lead's question to the owner because it didn't know the answer, and the owner answered it themselves. Turn his answer into facts the setter can reuse with anyone who asks the same thing.

Rules:
- Only lasting, general facts about the owner, his community, products, calls, prices, policies or how things work. One short plain sentence each, written as the owner ("I", "my community").
- Nothing about this lead, nothing personal, no promises or favors he made to this one person.
- Only what the owner actually said. Never add, guess or generalize past his words.
- Skip anything the knowledge below already covers, including the free guides/builds the setter can already send.
- No URLs or links: the setter sends links its own way.
- If his reply doesn't answer a reusable question (small talk, a pitch, a joke, a one-off), return no facts.`;

const Learned = z.object({ facts: z.array(z.string()) });
const LEARNED_SCHEMA = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
  additionalProperties: false,
};

export async function extractFacts(apiKey: string, known: string, convo: string, log?: Meter): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: LEARNED_SCHEMA } },
    system: [{ type: "text", text: `${LEARN_PROMPT}\n\n# What the setter already knows\n${known}` }],
    messages: [{ role: "user", content: convo }],
  });
  await log?.(response);
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return Learned.parse(JSON.parse(text)).facts.map((f) => f.trim()).filter((f) => f && !/https?:\/\//.test(f)).slice(0, 3);
}

// Everything the setter knows beyond the fixed product knowledge: today's Skool facts and what it learned from the owner.
export async function liveKnowledge(d1: D1Database): Promise<string> {
  const facts = await db.getSetting(d1, "community_facts");
  const learned = (await db.getSetting(d1, "learned_knowledge"))?.trim();
  return [facts, learned && `# Answers I gave by hand before (use them)\n${learned}`].filter(Boolean).join("\n\n");
}

interface Handoff {
  id: number;
  subscriber_id: string;
  after_message_id: number;
  bubbles: string;
  note: string | null;
  created_at: number;
  username: string | null;
}

export async function learnFromHandoffs(env: Env, now: number, extract: typeof extractFacts = extractFacts): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.subscriber_id, d.after_message_id, d.bubbles, d.note, d.created_at, l.username FROM drafts d JOIN leads l ON l.subscriber_id = d.subscriber_id
     WHERE d.action = 'handoff' AND d.learned_at IS NULL AND d.created_at > ?1 ORDER BY d.id LIMIT 100`,
  )
    .bind(now - 3 * DAY)
    .all<Handoff>();
  let calls = 0; // the model reads at most 3 answers a run; the rest wait (unanswered ones never block them)
  for (const h of results) {
    const done = () => env.DB.prepare(`UPDATE drafts SET learned_at = ?2 WHERE id = ?1`).bind(h.id, now).run();
    // The owner's answer = what went out after the handoff before the AI spoke again (a resume lets the AI answer instead).
    const ai = await env.DB.prepare(`SELECT MIN(created_at) AS at FROM drafts WHERE subscriber_id = ?1 AND id > ?2 AND status = 'sent' AND COALESCE(note, '') != ?3`)
      .bind(h.subscriber_id, h.id, MANUAL_NOTE)
      .first<{ at: number | null }>();
    const holdOn = new Set(JSON.parse(h.bubbles) as string[]); // the handoff's own "lemme double check that for u"
    const { results: all } = await env.DB.prepare(
      `SELECT text, created_at FROM messages WHERE subscriber_id = ?1 AND role = 'bot' AND id > ?2 AND created_at < ?3 ORDER BY id LIMIT 12`,
    )
      .bind(h.subscriber_id, h.after_message_id, ai?.at ?? Number.MAX_SAFE_INTEGER)
      .all<{ text: string; created_at: number }>();
    const his = all.filter((m) => !holdOn.has(m.text));
    if (!his.length) {
      if (ai?.at || now - h.created_at > GIVE_UP_MS) await done();
      continue;
    }
    if (now - Math.max(...his.map((m) => m.created_at)) < SETTLED_MS || calls++ >= 3) continue;
    const { results: before } = await env.DB.prepare(`SELECT role, text FROM messages WHERE subscriber_id = ?1 AND id <= ?2 ORDER BY id DESC LIMIT 12`)
      .bind(h.subscriber_id, h.after_message_id)
      .all<{ role: string; text: string }>();
    const convo = [
      ...before.reverse().map((m) => `${m.role === "lead" ? "THEM" : "SETTER"}: ${m.text}`),
      `(the setter handed this to the owner: ${h.note ?? "no note"})`,
      ...his.map((m) => `OWNER: ${m.text}`),
    ].join("\n");
    const free = (await liveMagnets(env.DB)).map((m) => `- ${m.name}`).join("\n");
    const known = `${KNOWLEDGE}\n\n${await liveKnowledge(env.DB)}${free ? `\n\n# Free guides/builds the setter can already send\n${free}` : ""}`;
    const facts = await extract(env.ANTHROPIC_API_KEY, known, convo, meter(env.DB, "learn", h.subscriber_id));
    if (facts.length) {
      const day = new Date(now).toISOString().slice(0, 10);
      const lines = facts.map((f) => `- ${f} (from my reply to @${h.username ?? h.subscriber_id}, ${day})`);
      const cur = (await db.getSetting(env.DB, "learned_knowledge"))?.trim();
      await db.setSetting(env.DB, "learned_knowledge", [cur, ...lines].filter(Boolean).join("\n"));
    }
    await done();
  }
}
