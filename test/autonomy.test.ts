import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";

vi.mock("../src/brain", async (orig) => ({ ...(await orig<typeof import("../src/brain")>()), decide: vi.fn() }));

import { DISCLOSURE, handleEcho, resumeManualPauses } from "../src/autonomy";
import { decide, FOLLOW_UP_ASK } from "../src/brain";
import * as db from "../src/db";
import { replySoon } from "../src/fastpath";
import { describeImage, enrichPending, enrichText, pendingMedia } from "../src/media";
import type { Part } from "../src/attachments";
import worker from "../src/index";
import { hmacHex, parseWebhook, type MetaEvent } from "../src/meta";
import { handleAdminPost } from "../src/admin";
import { autopilotDelayMs, draftFor, pace, runSendJobs, sendDraft, tick, typingMs, type Env, type SendJob } from "../src/setter";

const ME = "17840000000000001";
const LEAD = "990011";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_800_000_000_000;

const aiRun = vi.fn();

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: makeD1(),
    AI: { run: aiRun } as unknown as Ai,
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    SKOOL_LINK: "https://www.skool.com/your-community/about",
    AUTOPILOT: "true", // the AI is on (autopilot) or off; off drafts nothing
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
    ...over,
  };
}

async function connected(over: Partial<Env> = {}): Promise<Env> {
  const env = makeEnv(over);
  await db.setSetting(env.DB, "ig_token", "tok");
  return env;
}

const inbound = (env: Env, text: string, at: number, mid?: string) =>
  db.recordInbound(env.DB, { subscriber_id: LEAD, username: "lead1", first_name: "Sam", text, mid }, at);
const echo = (text: string, mid: string, at: number, app_id: string | null = null): MetaEvent => ({
  kind: "echo",
  lead_id: LEAD,
  mid,
  text,
  at,
  attachments: [],
  parts: [],
  app_id,
});
const lead = async (env: Env) => (await db.getLead(env.DB, LEAD))!;
const drafts = async (env: Env) => (await env.DB.prepare(`SELECT * FROM drafts ORDER BY id`).all<db.Draft>()).results;
const sentTexts = () => sends.map((s) => s.text);

let sends: { to: string; text: string }[] = [];
let nextMid = 0;
let onSend: ((text: string, mid: string) => Promise<void>) | null = null;

beforeEach(() => {
  sends = [];
  onSend = null;
  aiRun.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/me/messages")) {
        const body = JSON.parse(String(init?.body)) as { recipient: { id: string }; message: { text: string } };
        const mid = `out-${++nextMid}`;
        if (onSend) await onSend(body.message.text, mid);
        sends.push({ to: body.recipient.id, text: body.message.text });
        return Response.json({ recipient_id: LEAD, message_id: mid });
      }
      if (url.includes("fields=name,username")) return Response.json({ username: "lead.handle", name: "Sam Lee" });
      return Response.json({});
    }),
  );
  vi.mocked(decide).mockReset();
  vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yooo", "whats ur biz rn?"], stage: "lead", note: "" });
});
afterEach(() => vi.unstubAllGlobals());

// A lead says hi, we reply (approved by hand) at T0 + 1 min.
async function replied(env: Env): Promise<void> {
  await inbound(env, "hey", T0);
  await tick(env, T0 + MIN);
  const [d] = await drafts(env);
  await sendDraft(env, d, T0 + MIN);
}

