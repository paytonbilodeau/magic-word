import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import type { Env } from "../src/setter";
import { draftFor } from "../src/setter";
import { groupId, syncRecent } from "../src/sync";

const ME = "17840000000000001";
const LEAD = "990011";
const MIN = 60_000;
const T0 = Date.parse("2026-10-28T22:00:00Z");
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "+0000");

function makeEnv(): Env {
  return {
    DB: makeD1(),
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    SKOOL_LINK: "https://www.skool.com/your-community/about",
    AUTOPILOT: "false",
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
  };
}

// What the conversations API returns: newest-active thread first, each with its latest messages newest first.
// A group chat lists everyone in `members`.
let threads: { updated: number; lead: string; id?: string; members?: { id: string; username: string }[]; msgs: { id: string; at: number; from: string; text: string }[] }[] = [];
const calls: string[] = [];
beforeEach(() => {
  threads = [];
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/me?fields=user_id")) return Response.json({ user_id: ME });
      if (url.includes("fields=name,username")) return Response.json({ username: "lead.handle", name: "Sam" });
      if (url.includes("/me/conversations"))
        return Response.json({
          data: threads.map((t) => ({
            id: t.id ?? `conv-${t.lead}`,
            updated_time: iso(t.updated),
            participants: { data: [{ id: ME, username: "yourhandle" }, ...(t.members ?? [{ id: t.lead, username: "lead.handle" }])] },
            messages: { data: [...t.msgs].reverse().map((m) => ({ id: m.id, created_time: iso(m.at), from: { id: m.from }, message: m.text })) },
          })),
        });
      return Response.json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function connected() {
  const env = makeEnv();
  await db.setSetting(env.DB, "ig_token", "tok");
  return env;
}
const thread = async (env: Env) => (await db.history(env.DB, LEAD)).map((m) => [m.role, m.text]);

describe("missed-DM sync", () => {
  it("appends only the missing tail of a thread, in order, without duplicating what the webhook already saved", async () => {
    const env = await connected();
    await db.recordInbound(env.DB, { subscriber_id: LEAD, username: "lead.handle", first_name: null, text: "hey", mid: "m1" }, T0);
    threads = [
      {
        updated: T0 + 3 * MIN,
        lead: LEAD,
        msgs: [
          { id: "m0", at: T0 - MIN, from: LEAD, text: "older than what we have" },
          { id: "m1", at: T0, from: LEAD, text: "hey" },
          { id: "m2", at: T0 + MIN, from: ME, text: "yo whats good" },
          { id: "m3", at: T0 + 3 * MIN, from: LEAD, text: "send the link" },
        ],
      },
    ];
    expect(await syncRecent(env, T0 + 4 * MIN)).toBe(2);
    expect(await thread(env)).toEqual([
      ["lead", "hey"],
      ["bot", "yo whats good"],
      ["lead", "send the link"],
    ]);
    const lead = (await db.getLead(env.DB, LEAD))!;
    expect(lead.last_inbound_at).toBe(T0 + 3 * MIN); // their missed message reopens the 24h window
    expect(lead.status).toBe("active"); // our missed reply is recorded but never pauses the AI
    expect(await syncRecent(env, T0 + 5 * MIN)).toBe(0); // nothing twice
  });

  it("brings in a brand-new lead the webhook never saw, with their profile", async () => {
    const env = await connected();
    threads = [{ updated: T0, lead: "777", msgs: [{ id: "n1", at: T0, from: "777", text: "AI" }] }];
    await syncRecent(env, T0 + MIN);
    expect((await db.getLead(env.DB, "777"))?.username).toBe("lead.handle");
    expect((await db.history(env.DB, "777")).map((m) => m.text)).toEqual(["AI"]);
  });

  it("caches the account id from /me and stops at threads older than the last sync", async () => {
    const env = await connected();
    await syncRecent(env, T0); // first run just sets the watermark
    expect(await db.getSetting(env.DB, "ig_account_id")).toBe(ME);
    threads = [
      { updated: T0 + 10 * MIN, lead: "1", msgs: [{ id: "a", at: T0 + 10 * MIN, from: "1", text: "new" }] },
      { updated: T0 - 60 * MIN, lead: "2", msgs: [{ id: "b", at: T0 - 60 * MIN, from: "2", text: "old" }] },
    ];
    await syncRecent(env, T0 + 11 * MIN);
    expect(await db.getLead(env.DB, "1")).not.toBeNull();
    expect(await db.getLead(env.DB, "2")).toBeNull();
    expect(calls.filter((u) => u.includes("/me?fields=user_id"))).toHaveLength(1);
  });

  it("files a group chat as its own conversation, with who wrote each message, and never as a member's DMs", async () => {
    const env = await connected();
    await syncRecent(env, T0); // watermark
    const THREAD = "340282366841710301281153808080165647092";
    const conv = `aWdfZAG06${btoa(THREAD)}`;
    expect(groupId(conv)).toBe(`g:${THREAD}`);
    // Before the split, a group message had been filed under its first member.
    await db.recordInbound(env.DB, { subscriber_id: "11", username: "ellis", first_name: null, text: "dinner tmrw?", mid: "g1" }, T0 + MIN);
    await db.recordInbound(env.DB, { subscriber_id: "11", username: "ellis", first_name: null, text: "our own dm", mid: "d0" }, T0);
    threads = [
      {
        updated: T0 + 5 * MIN,
        lead: "11",
        id: conv,
        members: [
          { id: "11", username: "ellis" },
          { id: "22", username: "marlon" },
        ],
        msgs: [
          { id: "g1", at: T0 + MIN, from: "22", text: "dinner tmrw?" },
          { id: "g2", at: T0 + 2 * MIN, from: "11", text: "im in" },
          { id: "g3", at: T0 + 3 * MIN, from: ME, text: "I am down" },
        ],
      },
    ];
    expect(await syncRecent(env, T0 + 6 * MIN)).toBe(2);
    const g = `g:${THREAD}`;
    expect((await db.history(env.DB, g)).map((m) => [m.role, m.sender ?? null, m.text])).toEqual([
      ["lead", "22", "dinner tmrw?"], // moved out of Ellis's DMs, credited to Marlon
      ["lead", "11", "im in"],
      ["bot", null, "I am down"],
    ]);
    const group = (await db.getLead(env.DB, g))!;
    expect(JSON.parse(group.members!)).toEqual([
      { id: "11", username: "ellis" },
      { id: "22", username: "marlon" },
    ]);
    expect(group.last_inbound_at).toBeNull(); // nothing for the AI to answer
    expect(group.last_at).toBe(T0 + 3 * MIN);
    expect((await db.history(env.DB, "11")).map((m) => m.text)).toEqual(["our own dm"]);
    expect((await db.getLead(env.DB, "11"))!.last_at).toBe(T0); // the 1:1 preview no longer shows the group's message
    expect(await draftFor(env, group, T0 + 6 * MIN)).toBeNull();
    expect(await syncRecent(env, T0 + 7 * MIN)).toBe(0); // nothing twice
  });
});
