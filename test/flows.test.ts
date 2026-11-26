import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";

vi.mock("../src/brain", async (orig) => ({ ...(await orig<typeof import("../src/brain")>()), decide: vi.fn() }));

import { decide } from "../src/brain";
import * as db from "../src/db";
import { buildMessage, flowTypingMs, ORIGIN, runDueFlows } from "../src/flows";
import worker from "../src/index";
import { hmacHex } from "../src/meta";
import { pace, tick, type Env } from "../src/setter";

const ME = "17840000000000001";
const LEAD = "990011";
const MIN = 60_000;
const LINK = "https://www.skool.com/your-community/about";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(): Env {
  return {
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    AI: {} as Ai,
    SKOOL_LINK: LINK,
    AUTOPILOT: "true", // the AI is on (autopilot) or off; off drafts nothing
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
  };
}

let at = Date.now();
const messaging = (ev: Record<string, unknown>, from = LEAD) => ({
  object: "instagram",
  entry: [{ id: ME, time: 1, messaging: [{ sender: { id: from }, recipient: { id: ME }, timestamp: ++at, ...ev }] }],
});
const dm = (mid: string, message: Record<string, unknown>, from = LEAD) => messaging({ message: { mid, ...message } }, from);
const tap = (title: string, payload: string, from = LEAD) => messaging({ postback: { mid: `pbm-${at}`, title, payload } }, from);
const echo = (mid: string, message: Record<string, unknown>) => ({
  object: "instagram",
  entry: [{ id: ME, time: 1, messaging: [{ sender: { id: ME }, recipient: { id: LEAD }, timestamp: ++at, message: { mid, is_echo: true, ...message } }] }],
});
const comment = (text: string, id = "c1") => ({
  object: "instagram",
  entry: [{ id: ME, time: Math.floor(Date.now()/1000), changes: [{ field: "comments", value: { id, text, from: { id: LEAD, username: "lead.handle" }, media: { id: "reel1" } } }] }],
});

async function post(env: Env, payload: unknown) {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request("https://x/meta", { method: "POST", body, headers: { "X-Hub-Signature-256": `sha256=${await hmacHex("appsecret", body)}` } }), env, ctx);
}

const admin = (path: string, form?: Record<string, string | string[]>, pw = "pw") => {
  let body: URLSearchParams | undefined;
  if (form) {
    body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [v].flat()) body.append(k, x);
  }
  return new Request(`https://x${path}`, { method: form ? "POST" : "GET", body, headers: { Authorization: `Basic ${btoa(`owner:${pw}`)}` } });
};

interface Auto {
  source?: string;
  keyword?: string;
  name?: string | null;
  dm?: string;
  button_title?: string | null;
  button_url?: string | null;
  next_title?: string | null;
  quick_replies?: string | null;
  media_id?: string | null;
}
async function addAuto(env: Env, a: Auto): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO triggers (source, keyword, name, dm, button_title, button_url, next_title, quick_replies, media_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0) RETURNING id`,
  )
    .bind(a.source ?? "dm", a.keyword ?? "*", a.name ?? null, a.dm ?? "here u go", a.button_title ?? null, a.button_url ?? null, a.next_title ?? null, a.quick_replies ?? null, a.media_id ?? null)
    .first<{ id: number }>();
  return row!.id;
}
async function addStep(env: Env, trigger: number, position: number, s: { kind?: string; text?: string; button_title?: string; button_url?: string; next_title?: string; delay_s?: number }) {
  await env.DB.prepare(`INSERT INTO flow_steps (trigger_id, position, kind, text, button_title, button_url, next_title, delay_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(trigger, position, s.kind ?? "message", s.text ?? null, s.button_title ?? null, s.button_url ?? null, s.next_title ?? null, s.delay_s ?? null)
    .run();
}