describe("auto-pause on manual reply", () => {
  it("a hand-sent DM pauses the thread and it resumes after the configured hours", async () => {
    const env = await connected();
    await replied(env);
    await handleEcho(env.DB, echo("yo its owner, real me", "hand-1", T0 + 10 * MIN));
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "manual_reply", paused_at: T0 + 10 * MIN, followup_due_at: null });

    // The lead answers while the owner is on it: the AI stays out.
    await inbound(env, "oh sick", T0 + 11 * MIN);
    await tick(env, T0 + 20 * MIN);
    expect(decide).toHaveBeenCalledTimes(1);

    // Another hand-sent DM restarts the clock (default 6h).
    await handleEcho(env.DB, echo("so what are u building", "hand-2", T0 + 2 * HOUR));
    await tick(env, T0 + 6 * HOUR + 30 * MIN);
    expect((await lead(env)).status).toBe("paused");
    await tick(env, T0 + 8 * HOUR + MIN);
    expect(await lead(env)).toMatchObject({ status: "active", paused_reason: null });
  });

  it("a Manychat flow's echo (a card, or text it has sent to other people) doesn't pause; the owner's one-off does", async () => {
    const env = await connected();
    await replied(env);
    const magnet = "Awesome, here you go! 👇\n\nhttps://creator-economy.notion.site/Background-Music-Library";
    for (const other of ["a", "b", "c"]) await db.recordEcho(env.DB, other, magnet, `mc-${other}`, T0);
    await handleEcho(env.DB, echo(magnet, "mc-lead", T0 + 5 * MIN));
    await handleEcho(env.DB, echo("[template] Send the Link! 🔗", "mc-card", T0 + 6 * MIN));
    expect((await lead(env)).status).toBe("active");
    await handleEcho(env.DB, echo(magnet.replace("Awesome", "ok"), "hand-1", T0 + 7 * MIN)); // only 0 others got this one
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "manual_reply" });
  });

  it("the thread picks back up once resumed if the lead's message is still unanswered", async () => {
    const env = await connected();
    await db.setSetting(env.DB, "auto_resume_hours", "2");
    await replied(env);
    await handleEcho(env.DB, echo("one sec", "hand-1", T0 + 5 * MIN));
    await inbound(env, "ok whats the price", T0 + 6 * MIN);
    await tick(env, T0 + 2 * HOUR + 6 * MIN);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("respects the settings: off means no pause, 0 hours means never resume", async () => {
    const off = await connected();
    await db.setSetting(off.DB, "pause_on_manual_reply", "false");
    await replied(off);
    await handleEcho(off.DB, echo("by hand", "hand-1", T0 + 5 * MIN));
    expect((await lead(off)).status).toBe("active");

    const forever = await connected();
    await db.setSetting(forever.DB, "auto_resume_hours", "0");
    await replied(forever);
    await handleEcho(forever.DB, echo("by hand", "hand-1", T0 + 5 * MIN));
    await resumeManualPauses(forever.DB, T0 + 100 * HOUR);
    expect((await lead(forever)).status).toBe("paused");
  });

  it("pauses the owner set themselves, handoffs and flags are never auto-resumed or overwritten", async () => {
    const env = await connected();
    await replied(env);
    await handleAdminPost(env, new Request(`https://x/admin/leads/${LEAD}/pause`, { method: "POST" }), `/admin/leads/${LEAD}/pause`);
    expect((await lead(env)).paused_reason).toBe("admin");
    await handleEcho(env.DB, echo("by hand", "hand-1", T0 + 5 * MIN));
    await tick(env, T0 + 20 * HOUR);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "admin" });

    // Resume clears it.
    await handleAdminPost(env, new Request(`https://x/admin/leads/${LEAD}/resume`, { method: "POST" }), `/admin/leads/${LEAD}/resume`);
    expect(await lead(env)).toMatchObject({ status: "active", paused_reason: null });

    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: [], stage: "lead", note: "wants a call" });
    await inbound(env, "can we hop on a call", T0 + 21 * HOUR);
    await tick(env, T0 + 21 * HOUR + MIN);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "handoff" });
    await handleEcho(env.DB, echo("sure lemme check", "hand-2", T0 + 21 * HOUR + 2 * MIN));
    await resumeManualPauses(env.DB, T0 + 100 * HOUR);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "handoff" });
  });

  it("resuming a handoff lets the AI answer the message it handed off", async () => {
    const env = await connected();
    await replied(env);
    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: [], stage: "lead", note: "asks about my videos" });
    await inbound(env, "were ur last 4 videos edited hands off?", T0 + 2 * HOUR);
    await tick(env, T0 + 2 * HOUR + MIN);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "handoff" });

    await handleAdminPost(env, new Request(`https://x/admin/leads/${LEAD}/resume`, { method: "POST" }), `/admin/leads/${LEAD}/resume`);
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yep all of em"], stage: "lead", note: "" });
    await tick(env, T0 + 2 * HOUR + 2 * MIN);
    const all = await drafts(env);
    expect(all.at(-2)).toMatchObject({ action: "handoff", status: "superseded" });
    expect(all.at(-1)).toMatchObject({ action: "reply" });
  });

  it("a handoff sends its hold-on line, stays paused and waiting; resume gets the real answer, a hand answer clears it", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    const waiting = async () => (await env.DB.prepare(`SELECT COUNT(*) n FROM leads l WHERE ${db.leadSpokeLast("l")}`).first<{ n: number }>())!.n;
    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: ["lemme double check that for u"], stage: "pitch", note: "call times" });
    await inbound(env, "is there times for group calls", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(sentTexts()).toEqual(["lemme double check that for u"]);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "handoff", followup_due_at: null });
    expect(await waiting()).toBe(1); // still on the Dashboard's handoff list and dotted in the Inbox
    await tick(env, T0 + 10 * MIN);
    expect(sentTexts()).toHaveLength(1);

    await handleAdminPost(env, new Request(`https://x/admin/leads/${LEAD}/resume`, { method: "POST" }), `/admin/leads/${LEAD}/resume`);
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["tue and thu 4-5pm central on zoom"], stage: "pitch", note: "" });
    await tick(env, T0 + 11 * MIN);
    await tick(env, T0 + 12 * MIN);
    expect(sentTexts()).toEqual(["lemme double check that for u", "tue and thu 4-5pm central on zoom"]);
    expect(await waiting()).toBe(0);

    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: ["good q, lemme find out"], stage: "pitch", note: "refund" });
    await inbound(env, "can i get a refund if i dont like it", T0 + 20 * MIN);
    await tick(env, T0 + 21 * MIN);
    await tick(env, T0 + 22 * MIN);
    expect(await waiting()).toBe(1);
    await handleEcho(env.DB, echo("no refunds but u can cancel anytime", "hand-9", T0 + 25 * MIN));
    expect(await waiting()).toBe(0);
  });

  it("a handoff with nothing to say sends nothing", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: [], stage: "lead", note: "model declined" });
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 10 * MIN);
    expect(sends).toHaveLength(0);
    expect(await lead(env)).toMatchObject({ status: "paused", paused_reason: "handoff" });
  });

  it("our own sends never pause, even when the echo lands before we record the send", async () => {
    const env = await connected();
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    // Meta delivers the echo while the Send API call is still in flight.
    onSend = (text, mid) => handleEcho(env.DB, echo(text, mid, T0 + MIN));
    await sendDraft(env, (await drafts(env))[0], T0 + MIN);
    expect((await lead(env)).status).toBe("active");
    expect((await db.history(env.DB, LEAD)).map((m) => m.text)).toEqual(["hey", "yooo", "whats ur biz rn?"]);
  });

  it("an echo sent by another app (Manychat) is not a manual reply", async () => {
    const env = await connected();
    await replied(env);
    await handleEcho(env.DB, echo("here's the guide", "mc-1", T0 + 5 * MIN, "1234"));
    expect(await lead(env)).toMatchObject({ status: "active", followup_due_at: null });
  });

  it("works end to end through the webhook", async () => {
    const env = await connected();
    await replied(env);
    const body = JSON.stringify({
      object: "instagram",
      entry: [{ id: ME, messaging: [{ sender: { id: ME }, recipient: { id: LEAD }, timestamp: T0 + 5 * MIN, message: { mid: "hand-1", text: "owner here", is_echo: true } }] }],
    });
    const req = new Request("https://x/meta", { method: "POST", body, headers: { "X-Hub-Signature-256": `sha256=${await hmacHex("appsecret", body)}` } });
    await worker.fetch(req, env, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect((await lead(env)).paused_reason).toBe("manual_reply");
  });
});

