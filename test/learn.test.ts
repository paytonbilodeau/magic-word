import { describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { MANUAL_NOTE } from "../src/dashboard";
import { learnFromHandoffs, liveKnowledge } from "../src/learn";
import type { Env } from "../src/setter";

const LEAD = "111";
const T0 = Date.parse("2026-10-29T20:00:00Z");
const MIN = 60_000;

async function setup() {
  const env = { DB: makeD1(), ANTHROPIC_API_KEY: "k" } as unknown as Env;
  await env.DB.prepare(`INSERT INTO leads (subscriber_id, username, created_at) VALUES (?1, 'dex.044', ?2)`).bind(LEAD, T0).run();
  const msg = (id: number, role: string, text: string, at: number) =>
    env.DB.prepare(`INSERT INTO messages (id, subscriber_id, role, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(id, LEAD, role, text, at).run();
  await msg(1, "bot", "hit me up whenever ur ready", T0 - MIN);
  await msg(2, "lead", "is there a refund policy", T0);
  await env.DB.prepare(`INSERT INTO drafts (id, subscriber_id, after_message_id, action, bubbles, note, status, created_at) VALUES (10, ?1, 2, 'handoff', '[]', 'asked about refunds', 'pending', ?2)`)
    .bind(LEAD, T0 + 5_000)
    .run();
  return { env, msg };
}

describe("learning from the owner's answers to handoffs", () => {
  it("waits for his answer to settle, learns it once, and the setter reads it after the live facts", async () => {
    const { env, msg } = await setup();
    await db.setSetting(env.DB, "community_facts", "# Live community facts");
    const extract = vi.fn(async () => ["No refunds, but you can cancel anytime in one click."]);
    await msg(3, "bot", "no refunds but u can cancel anytime in 1 click", T0 + 3 * MIN);
    await learnFromHandoffs(env, T0 + 8 * MIN, extract);
    expect(extract).not.toHaveBeenCalled(); // he might still be typing
    await learnFromHandoffs(env, T0 + 14 * MIN, extract);
    expect(extract).toHaveBeenCalledTimes(1);
    const [, known, convo] = extract.mock.calls[0] as unknown as [string, string, string];
    expect(known).toContain("# Live community facts");
    expect(convo).toBe(
      ["SETTER: hit me up whenever ur ready", "THEM: is there a refund policy", "(the setter handed this to the owner: asked about refunds)", "OWNER: no refunds but u can cancel anytime in 1 click"].join("\n"),
    );
    await learnFromHandoffs(env, T0 + 20 * MIN, extract);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await liveKnowledge(env.DB)).toBe(
      "# Live community facts\n\n# Answers I gave by hand before (use them)\n- No refunds, but you can cancel anytime in one click. (from my reply to @dex.044, 2026-10-29)",
    );
  });

  it("an Inbox hand reply counts as his; once the AI answered instead (a resume), there's nothing to learn", async () => {
    const { env, msg } = await setup();
    const extract = vi.fn(async () => []);
    await env.DB.prepare(`INSERT INTO drafts (id, subscriber_id, after_message_id, action, bubbles, note, status, created_at) VALUES (11, ?1, 2, 'reply', '[]', ?2, 'sent', ?3)`)
      .bind(LEAD, MANUAL_NOTE, T0 + MIN)
      .run();
    await msg(3, "bot", "nah no refunds", T0 + MIN);
    await learnFromHandoffs(env, T0 + 15 * MIN, extract);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await db.getSetting(env.DB, "learned_knowledge")).toBeNull(); // the model found nothing reusable

    const second = await setup();
    await second.env.DB.prepare(`INSERT INTO drafts (id, subscriber_id, after_message_id, action, bubbles, note, status, created_at) VALUES (11, ?1, 2, 'reply', '[]', '', 'sent', ?2)`)
      .bind(LEAD, T0 + MIN)
      .run();
    await second.msg(3, "bot", "the AI's own answer", T0 + MIN + 5_000);
    await learnFromHandoffs(second.env, T0 + 15 * MIN, extract);
    expect(extract).toHaveBeenCalledTimes(1);
    const row = await second.env.DB.prepare(`SELECT learned_at FROM drafts WHERE id = 10`).first<{ learned_at: number | null }>();
    expect(row?.learned_at).toBe(T0 + 15 * MIN);
  });

  it("the handoff's own hold-on line isn't the owner's answer", async () => {
    const { env, msg } = await setup();
    await env.DB.prepare(`UPDATE drafts SET bubbles = '["lemme double check that for u"]', status = 'sent' WHERE id = 10`).run();
    await msg(3, "bot", "lemme double check that for u", T0 + 10_000);
    const extract = vi.fn(async () => []);
    await learnFromHandoffs(env, T0 + 30 * MIN, extract);
    expect(extract).not.toHaveBeenCalled();
    await msg(4, "bot", "no refunds but u can cancel anytime", T0 + 31 * MIN);
    await learnFromHandoffs(env, T0 + 45 * MIN, extract);
    expect((extract.mock.calls[0] as unknown as string[])[2]).toContain("OWNER: no refunds but u can cancel anytime");
    expect((extract.mock.calls[0] as unknown as string[])[2]).not.toContain("OWNER: lemme double check");
  });

  it("handoffs still waiting on an answer never block the answered ones behind them", async () => {
    const { env, msg } = await setup();
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare(`INSERT INTO drafts (id, subscriber_id, after_message_id, action, bubbles, note, status, created_at) VALUES (?1, 'other', 1, 'handoff', '[]', '', 'pending', ?2)`)
        .bind(i + 1, T0)
        .run();
    }
    await env.DB.prepare(`INSERT INTO leads (subscriber_id, created_at) VALUES ('other', ?1)`).bind(T0).run();
    await msg(3, "bot", "no refunds", T0 + MIN);
    const extract = vi.fn(async () => []);
    await learnFromHandoffs(env, T0 + 15 * MIN, extract);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