let calls: { url: string; method: string; body: any }[] = [];
let refuseTemplatesToComments = false;
let nextMid = 0;
beforeEach(() => {
  calls = [];
  refuseTemplatesToComments = false;
  nextMid = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/me/messages")) {
        if (refuseTemplatesToComments && body.recipient.comment_id && body.message.attachment) {
          return Response.json({ error: { message: "Unsupported message type", code: 100 } }, { status: 400 });
        }
        return Response.json({ recipient_id: LEAD, message_id: `out-${++nextMid}` });
      }
      if (url.includes("fields=name,username")) return Response.json({ username: "lead.handle", name: "Sam Lee" });
      if (url.includes("/me/media")) return Response.json({ data: [] });
      return Response.json({ success: true });
    }),
  );
  vi.mocked(decide).mockReset().mockResolvedValue({ action: "reply", bubbles: ["yo"], stage: "lead", note: "" });
});
afterEach(() => vi.unstubAllGlobals());

const sends = () => calls.filter((c) => c.url.endsWith("/me/messages"));
const sent = () => sends().map((c) => c.body.message);
const thread = async (env: Env) => (await db.history(env.DB, LEAD)).map((m) => [m.role, m.text]);
async function connected() {
  const env = makeEnv();
  await db.setSetting(env.DB, "ig_token", "tok");
  return env;
}

describe("buildMessage", () => {
  const text = "get it {{SKOOL_LINK}}";
  it("plain text, quick replies, and button templates capped at 3 buttons", () => {
    expect(buildMessage({ text, buttons: [] }, [], 7, LINK).message).toEqual({ text: `get it ${LINK}` });
    const qr = buildMessage({ text, buttons: [] }, [{ id: "q0", title: "Yes please" }, { id: "q1", title: "No" }], 7, LINK);
    expect(qr.message).toEqual({
      text: `get it ${LINK}`,
      quick_replies: [
        { content_type: "text", title: "Yes please", payload: "q:7:q0" },
        { content_type: "text", title: "No", payload: "q:7:q1" },
      ],
    });
    expect(qr.text).toBe(`get it ${LINK}\n[buttons: Yes please | No]`);
    const tpl = buildMessage(
      { text, buttons: [{ id: "join", title: "Join", url: "{{SKOOL_LINK}}" }, { id: "more", title: "More" }] },
      [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      9,
      LINK,
    );
    expect(tpl.message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: `get it ${LINK}`,
          buttons: [
            { type: "web_url", url: `${ORIGIN}/f/9/join`, title: "Join" },
            { type: "postback", title: "More", payload: "b:9:more" },
            { type: "postback", title: "A", payload: "q:9:a" },
          ],
        },
      },
    });
    expect(tpl.urls).toEqual({ join: LINK });
  });
});