describe("follow-ups", () => {
  it("nudges twice inside the window, then stops", async () => {
    const env = await connected();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yo u still there?"], stage: "lead", note: "" });
    await replied(env);
    expect((await lead(env)).followup_due_at).toBe(T0 + MIN + 3 * HOUR);

    await tick(env, T0 + 3 * HOUR); // not due yet
    expect(await drafts(env)).toHaveLength(1);
    await tick(env, T0 + 3 * HOUR + MIN);
    const nudge = (await drafts(env))[1];
    expect(nudge).toMatchObject({ action: "follow_up", status: "pending" });
    expect(nudge.send_after).not.toBeNull(); // AI on: it sends itself after a few seconds
    expect(vi.mocked(decide).mock.calls.at(-1)?.[3]).toBe(FOLLOW_UP_ASK);
    const sentAt = T0 + 3 * HOUR + 2 * MIN;
    await tick(env, sentAt); // sends it, and nothing doubles
    expect(await drafts(env)).toHaveLength(2);
    expect((await drafts(env))[1].status).toBe("sent");

    const due = (await lead(env)).followup_due_at!;
    expect(due).toBeGreaterThan(sentAt);
    await tick(env, due);
    const second = (await drafts(env))[2];
    expect(second.action).toBe("follow_up");
    await tick(env, due + MIN); // sends the second
    expect((await lead(env)).followup_due_at).toBeNull(); // two is the max
    await tick(env, T0 + 19 * HOUR);
    expect(await drafts(env)).toHaveLength(3);
  });

  it("never nudges a paying member", async () => {
    const env = await connected();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["bet"], stage: "lead", note: "" });
    await replied(env);
    await env.DB.prepare(`INSERT INTO lead_tags (subscriber_id, tag, created_at) VALUES (?1, 'member', 1)`).bind(LEAD).run();
    await tick(env, T0 + 3 * HOUR + MIN);
    expect(await drafts(env)).toHaveLength(1);
  });

  it("never schedules a nudge past 20h after the lead's last message", async () => {
    const env = await connected();
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await sendDraft(env, (await drafts(env))[0], T0 + 18 * HOUR); // approved late
    expect((await lead(env)).followup_due_at).toBeNull();
  });

  it("a pending nudge still expires when the 24h window closes, and sendDraft refuses it", async () => {
    const env = await connected();
    await replied(env);
    await tick(env, T0 + 3 * HOUR + MIN);
    const nudge = (await drafts(env))[1];
    await tick(env, T0 + 24 * HOUR + MIN);
    expect((await db.getDraft(env.DB, nudge.id))?.status).toBe("expired");
    await sendDraft(env, { ...nudge, status: "pending" }, T0 + 24 * HOUR + MIN);
    expect(sends).toHaveLength(2); // only the first reply's two bubbles
  });

  it("is cancelled by a lead message, an echo, a pause, a flag or a stop", async () => {
    const cases: [string, (env: Env) => Promise<void>][] = [
      ["lead message", async (env) => void (await inbound(env, "sorry was busy", T0 + HOUR))],
      ["echo", (env) => handleEcho(env.DB, echo("yo", "hand-1", T0 + HOUR))],
      ["pause", (env) => db.setLeadStatus(env.DB, LEAD, "paused")],
      ["flag", (env) => db.setLeadStatus(env.DB, LEAD, "flagged")],
      ["stop", (env) => db.setLeadStatus(env.DB, LEAD, "done")],
    ];
    for (const [, cancel] of cases) {
      const env = await connected();
      await replied(env);
      await cancel(env);
      vi.mocked(decide).mockClear();
      await tick(env, T0 + 3 * HOUR + MIN);
      const asks = vi.mocked(decide).mock.calls.map((c) => c[3]);
      expect(asks).not.toContain(FOLLOW_UP_ASK);
    }
  });

  it("the model can decline to nudge", async () => {
    const env = await connected();
    await replied(env);
    vi.mocked(decide).mockResolvedValue({ action: "stop", bubbles: [], stage: "lead", note: "they said later" });
    await tick(env, T0 + 3 * HOUR + MIN);
    expect(await drafts(env)).toHaveLength(1);
    expect((await lead(env)).status).toBe("active"); // a declined nudge doesn't close the lead
    await tick(env, T0 + 4 * HOUR);
    expect(vi.mocked(decide).mock.calls.filter((c) => c[3] === FOLLOW_UP_ASK)).toHaveLength(1);
  });

  it("sends on autopilot", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["u still around?"], stage: "lead", note: "" });
    await tick(env, T0 + 2 * MIN + 3 * HOUR);
    await tick(env, T0 + 3 * MIN + 3 * HOUR);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?", "u still around?"]);
  });
});

describe("autopilot", () => {
  it("sends within a few seconds, with no disclosure line while it is switched off", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    expect(autopilotDelayMs(env, 1)).toBe(0); // 240s configured: autopilot skips it, the typing dots are the delay
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    const [d] = await drafts(env);
    expect(d.send_after! - T0 - MIN).toBeLessThanOrEqual(5_000);
    await tick(env, T0 + 2 * MIN);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?"]);
    expect((await lead(env)).disclosed_at).toBeNull();

    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["sick"], stage: "qualify", note: "" });
    await inbound(env, "i run a gym", T0 + 3 * MIN);
    await tick(env, T0 + 4 * MIN);
    await tick(env, T0 + 5 * MIN);
    expect(sentTexts()).not.toContain(DISCLOSURE);
    expect(sentTexts().at(-1)).toBe("sick");
  });

  it("approval-mode sends carry no disclosure", async () => {
    const env = await connected();
    await replied(env);
    expect(sentTexts()).not.toContain(DISCLOSURE);
    expect((await lead(env)).disclosed_at).toBeNull();
  });

  it("the webhook fast path answers without waiting for the cron, and racing the cron never double-sends", async () => {
    const env = await connected({ AUTOPILOT: "true", REPLY_DELAY_MIN_S: "0", REPLY_DELAY_MAX_S: "0" });
    vi.mocked(decide).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20)); // the model takes a moment
      return { action: "reply", bubbles: ["yooo"], stage: "lead", note: "" };
    });
    const now = Date.now();
    await inbound(env, "hey", now, "m1");
    await Promise.all([replySoon(env, LEAD, "m1", async () => {}), tick(env, now + MIN), tick(env, now + MIN)]);
    await tick(env, now + 2 * MIN);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sentTexts()).toEqual(["yooo"]);
  });

  it("the fast path skips a message that's no longer the latest", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    const now = Date.now();
    await inbound(env, "hey", now, "m1");
    await inbound(env, "saw ur reel", now + 1000, "m2");
    await replySoon(env, LEAD, "m1", async () => {});
    expect(decide).not.toHaveBeenCalled();
  });

  it("a double-tapped Send goes out once", async () => {
    const env = await connected();
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    const [d] = await drafts(env);
    await Promise.all([sendDraft(env, d, T0 + 2 * MIN), sendDraft(env, d, T0 + 2 * MIN)]);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?"]);
  });

  it("handoff and flag still pause and never send", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    vi.mocked(decide).mockResolvedValue({ action: "flag", bubbles: [], stage: "opener", note: "spam" });
    await inbound(env, "buy followers", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 10 * MIN);
    expect((await lead(env)).status).toBe("flagged");
    expect(sends).toHaveLength(0);
  });

  it("a draft made while the thread moved on is dropped", async () => {
    const env = await connected();
    await inbound(env, "hey", T0);
    vi.mocked(decide).mockImplementation(async () => {
      await handleEcho(env.DB, echo("hey hey", "hand-1", T0 + MIN)); // The owner answers while the model thinks
      return { action: "reply", bubbles: ["yooo"], stage: "lead", note: "" };
    });
    expect(await draftFor(env, await lead(env), T0 + MIN)).toBeNull();
    expect(await drafts(env)).toHaveLength(0);
  });
});

describe("voice notes and images", () => {
  const VOICE = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1";
  const IMAGE = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2";

  it("parses attachment URLs from the webhook", () => {
    const [ev] = parseWebhook({
      object: "instagram",
      entry: [
        {
          id: ME,
          messaging: [
            {
              sender: { id: LEAD },
              recipient: { id: ME },
              message: { mid: "m1", attachments: [{ type: "audio", payload: { url: VOICE } }, { type: "image", payload: { url: IMAGE } }, { type: "share" }] },
            },
          ],
        },
      ],
    });
    expect(ev.text).toBe("[voice note] [image] [shared a post]");
    expect(ev.attachments).toEqual([
      { type: "audio", url: VOICE },
      { type: "image", url: IMAGE },
      { type: "share", url: null },
    ]);
  });

  it("fills placeholders in order and fails soft", async () => {
    const parts: Part[] = [
      { type: "audio", url: "a1" },
      { type: "image", url: "i1" },
      { type: "audio", url: "a2" },
    ];
    const text = await enrichText("[voice note] [image] [voice note] look", parts, {
      listen: async (url) => {
        if (url === "a2") throw new Error("nova down");
        return 'i run a "med spa"';
      },
      look: async () => null,
    });
    expect(text).toBe(`[voice note] "i run a 'med spa'" [image] [voice note] look`);
    expect(pendingMedia(text, parts)).toBe(true); // the image and the second voice note get another go
    expect(pendingMedia(`[voice note] "a" [image] "b"`, parts.slice(0, 2))).toBe(false);
  });

  it("reads shared posts, reels and the story they replied to", async () => {
    const looked: string[] = [];
    const sense = {
      listen: async () => null,
      look: async (url: string, look: string) => {
        looked.push(`${look}:${url}`);
        return url === "reel.mp4" ? "if i lost everything i'd start an editing agency" : url === "page" ? null : "a guy at a desk with two monitors";
      },
    };
    expect(await enrichText("[replying to your story] how much?", [{ type: "story_reply", url: "s1" }], sense)).toBe(
      `[replying to your story] (your story: "a guy at a desk with two monitors") how much?`,
    );
    expect(await enrichText("[shared a post]", [{ type: "post", url: "p1", title: 'my "new" setup\n#editing' }], sense)).toBe(
      `[shared a post] (caption: "my 'new' setup #editing"; shows: "a guy at a desk with two monitors")`,
    );
    expect(await enrichText("[shared a reel]", [{ type: "reel", url: "reel.mp4", title: "WHOP guide" }], sense)).toBe(
      `[shared a reel] (caption: "WHOP guide"; content: "if i lost everything i'd start an editing agency")`,
    );
    // A reel link that's just a page still gets its caption.
    expect(await enrichText("[shared a reel]", [{ type: "reel", url: "page", title: "50% off" }], sense)).toBe(`[shared a reel] (caption: "50% off")`);
    expect(looked).toEqual(["story:s1", "post:p1", "post:reel.mp4", "post:page"]);
  });

  it("gives a voice note the webhook missed another go before the next draft", async () => {
    const env = await connected();
    await inbound(env, "[voice note]", Date.now(), "m1");
    await env.DB.prepare(`UPDATE messages SET attachments = ?1 WHERE mid = 'm1'`).bind(JSON.stringify([{ type: "audio", url: VOICE }])).run();
    // Instagram answers a request with no User-Agent with a web page instead of the file.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.headers as Record<string, string> | undefined)?.["User-Agent"]
          ? new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "video/mp4" } })
          : new Response("<html>", { headers: { "Content-Type": "text/html" } }),
      ),
    );
    aiRun.mockResolvedValue({ results: { channels: [{ alternatives: [{ transcript: "yo whats good, i edit for 3 clients" }] }] } });
    await enrichPending(env, LEAD, Date.now());
    expect((await db.history(env.DB, LEAD))[0].text).toBe('[voice note] "yo whats good, i edit for 3 clients"');
    expect(aiRun.mock.calls[0][0]).toBe("@cf/deepgram/nova-3");
    expect(aiRun.mock.calls[0][1]).toMatchObject({ audio: { contentType: "video/mp4" } });
  });

  it("transcribes voice notes and describes images with Claude vision via the webhook (Whisper when Nova-3 has nothing)", async () => {
    const env = await connected({ AUTOPILOT: "false" }); // media only; autopilot's fast path would wait out its real 5s burst
    const apiBodies: { messages: { content: { type: string; source?: { type: string; media_type: string; data: string } }[] }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === VOICE) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mp4" } });
        if (url === IMAGE) return new Response(new Uint8Array([4, 5, 6]), { headers: { "Content-Type": "image/png" } });
        if (url.includes("api.anthropic.com")) {
          const body = input instanceof Request ? await input.text() : String(init?.body);
          apiBodies.push(JSON.parse(body));
          return Response.json({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "A screenshot of an Instagram reel with 2M views." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        if (url.includes("fields=name,username")) return Response.json({ username: "lead.handle", name: "Sam Lee" });
        return Response.json({});
      }),
    );
    aiRun.mockResolvedValue({ text: " yo i run a med spa and want more clients " });
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: ME,
          messaging: [
            {
              sender: { id: LEAD },
              recipient: { id: ME },
              timestamp: Date.now(),
              message: { mid: "m1", text: "check this", attachments: [{ type: "audio", payload: { url: VOICE } }, { type: "image", payload: { url: IMAGE } }] },
            },
          ],
        },
      ],
    });
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const req = new Request("https://x/meta", { method: "POST", body, headers: { "X-Hub-Signature-256": `sha256=${await hmacHex("appsecret", body)}` } });
    await worker.fetch(req, env, ctx);
    await Promise.all(pending);

    expect(aiRun.mock.calls[0][0]).toBe("@cf/deepgram/nova-3");
    expect(aiRun).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", { audio: "AQID" });
    const image = apiBodies[0].messages[0].content[0];
    expect(image).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "BAUG" } });
    const [m] = await db.history(env.DB, LEAD);
    expect(m.text).toBe('[voice note] "yo i run a med spa and want more clients" [image] "A screenshot of an Instagram reel with 2M views." check this');
  });

  it("keeps the placeholder when the media can't be fetched or Whisper fails", async () => {
    const env = await connected();
    aiRun.mockRejectedValue(new Error("whisper down"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    expect(await describeImage("k", IMAGE)).toBeNull();
    const { enrichInbound } = await import("../src/fastpath");
    await inbound(env, "[voice note]", T0, "m1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
    await enrichInbound(env, { kind: "inbound", lead_id: LEAD, mid: "m1", text: "[voice note]", at: T0, attachments: [{ type: "audio", url: VOICE }], parts: [{ type: "audio", url: VOICE }], app_id: null });
    expect((await db.history(env.DB, LEAD))[0].text).toBe("[voice note]");
  });
});

describe("model refusals", () => {
  it("still hand off", async () => {
    const real = await vi.importActual<typeof import("../src/brain")>("../src/brain");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: "refusal",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      ),
    );
    const d = await real.decide("k", "Sam", [{ id: 1, subscriber_id: LEAD, role: "lead", text: "hey", created_at: 0, mid: null }]);
    expect(d.action).toBe("handoff");
  });
});