describe("DM keyword automations", () => {
  it("answer instantly, once per person, and the AI only takes the next message", async () => {
    const env = await connected();
    await addAuto(env, { keyword: "guide, ai", dm: "here's the guide {{SKOOL_LINK}}", quick_replies: "Thanks!" });
    await post(env, dm("m1", { text: "can I get the GUIDE pls" }));
    await post(env, dm("m1", { text: "can I get the GUIDE pls" })); // webhook retry
    expect(sent()).toEqual([{ text: `here's the guide ${LINK}`, quick_replies: [{ content_type: "text", title: "Thanks!", payload: "q:1:q0" }] }]);
    expect(sends()[0].body.recipient).toEqual({ id: LEAD });
    // Meta echoes our send back; it's not a second message.
    await post(env, echo("out-1", { text: `here's the guide ${LINK}` }));
    expect(await thread(env)).toEqual([
      ["lead", "can I get the GUIDE pls"],
      ["bot", `here's the guide ${LINK}\n[buttons: Thanks!]`],
    ]);
    // The flow answered, so the AI has nothing to draft.
    await tick(env, Date.now() + MIN);
    expect(decide).not.toHaveBeenCalled();

    // Same keyword again: no second send, it's the AI's turn, and the AI sees the whole thread.
    await post(env, dm("m2", { text: "guide didnt load, send the guide again?" }));
    expect(sends()).toHaveLength(1);
    await tick(env, Date.now() + 2 * MIN);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decide).mock.calls[0][2].map((m) => m.text)).toEqual([
      "can I get the GUIDE pls",
      `here's the guide ${LINK}\n[buttons: Thanks!]`,
      "guide didnt load, send the guide again?",
    ]);
  });

  it("a quick reply with no target is just a message for the AI; one with a target runs that automation", async () => {
    const env = await connected();
    const bonus = await addAuto(env, { source: "none", name: "bonus", dm: "bonus vid: {{SKOOL_LINK}}" });
    await addAuto(env, { keyword: "start", dm: "want the bonus?", quick_replies: "Yes > bonus\nNah" });
    await post(env, dm("m1", { text: "start" }));
    await post(env, dm("m2", { text: "Nah", quick_reply: { payload: "q:1:0" } }));
    expect(sends()).toHaveLength(1);
    await post(env, dm("m3", { text: "Yes", quick_reply: { payload: `q:1:${bonus}` } }));
    expect(sent()[1]).toEqual({ text: `bonus vid: ${LINK}` });
    const s = await env.DB.prepare(`SELECT tapped_at FROM flow_sends WHERE id = 1`).first<{ tapped_at: number | null }>();
    expect(s?.tapped_at).not.toBeNull();
  });

  it("story replies match the reply text (not the prefix), fall back to DM keywords; mentions get the mention reply", async () => {
    const env = await connected();
    await addAuto(env, { source: "story", keyword: "story", dm: "story auto" });
    await addAuto(env, { source: "dm", keyword: "fire", dm: "dm auto" });
    await addAuto(env, { source: "mention", dm: "thanks for the shoutout!" });
    await post(env, dm("m1", { text: "this is fire", reply_to: { story: { id: "s1", url: "u" } } }));
    expect(sent()).toEqual([{ text: "dm auto" }]);
    await post(env, dm("m2", { attachments: [{ type: "story_mention", payload: { url: "u" } }] }));
    expect(sent()[1]).toEqual({ text: "thanks for the shoutout!" });
    await post(env, dm("m3", { text: "love this story", reply_to: { story: { id: "s2", url: "u" } } }));
    expect(sent()[2]).toEqual({ text: "story auto" });
    expect((await db.history(env.DB, LEAD)).find((m) => m.mid === "m1")?.text).toBe("[replying to your story] this is fire");
  });

  it("a story automation pinned to one story answers only replies to that story, ahead of any-story ones", async () => {
    const env = await connected();
    await addAuto(env, { source: "story", keyword: "*", dm: "any story" });
    await addAuto(env, { source: "story", keyword: "*", media_id: "s1", dm: "the austin one" });
    await post(env, dm("m1", { text: "yo", reply_to: { story: { id: "s1", url: "u" } } }));
    expect(sent()).toEqual([{ text: "the austin one" }]);
    await post(env, dm("m2", { text: "yo", reply_to: { story: { id: "s2", url: "u" } } }, "999"));
    expect(sent()[1]).toEqual({ text: "any story" });
    await post(env, dm("m3", { text: "yo" }, "998"));
    expect(sends()).toHaveLength(2);
  });

  it("the welcome message goes to brand-new conversations only, and a keyword beats it", async () => {
    const env = await connected();
    await addAuto(env, { source: "welcome", dm: "welcome in! what are u building?" });
    await addAuto(env, { keyword: "guide", dm: "guide" });
    await post(env, dm("m1", { text: "hey" }));
    await post(env, dm("m2", { text: "hey again" }));
    expect(sent()).toEqual([{ text: "welcome in! what are u building?" }]);
    await post(env, dm("n1", { text: "guide" }, "777"));
    expect(sent()[1]).toEqual({ text: "guide" });
    expect(sends()).toHaveLength(2);
  });

  it("a follower welcomed by Manychat's Follow to DM isn't new: no second welcome, the setter answers their reply", async () => {
    const env = await connected();
    await addAuto(env, { source: "welcome", dm: "welcome in!" });
    await post(env, echo("mc-1", { text: "thanks for the follow! want my free AI guide?", app_id: 1234 })); // sent by Manychat's app, so not a manual reply
    await post(env, dm("m1", { text: "yes pls" }));
    expect(sends()).toHaveLength(0);
    await tick(env, Date.now() + MIN);
    expect(vi.mocked(decide).mock.calls[0][2].map((m) => [m.role, m.text])).toEqual([
      ["bot", "thanks for the follow! want my free AI guide?"],
      ["lead", "yes pls"],
    ]);
  });

  it("paused automations and a missing Instagram connection send nothing", async () => {
    const env = makeEnv();
    const id = await addAuto(env, { keyword: "guide" });
    await post(env, dm("m1", { text: "guide" }));
    await env.DB.prepare(`UPDATE triggers SET enabled = 0 WHERE id = ?1`).bind(id).run();
    await db.setSetting(env.DB, "ig_token", "tok");
    await post(env, dm("m2", { text: "guide" }));
    expect(sends()).toHaveLength(0);
    expect(await thread(env)).toHaveLength(2);
  });
});