describe("AI on for one thread (master switch off)", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const toggle = (env: Env) =>
    worker.fetch(
      new Request(`https://x/admin/inbox/${LEAD}/ai`, { method: "POST", body: new URLSearchParams(), headers: { Authorization: `Basic ${btoa("j:pw")}` } }),
      env,
      ctx,
    );

  it("drafts and sends only on the thread the owner switched on", async () => {
    const env = await connected({ AUTOPILOT: "false" });
    await inbound(env, "how much is it", T0);
    await db.recordInbound(env.DB, { subscriber_id: "other", username: "o", first_name: "O", text: "yo", mid: undefined }, T0);
    await tick(env, T0 + MIN);
    expect(decide).not.toHaveBeenCalled();

    expect((await toggle(env)).status).toBe(303);
    expect((await lead(env)).ai_on).toBe(1);
    await tick(env, T0 + 2 * MIN);
    expect(decide).toHaveBeenCalledTimes(1);
    await tick(env, T0 + 2 * MIN + 10_000);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?"]);
    expect(sends.every((s) => s.to === LEAD)).toBe(true);
  });

  it("switching on when we spoke last nudges on the next tick; switching off drops what was queued", async () => {
    const env = await connected({ AUTOPILOT: "false" });
    await inbound(env, "sick thanks", T0);
    await handleEcho(env.DB, echo("did u check it out?", "mc-1", T0 + MIN, "manychat"));
    await toggle(env);
    expect((await lead(env)).followup_due_at).not.toBeNull();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["what u building rn?"], stage: "lead", note: "" });
    await tick(env, Date.now() + MIN);
    expect(vi.mocked(decide).mock.calls.at(-1)?.[3]).toBe(FOLLOW_UP_ASK);

    await toggle(env);
    expect((await lead(env)).ai_on).toBe(0);
    expect((await drafts(env)).filter((d) => d.status === "pending")).toHaveLength(0);
  });
});

describe("threads Manychat owns", () => {
  it("falls back to Manychat's send API when Instagram says we're not the thread owner, and stays on it", async () => {
    const env = await connected({ MANYCHAT_API_KEY: "mc" });
    const mc: { subscriber_id: number; texts: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/me/messages")) {
          return Response.json({ error: { message: "The action is invalid as it's not the thread owner.", code: 100, error_subcode: 2534037 } }, { status: 400 });
        }
        if (url.includes("/fb/subscriber/findByName")) {
          expect(new URL(url).searchParams.get("name")).toBe("Sam");
          // ig_id is a bare JSON number past 2^53, like the real API.
          return new Response(`{"status":"success","data":[{"id":"111","ig_id":12345},{"id":"547383862","ig_id":${LEAD}}]}`);
        }
        if (url.endsWith("/fb/sending/sendContent")) {
          const b = JSON.parse(String(init?.body)) as { subscriber_id: number; data: { content: { messages: { text: string }[] } } };
          mc.push({ subscriber_id: b.subscriber_id, texts: b.data.content.messages.map((m) => m.text) });
          return Response.json({ status: "success" });
        }
        return Response.json({});
      }),
    );
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(mc).toEqual([{ subscriber_id: 547383862, texts: ["yooo", "whats ur biz rn?"] }]);
    expect((await lead(env)).mc_id).toBe("547383862");
    expect((await drafts(env))[0].status).toBe("sent");
  });

  it("a bubble's echo that lands before our own insert is not recorded twice (Manychat sends carry no mid)", async () => {
    const env = await connected({ MANYCHAT_API_KEY: "mc" });
    await inbound(env, "hey", T0);
    await env.DB.prepare(`UPDATE leads SET mc_id = '547383862'`).run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // The first bubble's echo beats the insert that follows the send; the second's comes after it.
        if (url.endsWith("/fb/sending/sendContent")) await handleEcho(env.DB, echo("yooo", "mc-echo-1", T0 + 2 * MIN + 500));
        return Response.json({ status: "success" });
      }),
    );
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    await handleEcho(env.DB, echo("whats ur biz rn?", "mc-echo-2", T0 + 2 * MIN + 900));
    const { results } = await env.DB.prepare(`SELECT text, mid FROM messages WHERE role = 'bot' ORDER BY text`).all<{ text: string; mid: string }>();
    expect(results).toEqual([
      { text: "whats ur biz rn?", mid: "mc-echo-2" },
      { text: "yooo", mid: "mc-echo-1" },
    ]);
    expect((await lead(env)).status).toBe("active");
  });
});

describe("echo of our own send without its outbox row", () => {
  it("never pauses the thread", async () => {
    const env = await connected();
    await replied(env);
    await env.DB.prepare(`DELETE FROM outbox`).run();
    await env.DB.prepare(`DELETE FROM messages WHERE role = 'bot'`).run(); // the echo lands before our own insert
    await handleEcho(env.DB, echo("whats ur biz rn?", "late-echo", T0 + MIN + 2000));
    expect((await lead(env)).status).toBe("active");
  });
});

describe("inbox hover actions", () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const post = (env: Env, path: string, form: Record<string, string>) =>
    worker.fetch(
      new Request(`https://x/admin/inbox/${LEAD}/${path}`, { method: "POST", body: new URLSearchParams(form), headers: { Authorization: `Basic ${btoa("j:pw")}` } }),
      env,
      ctx,
    );

  it("react sends Instagram's react action and keeps it on the message; the same emoji again takes it off", async () => {
    const env = await connected({ AUTOPILOT: "false" });
    await inbound(env, "yo whats good", T0, "lead-mid-1");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (calls.push(JSON.parse(String(init?.body))), Response.json({}))));
    expect((await post(env, "react", { mid: "lead-mid-1", emoji: "❤️" })).status).toBe(303);
    expect(calls[0]).toEqual({ recipient: { id: LEAD }, sender_action: "react", payload: { message_id: "lead-mid-1", reaction: "❤️" } });
    const rx = async () => (await env.DB.prepare(`SELECT reactions FROM messages WHERE mid = 'lead-mid-1'`).first<{ reactions: string }>())!.reactions;
    expect(JSON.parse(await rx())).toEqual({ you: "❤️" });
    await post(env, "react", { mid: "lead-mid-1", emoji: "❤️" });
    expect(calls[1]).toEqual({ recipient: { id: LEAD }, sender_action: "unreact", payload: { message_id: "lead-mid-1" } });
    expect(JSON.parse(await rx())).toEqual({});
  });

  it("a hand reply can quote a message, and Shift+Enter line breaks stay in one message", async () => {
    const env = await connected({ AUTOPILOT: "false" });
    await inbound(env, "how much is it", T0, "lead-mid-2");
    const bodies: { reply_to?: { mid: string }; message?: { text: string } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), Response.json({ message_id: `o-${bodies.length}` }))),
    );
    await post(env, "reply", { bubbles: "its 75 a month\nlink in a sec", reply_to: "lead-mid-2" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ reply_to: { mid: "lead-mid-2" }, message: { text: "its 75 a month\nlink in a sec" } });
    // The sent bubble remembers what it quoted, so the Inbox draws the quote over it.
    expect(await env.DB.prepare(`SELECT reply_to FROM messages WHERE mid = 'o-1'`).first<{ reply_to: string }>()).toEqual({ reply_to: "lead-mid-2" });
  });
});