describe("multi-step flows", () => {
  async function promo(env: Env) {
    const id = await addAuto(env, { keyword: "whop", dm: "tap below for the guide", next_title: "Send the Link!" });
    await addStep(env, id, 0, { text: "here it is", button_title: "Guide", button_url: "https://notion.so/guide" });
    await addStep(env, id, 1, { kind: "delay", delay_s: 3600 });
    await addStep(env, id, 2, { text: "did u check out the guide?" });
    return id;
  }

  it("a few-second delay pauses quietly, then types the next message (fast, by length), without waiting on the cron", async () => {
    const env = await connected();
    const slept: number[] = [];
    const nap = vi.spyOn(pace, "sleep").mockImplementation(async (ms) => void slept.push(ms));
    const id = await addAuto(env, { keyword: "whop", dm: "tap below for the guide", next_title: "Send the Link!" });
    await addStep(env, id, 0, { text: "here it is" });
    await addStep(env, id, 1, { kind: "delay", delay_s: 5 });
    await addStep(env, id, 2, { text: "what kinda business u running?" });
    await post(env, dm("m1", { text: "whop" }));
    await post(env, tap("Send the Link!", "b:1:nx"));
    expect(sent().filter(Boolean).map((m) => m.text)).toEqual([undefined, "here it is", "what kinda business u running?"]);
    const typing = calls.findIndex((c) => c.body?.sender_action === "typing_on");
    expect(typing).toBeGreaterThan(calls.findIndex((c) => c.body?.message?.text === "here it is"));
    expect(typing).toBeLessThan(calls.findIndex((c) => c.body?.message?.text === "what kinda business u running?"));
    expect(calls.filter((c) => c.body?.sender_action === "typing_on")).toHaveLength(1); // the links weren't "typed"
    expect(slept[0]).toBe(5000);
    expect(slept[1]).toBeGreaterThanOrEqual(700 * 0.85); // a 30-character line sits at the 0.7s floor
    expect(slept[1]).toBeLessThanOrEqual(700 * 1.15);
    expect(await env.DB.prepare(`SELECT COUNT(*) n FROM flow_runs`).first<{ n: number }>()).toEqual({ n: 0 });
    nap.mockRestore();
  });

  it("after a pause, every later message in the walk shows typing dots, in step with its length and inside the walk's time", async () => {
    expect(flowTypingMs("yo", 0.5)).toBe(700);
    expect(flowTypingMs("x".repeat(100), 0.5)).toBe(1800);
    expect(flowTypingMs("x".repeat(900), 0.5)).toBe(2500);
    const env = await connected();
    const slept: number[] = [];
    const nap = vi.spyOn(pace, "sleep").mockImplementation(async (ms) => void slept.push(ms));
    const id = await addAuto(env, { source: "dm", keyword: "deal", dm: "hey" });
    await addStep(env, id, 0, { kind: "delay", delay_s: 1 });
    await addStep(env, id, 1, { text: "one" });
    await addStep(env, id, 2, { text: "x".repeat(100) });
    await addStep(env, id, 3, { kind: "delay", delay_s: 3 });
    await addStep(env, id, 4, { text: "three" });
    await post(env, dm("m1", { text: "deal" }));
    const texts = sent().filter(Boolean).map((m) => m.text);
    expect(texts).toEqual(["hey", "one", "x".repeat(100), "three"]);
    // "hey" went out before any pause, so it is pasted; the three after the first pause are each typed
    expect(calls.filter((c) => c.body?.sender_action === "typing_on")).toHaveLength(3);
    expect(calls.findIndex((c) => c.body?.sender_action === "typing_on")).toBeGreaterThan(calls.findIndex((c) => c.body?.message?.text === "hey"));
    expect(slept[0]).toBe(1000);
    expect(slept[2]).toBeGreaterThan(slept[1]); // the 100-character message takes longer than "one"
    expect(slept[3]).toBe(3000);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThan(20_000);
    nap.mockRestore();
  });

  it("waits for the continue tap, sends the next step, waits out the smart delay, then follows up", async () => {
    const env = await connected();
    await promo(env);
    await post(env, dm("m1", { text: "whop" }));
    expect(sent()).toEqual([
      { attachment: { type: "template", payload: { template_type: "button", text: "tap below for the guide", buttons: [{ type: "postback", title: "Send the Link!", payload: "b:1:nx" }] } } },
    ]);
    // The template's echo has no text; our row keeps its text.
    await post(env, echo("out-1", { attachments: [{ type: "template" }] }));

    await post(env, tap("Send the Link!", "b:1:nx"));
    expect(sent()[1]).toEqual({
      attachment: { type: "template", payload: { template_type: "button", text: "here it is", buttons: [{ type: "web_url", url: `${ORIGIN}/f/2/url`, title: "Guide" }] } },
    });
    expect(sends()).toHaveLength(2); // the delay holds the follow-up
    await post(env, tap("Send the Link!", "b:1:nx")); // tapped again: the flow doesn't repeat
    expect(sends()).toHaveLength(2);

    const click = await worker.fetch(new Request(`${ORIGIN}/f/2/url`), env, ctx);
    expect(click.status).toBe(302);
    expect(click.headers.get("Location")).toBe("https://notion.so/guide");

    const run = (await env.DB.prepare(`SELECT * FROM flow_runs`).first<{ run_at: number }>())!;
    await runDueFlows(env, run.run_at - 1000);
    expect(sends()).toHaveLength(2);
    // The second tap was a lead message after the run was scheduled, so the chat moved on: cancelled.
    await runDueFlows(env, run.run_at);
    expect(sends()).toHaveLength(2);
    expect((await env.DB.prepare(`SELECT status FROM flow_runs`).first<{ status: string }>())?.status).toBe("cancelled");

    expect(await thread(env)).toEqual([
      ["lead", "whop"],
      ["bot", "tap below for the guide\n[buttons: Send the Link!]"],
      ["lead", "[tapped] Send the Link!"],
      ["bot", "here it is\n[buttons: Guide (https://notion.so/guide)]"],
      ["lead", "[tapped] Send the Link!"],
    ]);
    const stats = await env.DB.prepare(`SELECT id, clicked_at, tapped_at FROM flow_sends ORDER BY id`).all<{ clicked_at: number | null; tapped_at: number | null }>();
    expect(stats.results.map((s) => [Boolean(s.clicked_at), Boolean(s.tapped_at)])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it("the follow-up sends on time when they stay quiet, and never outside the 24h window", async () => {
    const env = await connected();
    await promo(env);
    await post(env, dm("m1", { text: "whop" }));
    await post(env, tap("Send the Link!", "b:1:nx"));
    const run = (await env.DB.prepare(`SELECT * FROM flow_runs`).first<{ run_at: number }>())!;
    await runDueFlows(env, run.run_at);
    await runDueFlows(env, run.run_at); // claimed once
    expect(sent()[2]).toEqual({ text: "did u check out the guide?" });
    expect(sends()).toHaveLength(3);

    const env2 = await connected();
    await promo(env2);
    await post(env2, dm("m1", { text: "whop" }));
    await post(env2, tap("Send the Link!", "n:1")); // what the old builder sent still works
    await env2.DB.prepare(`UPDATE flow_runs SET run_at = 0`).run();
    await env2.DB.prepare(`UPDATE leads SET last_inbound_at = ?1`).bind(Date.now() - 25 * 60 * MIN).run();
    const before = sends().length;
    await runDueFlows(env2, Date.now());
    expect(sends()).toHaveLength(before);
  });

  it("a comment's private reply carries the button; the tap opens the window for the rest", async () => {
    const env = await connected();
    const id = await addAuto(env, { source: "comment", keyword: "whop", dm: "tap for the guide", next_title: "Send it" });
    await addStep(env, id, 0, { text: "here: {{SKOOL_LINK}}" });
    await post(env, comment("WHOP"));
    expect(sends()[0].body.recipient).toEqual({ comment_id: "c1" });
    expect(sent()[0].attachment.payload.buttons).toEqual([{ type: "postback", title: "Send it", payload: "b:1:nx" }]);
    await post(env, tap("Send it", "b:1:nx"));
    expect(sent()[1]).toEqual({ text: `here: ${LINK}` });
    expect(await thread(env)).toEqual([
      ["lead", "[commented on your post] WHOP"],
      ["bot", "tap for the guide\n[buttons: Send it]"],
      ["lead", "[tapped] Send it"],
      ["bot", `here: ${LINK}`],
    ]);
  });

  it("if Instagram refuses a template as a private reply, the comment still gets the text with the link", async () => {
    const env = await connected();
    refuseTemplatesToComments = true;
    await addAuto(env, { source: "comment", keyword: "whop", dm: "the guide:", button_title: "Open", button_url: "https://notion.so/g" });
    await post(env, comment("whop"));
    expect(sent()[1]).toEqual({ text: "the guide:\nhttps://notion.so/g" });
    expect((await env.DB.prepare(`SELECT status FROM comments`).first<{ status: string }>())?.status).toBe("sent");
    expect(await thread(env)).toContainEqual(["bot", "the guide:\nhttps://notion.so/g"]);
  });
});

describe("ice breakers and main menu", () => {
  it("saves to Instagram with automation payloads, subscribes postbacks, and taps run the automation or reach the AI", async () => {
    const env = await connected();
    const join = await addAuto(env, { source: "none", name: "join", dm: "here's the link {{SKOOL_LINK}}" });
    const res = await worker.fetch(admin("/admin/flows/icebreakers", { lines: "How do I join? > join\nWhat do you teach?" }), env, ctx);
    expect(res.status).toBe(303);
    const profile = calls.find((c) => c.url.endsWith("/me/messenger_profile"))!;
    expect(profile.method).toBe("POST");
    expect(profile.body).toEqual({
      platform: "instagram",
      ice_breakers: [{ call_to_actions: [{ question: "How do I join?", payload: `go:${join}` }, { question: "What do you teach?", payload: "ice" }] }],
    });
    expect(calls.some((c) => c.url.includes("subscribed_fields=messages%2Cmessaging_postbacks"))).toBe(true);

    await post(env, tap("How do I join?", `go:${join}`));
    expect(sent()).toEqual([{ text: `here's the link ${LINK}` }]);
    await post(env, tap("What do you teach?", "ice", "888"));
    expect(sends()).toHaveLength(1);
    expect((await db.history(env.DB, "888")).map((m) => m.text)).toEqual(["[tapped] What do you teach?"]);
    expect((await db.getLead(env.DB, "888"))?.username).toBe("lead.handle");

    await worker.fetch(admin("/admin/flows/menu", { lines: "Join | {{SKOOL_LINK}}\nFree guide > join\nAsk me" }), env, ctx);
    expect(calls.filter((c) => c.url.endsWith("/me/messenger_profile")).at(-1)!.body).toEqual({
      platform: "instagram",
      persistent_menu: [
        {
          locale: "default",
          call_to_actions: [
            { type: "web_url", title: "Join", url: LINK },
            { type: "postback", title: "Free guide", payload: `go:${join}` },
            { type: "postback", title: "Ask me", payload: "menu" },
          ],
        },
      ],
    });
    expect(await (await worker.fetch(admin("/admin/automations?tab=basic"), env, ctx)).text()).toContain("Join · Free guide · Ask me");

    await worker.fetch(admin("/admin/flows/icebreakers", { lines: "" }), env, ctx);
    expect(calls.filter((c) => c.url.endsWith("/me/messenger_profile")).at(-1)).toMatchObject({ method: "DELETE", body: { fields: ["ice_breakers"] } });
  });
});