describe("human pacing", () => {
  it("autopilot marks seen, then shows typing before every bubble; hand replies just send", async () => {
    const env = await connected({ AUTOPILOT: "true", TYPING: "true" });
    const naps: number[] = [];
    const real = pace.sleep;
    pace.sleep = async (ms) => void naps.push(ms);
    const log: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as { sender_action?: string; message?: { text: string } };
        log.push(b.sender_action ?? `text:${b.message?.text}`);
        return Response.json({ message_id: `o-${log.length}` });
      }),
    );
    try {
      await inbound(env, "hey", T0);
      await tick(env, T0 + MIN);
      await tick(env, T0 + 2 * MIN);
      expect(log).toEqual(["mark_seen", "typing_on", "text:yooo", "typing_on", "text:whats ur biz rn?"]);
      expect(naps).toHaveLength(3); // the read pause + one typing pause per bubble
      expect(typingMs("yooo", 0.5)).toBe(1000);
      expect(typingMs("x".repeat(40), 0.5)).toBe(4800); // 100 words a minute
      expect(typingMs("x".repeat(500), 0.5)).toBe(20_000);
    } finally {
      pace.sleep = real;
    }
  });

  it("the fast path marks seen during the burst wait, types while the model writes, and counts that toward bubble 1", async () => {
    const jobs: SendJob[] = [];
    const env = await connected({ AUTOPILOT: "true", TYPING: "true", SEND_QUEUE: { send: async (j: SendJob) => void jobs.push(j) } as unknown as Queue<SendJob> });
    const log: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as { sender_action?: string; message?: { text: string } };
        log.push(b.sender_action ?? `text:${b.message?.text}`);
        return Response.json({ message_id: `o-${log.length}` });
      }),
    );
    vi.mocked(decide).mockImplementation(async () => {
      log.push("model");
      return { action: "reply", bubbles: ["yooo"], stage: "lead", note: "" };
    });
    const naps: number[] = [];
    await inbound(env, "hey", Date.now(), "m1");
    await replySoon(env, LEAD, "m1", async (ms) => void naps.push(ms));
    expect(log).toEqual(["mark_seen", "typing_on", "model"]);
    expect(naps[0]).toBeGreaterThanOrEqual(2000); // seen after 2-4s
    expect(naps[0] + naps[1]).toBe(5000); // the burst wait runs on underneath
    expect(naps[2]).toBeGreaterThanOrEqual(1000); // then a beat before typing
    expect(jobs).toHaveLength(1);
    expect(jobs[0].typing_at).toBeGreaterThan(0);

    const real = pace.sleep;
    const typed: number[] = [];
    pace.sleep = async (ms) => void typed.push(ms);
    try {
      await runSendJobs(env, [{ ...jobs[0], typing_at: Date.now() - 30_000 }]); // the model took longer than the typing
      expect(log.slice(3)).toEqual(["typing_on", "text:yooo"]); // no second "seen", no read pause
      expect(typed).toEqual([0]);
    } finally {
      pace.sleep = real;
    }
  });

  it("a message sent mid-reply stops the rest of the bubbles and gets its own answer", async () => {
    const env = await connected({ AUTOPILOT: "true", TYPING: "true" });
    vi.mocked(decide)
      .mockResolvedValueOnce({ action: "reply", bubbles: ["u drop in raw footage and claude cuts it", "works with premiere and capcut", "want the link?"], stage: "pitch", note: "" })
      .mockResolvedValueOnce({ action: "reply", bubbles: ["its 75 a month"], stage: "pitch", note: "" });
    const t = Date.now();
    await inbound(env, "oh word?", t, "m1");
    const real = pace.sleep;
    let naps = 0;
    pace.sleep = async () => {
      if (++naps === 2) await inbound(env, "idk how much is it?", t + 1000, "m2"); // while bubble 2 is typing
    };
    try {
      await replySoon(env, LEAD, "m1", async () => {});
      expect(sentTexts()).toEqual(["u drop in raw footage and claude cuts it"]);
      const [first] = await drafts(env);
      expect(first.status).toBe("sent");
      expect(JSON.parse(first.bubbles)).toEqual(["u drop in raw footage and claude cuts it"]);
      await replySoon(env, LEAD, "m2", async () => {});
      expect(sentTexts()).toEqual(["u drop in raw footage and claude cuts it", "its 75 a month"]);
    } finally {
      pace.sleep = real;
    }
  });

  it("a closer after the convo wrapped gets a heart on their message and no words", async () => {
    const env = await connected({ AUTOPILOT: "true" });
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), Response.json({ message_id: "x" }))));
    vi.mocked(decide).mockResolvedValue({ action: "react", bubbles: [], stage: "closed", note: "wrapped, they said thanks" });
    await inbound(env, "I appreciate it", Date.now(), "m-thanks");
    await replySoon(env, LEAD, "m-thanks", async () => {});
    expect(bodies).toEqual([{ recipient: { id: LEAD }, sender_action: "react", payload: { message_id: "m-thanks", reaction: "❤️" } }]);
    expect((await drafts(env))[0]).toMatchObject({ action: "react", status: "sent" });
    expect((await env.DB.prepare(`SELECT reactions FROM messages WHERE mid = 'm-thanks'`).first<{ reactions: string }>())?.reactions).toBe('{"you":"❤️"}');
    expect((await db.getLead(env.DB, LEAD))?.status).toBe("done");
  });

  it("friends & family get nothing from the fast path, not even a seen receipt", async () => {
    const env = await connected({ AUTOPILOT: "true", TYPING: "true" });
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (log.push(String(init?.body)), Response.json({}))));
    await inbound(env, "yo bro", Date.now(), "m1");
    await env.DB.prepare(`INSERT INTO lead_tags (subscriber_id, tag, created_at) VALUES (?1, 'friend', 1)`).bind(LEAD).run();
    await replySoon(env, LEAD, "m1", async () => {});
    expect(log).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });

  it("the fast path takes the typing dots down when the model has nothing to send", async () => {
    const env = await connected({ AUTOPILOT: "true", TYPING: "true" });
    const log: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (log.push(JSON.parse(String(init?.body)).sender_action), Response.json({}))));
    vi.mocked(decide).mockResolvedValue({ action: "handoff", bubbles: [], stage: "lead", note: "refund" });
    await inbound(env, "i want a refund", Date.now(), "m1");
    await replySoon(env, LEAD, "m1", async () => {});
    expect(log).toEqual(["mark_seen", "typing_on", "typing_off"]);
  });

  it("a batch of send jobs types and sends for different leads at the same time", async () => {
    const jobs: SendJob[] = [];
    const env = await connected({ AUTOPILOT: "true", TYPING: "true", SEND_QUEUE: { send: async (j: SendJob) => void jobs.push(j) } as unknown as Queue<SendJob> });
    await inbound(env, "hey", T0);
    await db.recordInbound(env.DB, { subscriber_id: "other", username: "o", first_name: "Ola", text: "yo", mid: "o1" }, T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + MIN + 10_000);
    expect(jobs).toHaveLength(2);
    const real = pace.sleep;
    let typing = 0;
    let most = 0;
    pace.sleep = async () => {
      most = Math.max(most, ++typing);
      await new Promise((r) => setTimeout(r, 5));
      typing--;
    };
    try {
      await runSendJobs(env, jobs);
    } finally {
      pace.sleep = real;
    }
    expect(most).toBe(2);
    expect(sends.filter((x) => x.to === "other")).toHaveLength(2);
  });

  it("fresh due drafts go to the send queue; the job sends once and a duplicate job does nothing", async () => {
    const jobs: SendJob[] = [];
    const env = await connected({ AUTOPILOT: "true", SEND_QUEUE: { send: async (j: SendJob) => void jobs.push(j) } as unknown as Queue<SendJob> });
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + MIN + 10_000);
    expect(sentTexts()).toEqual([]);
    expect(jobs).toHaveLength(1);
    await runSendJobs(env, [jobs[0], jobs[0]]);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?"]);
  });
});

describe("a send that dies mid-reply", () => {
  // @ig_kofi.0, 2026-10-30: bubble 1 went out, the job died before bubble 2, and the draft sat in 'sending' for hours.
  it("keeps what went out after 10 min, books the nudge, and never resends", async () => {
    const env = await connected();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["life insurance is perfect for this", "hows that going for u so far?"], stage: "lead", note: "" });
    await inbound(env, "Life insurance", T0);
    await tick(env, T0 + MIN);
    onSend = async (text, mid) => {
      if (text.startsWith("hows")) return new Promise(() => {}); // the job never comes back
      await handleEcho(env.DB, echo(text, mid, T0 + MIN));
    };
    void sendDraft(env, (await drafts(env))[0], T0 + MIN);
    await vi.waitFor(() => expect(sentTexts()).toEqual(["life insurance is perfect for this"]));
    onSend = null;

    await tick(env, T0 + 5 * MIN); // could still be typing
    expect((await drafts(env))[0].status).toBe("sending");
    await tick(env, T0 + 12 * MIN);
    const [d] = await drafts(env);
    expect(d.status).toBe("sent");
    expect(JSON.parse(d.bubbles)).toEqual(["life insurance is perfect for this"]);
    expect(await drafts(env)).toHaveLength(1);
    expect(sentTexts()).toEqual(["life insurance is perfect for this"]);
    const due = (await lead(env)).followup_due_at!;
    expect(due).toBe(T0 + 12 * MIN + 3 * HOUR);
    await tick(env, due);
    expect((await drafts(env))[1].action).toBe("follow_up");
  });

  it("nothing went out: the lead's message gets a fresh reply", async () => {
    const env = await connected();
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    let hung = false;
    onSend = () => ((hung = true), new Promise(() => {}));
    void sendDraft(env, (await drafts(env))[0], T0 + MIN);
    await vi.waitFor(() => expect(hung).toBe(true));
    onSend = null;

    await tick(env, T0 + 12 * MIN);
    const [dead, fresh] = await drafts(env);
    expect(dead.status).toBe("superseded");
    expect(fresh).toMatchObject({ action: "reply", status: "pending" });
    await tick(env, T0 + 13 * MIN);
    expect(sentTexts()).toEqual(["yooo", "whats ur biz rn?"]);
  });
});

describe("long threads", () => {
  it("the model reads the whole conversation, not just the last 40 messages", async () => {
    const env = await connected();
    await inbound(env, "my bottleneck is lead generation", T0 - 60 * MIN);
    for (let i = 0; i < 90; i++) {
      await env.DB.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES (?1, ?2, ?3, ?4)`)
        .bind(LEAD, i % 2 ? "lead" : "bot", `msg ${i}`, T0 - 50 * MIN + i * 1000)
        .run();
    }
    await inbound(env, "is there times for group calls", T0);
    await tick(env, T0 + MIN);
    const seen = vi.mocked(decide).mock.calls[0][2].map((m) => m.text);
    expect(seen[0]).toBe("my bottleneck is lead generation");
    expect(seen).toHaveLength(92);
  });
});

describe("lead magnet that didn't come through", () => {
  it("the setter knows which guide they asked for, and {{GUIDE_LINK}} sends that automation's links", async () => {
    const env = await connected();
    const guide = "https://creator-economy.notion.site/DFY-Guide-123";
    await env.DB.prepare(`INSERT INTO triggers (id, keyword, dm, created_at, name) VALUES (8, 'WHOP', '', 0, 'WHOP: DFY AI automation guide')`).run();
    await env.DB.prepare(`INSERT INTO flow_nodes (trigger_id, id, kind, data) VALUES (8, 'm1', 'message', ?1), (8, 'm2', 'message', ?2)`)
      .bind(
        JSON.stringify({ bubbles: [{ text: "tap below ⤵️", buttons: [{ id: "send", title: "Send the Link!" }] }] }),
        JSON.stringify({ bubbles: [{ text: `here's the guide 🎁\n${guide}`, buttons: [{ id: "b", title: "Whop", url: "https://whop.com/start/?code=OWNER" }] }] }),
      )
      .run();
    await env.DB.prepare(`INSERT INTO flow_starts (trigger_id, subscriber_id, status, created_at) VALUES (8, ?1, 'sent', ?2)`).bind(LEAD, T0 - MIN).run();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["all good heres the guide", "{{GUIDE_LINK}}"], stage: "lead", note: "" });
    await inbound(env, "bro i am on pc", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(vi.mocked(decide).mock.calls[0][5]).toBe("WHOP: DFY AI automation guide");
    expect(sentTexts()).toEqual(["all good heres the guide", `${guide}\nhttps://whop.com/start/?code=OWNER`]);
  });

  it("a cold DM asking for a live lead magnet: the setter sees the catalog and {{GUIDE_LINK:<id>}} sends it", async () => {
    const env = await connected();
    const repo = "https://github.com/owner/receptionist";
    await env.DB.prepare(
      `INSERT INTO triggers (id, keyword, dm, created_at, name, enabled, deleted_at) VALUES
         (3, 'AGENT', '', 0, 'AGENT: AI receptionist build', 1, NULL), (5, 'OLD', '', 0, 'OLD: switched off', 0, NULL), (6, 'GONE', '', 0, 'GONE: in trash', 1, 1)`,
    ).run();
    const msg = JSON.stringify({ bubbles: [{ text: `here u go\n${repo}`, buttons: [{ id: "l", title: "Loom", url: "https://loom.com/share/abc" }] }] });
    await env.DB.prepare(`INSERT INTO flow_nodes (trigger_id, id, kind, data) VALUES (3, 'm1', 'message', ?1), (5, 'm1', 'message', ?1), (6, 'm1', 'message', ?1)`).bind(msg).run();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["gotchu heres the receptionist build", "{{GUIDE_LINK:3}}", "what kinda biz u tryna set it up for?"], stage: "opener", note: "" });
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('community_facts', '# Live community facts')`).run();
    await inbound(env, "Hey wanna send me over that voice agent", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(vi.mocked(decide).mock.calls[0][5]).toBeNull();
    expect(vi.mocked(decide).mock.calls[0][7]).toBe("# Live community facts");
    expect(vi.mocked(decide).mock.calls[0][6]).toEqual([{ id: 3, name: "AGENT: AI receptionist build", urls: [repo, "https://loom.com/share/abc"] }]);
    expect(sentTexts()).toEqual(["gotchu heres the receptionist build", `${repo}\nhttps://loom.com/share/abc`, "what kinda biz u tryna set it up for?"]);
  });

  it("no automation behind them: no Lead magnet line, and a stray {{GUIDE_LINK}} bubble is dropped", async () => {
    const env = await connected();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yo", "{{GUIDE_LINK}}"], stage: "lead", note: "" });
    await inbound(env, "hey", T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(vi.mocked(decide).mock.calls[0][5]).toBeNull();
    expect(sentTexts()).toEqual(["yo"]);
  });
});
