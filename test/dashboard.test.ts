import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";

vi.mock("../src/brain", async (orig) => ({ ...(await orig<typeof import("../src/brain")>()), decide: vi.fn() }));

import { decide } from "../src/brain";
import { funnel, windowLeft } from "../src/dashboard";
import * as db from "../src/db";
import worker from "../src/index";
import { BASE_URL } from "../src/links";
import { getConfig, withSettings } from "../src/settings";
import { tick, type Env } from "../src/setter";
import { meter } from "../src/usage";

const MIN = 60_000;
const HOUR = 60 * MIN;
const LINK = "https://www.skool.com/your-community/about";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "mc",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    AI: {} as Ai,
    SKOOL_LINK: LINK,
    AUTOPILOT: "true", // the AI is on (autopilot) or off; off drafts nothing
    REPLY_DELAY_MIN_S: "60",
    REPLY_DELAY_MAX_S: "240",
    TRANSPORT: "manychat",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
    ...over,
  };
}

const as = (pw: string, path: string, init: RequestInit = {}) =>
  new Request(`https://x${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Basic ${btoa(`owner:${pw}`)}` } });
const post = (pw: string, path: string, form: Record<string, string> = {}) => as(pw, path, { method: "POST", body: new URLSearchParams(form) });
// The number on a dashboard stat tile.
const stat = (html: string, label: string) => Number(html.match(new RegExp(`<div class="lbl">${label}</div>.*?<b>(\\d+)</b>`, "s"))?.[1]);
const lead = (id: string, username: string, text: string) => ({ subscriber_id: id, username, first_name: null, text });

const sent: { subscriber_id: number; texts: string[] }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      sent.push({ subscriber_id: b.subscriber_id, texts: b.data.content.messages.map((m: { text: string }) => m.text) });
      return Response.json({ status: "success" });
    }),
  );
  vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yo"], stage: "lead", note: "" });
});
afterEach(() => vi.unstubAllGlobals());

// Two threads: a real lead (1) and a SETTERTEST thread (2), both just now.
async function seed(env: Env, now = Date.now()) {
  await db.recordInbound(env.DB, lead("1", "realguy", "hey how do i start"), now - 5 * MIN);
  await db.recordInbound(env.DB, lead("2", "reviewer", "SETTERTEST hi"), now - 4 * MIN);
}

describe("settings", () => {
  it("friends & family: added from Settings by @username (even before they DM), the AI never drafts for them", async () => {
    const env = makeEnv();
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yo"], stage: "lead", note: "" });
    const t = Date.now();
    await db.recordInbound(env.DB, lead("F1", "remy_vale", "yo bro"), t - 2 * MIN);
    await worker.fetch(post("pw", "/admin/settings/friends", { add: "@Remy_Vale" }), env, ctx);
    await worker.fetch(post("pw", "/admin/settings/friends", { add: "https://www.instagram.com/theo.pal/" }), env, ctx);
    const html = await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text();
    expect(html).toContain("@remy_vale");
    expect(html).toContain("@theo.pal</div><div class=\"d\">Hasn't DMed you yet");
    await tick(env, t);
    expect(decide).not.toHaveBeenCalled();
    await db.recordInbound(env.DB, lead("F2", "theo.pal", "yo"), t - 2 * MIN); // Theo's first DM: still a friend
    await tick(env, t + 1000);
    expect(decide).not.toHaveBeenCalled();
    await worker.fetch(post("pw", "/admin/settings/friends", { remove_lead: "F1" }), env, ctx);
    await tick(env, t + 2000);
    expect(decide).toHaveBeenCalledTimes(1); // Remy's off the list: the AI answers him again
  });

  it("round-trips through the page and overrides the wrangler vars", async () => {
    const env = { ...makeEnv(), AUTOPILOT: "false" };
    const before = await getConfig(env);
    expect(before).toMatchObject({ autopilot: false, reply_delay_min_s: 60, reply_delay_max_s: 240, skool_link: LINK, track_links: false });

    const res = await worker.fetch(
      post("pw", "/admin/settings", {
        autopilot: "true",
        reply_delay_min_s: "300",
        reply_delay_max_s: "30", // swapped into order
        skool_link: "https://www.skool.com/your-community",
        track_links: "true",
        auto_resume_hours: "6",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(303);
    expect(await getConfig(env)).toEqual({
      autopilot: true,
      reply_delay_min_s: 30,
      reply_delay_max_s: 300,
      skool_link: "https://www.skool.com/your-community",
      track_links: true,
      pause_on_manual_reply: false, // unchecked box
      auto_resume_hours: 6,
    });
    const html = await (await worker.fetch(as("pw", "/admin/settings?saved=1"), env, ctx)).text();
    expect(html).toContain('value="https://www.skool.com/your-community"');
    // The AI's own settings (and its switch) are on the AI page.
    const ai = await (await worker.fetch(as("pw", "/admin/ai"), await withSettings(env), ctx)).text();
    expect(ai).toContain("AI replies on");
    expect(ai).toContain('name="pause_on_manual_reply" value="true">');
    expect(html).not.toContain("pause_on_manual_reply");

    // A bad link or number keeps the old value.
    await worker.fetch(post("pw", "/admin/settings", { skool_link: "javascript:alert(1)", reply_delay_min_s: "-5", reply_delay_max_s: "300" }), env, ctx);
    const c = await getConfig(env);
    expect(c.skool_link).toBe("https://www.skool.com/your-community");
    expect(c.reply_delay_min_s).toBe(30);
    expect(c.autopilot).toBe(false);
  });

  it("is admin only", async () => {
    const env = { ...makeEnv(), AUTOPILOT: "false" };
    expect((await worker.fetch(as("rv", "/admin/settings"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(post("rv", "/admin/settings", { autopilot: "true" }), env, ctx)).status).toBe(403);
    expect((await getConfig(env)).autopilot).toBe(false);
    expect(await (await worker.fetch(as("rv", "/admin/inbox"), env, ctx)).text()).not.toContain('href="/admin/settings"');
    expect(await (await worker.fetch(as("pw", "/admin/inbox"), env, ctx)).text()).toContain('href="/admin/settings"');
  });

  it("the stored autopilot switch drives the cron", async () => {
    const env = makeEnv(); // AUTOPILOT var is "false"
    await worker.fetch(post("pw", "/admin/settings", { autopilot: "true", reply_delay_min_s: "0", reply_delay_max_s: "0", skool_link: LINK }), env, ctx);
    const now = Date.now();
    await db.recordInbound(env.DB, lead("1", "realguy", "hey"), now - 2 * MIN);
    const run = async () => {
      let p: Promise<unknown> = Promise.resolve();
      await worker.scheduled({} as ScheduledController, env, { waitUntil: (x: Promise<unknown>) => (p = x) } as unknown as ExecutionContext);
      await p;
    };
    await run(); // drafts with send_after = now
    await run(); // sends
    expect(sent).toHaveLength(1);
  });
});

describe("link tracking", () => {
  const linkDraft = () => vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["here u go", "{{SKOOL_LINK}}"], stage: "link_sent", note: "" });

  it("is off by default: the raw Skool link goes out", async () => {
    const env = makeEnv({ AUTOPILOT: "true" });
    linkDraft();
    const now = Date.now();
    await db.recordInbound(env.DB, lead("1", "realguy", "send it"), now);
    await tick(env, now + MIN);
    await tick(env, now + 10 * MIN);
    expect(sent[0].texts.slice(0, 2)).toEqual(["here u go", LINK]); // then autopilot's one-time AI disclosure
  });

  it("routes the link through /l/<code>, logs real clicks and redirects", async () => {
    const env = makeEnv({ AUTOPILOT: "true" });
    await db.setSetting(env.DB, "track_links", "true");
    linkDraft();
    const now = Date.now();
    await db.recordInbound(env.DB, lead("1", "realguy", "send it"), now);
    await tick(env, now + MIN);
    await tick(env, now + 10 * MIN);
    const url = sent[0].texts[1];
    expect(url).toMatch(new RegExp(`^${BASE_URL}/l/[A-Za-z0-9]{8}$`));

    // Same lead, same link: same code.
    await db.recordInbound(env.DB, lead("1", "realguy", "again pls"), now + 11 * MIN);
    await tick(env, now + 12 * MIN);
    await tick(env, now + 20 * MIN);
    expect(sent[1].texts[1]).toBe(url);

    const path = new URL(url).pathname;
    const crawl = await worker.fetch(new Request(`https://x${path}`, { headers: { "User-Agent": "facebookexternalhit/1.1" } }), env, ctx);
    expect(crawl.status).toBe(302);
    const click = await worker.fetch(new Request(`https://x${path}`, { headers: { "User-Agent": "Mozilla/5.0 Instagram 300.0" } }), env, ctx);
    expect(click.status).toBe(302);
    expect(click.headers.get("Location")).toBe(LINK);
    const { results } = await env.DB.prepare(`SELECT * FROM clicks`).all<{ subscriber_id: string }>();
    expect(results.map((r) => r.subscriber_id)).toEqual(["1"]); // the crawler wasn't counted

    const unknown = await worker.fetch(new Request("https://x/l/nope1234"), env, ctx);
    expect(unknown.headers.get("Location")).toBe(LINK);

    const dash = await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text();
    expect(stat(dash, "Link clicks")).toBe(1);
    expect(dash).toContain("1 person · Last 7 days");
    expect(stat(dash, "Skool links sent")).toBe(2);
    expect(dash).toContain("@realguy");
  });
});

describe("inbox", () => {
  it("live updates: the stamp moves when a message lands or the AI starts writing, and the thread shows its typing dots", async () => {
    const env = makeEnv();
    const t = Date.now();
    await db.recordInbound(env.DB, lead("501", "sam", "hey"), t);
    const stamp = async () => ((await (await worker.fetch(as("pw", "/admin/live?lead=501"), env, ctx)).json()) as { v: string }).v;
    const a = await stamp();
    expect(await stamp()).toBe(a);
    await db.recordInbound(env.DB, lead("501", "sam", "u there?"), t + 1000);
    const b = await stamp();
    expect(b).not.toBe(a);
    await env.DB.prepare(`UPDATE leads SET drafting_until = ?2 WHERE subscriber_id = ?1`).bind("501", t + 90_000).run();
    expect(await stamp()).not.toBe(b);
    const html = await (await worker.fetch(as("pw", "/admin/inbox/501"), env, ctx)).text();
    expect(html).toContain('class="m bot typing"');
    expect(html).toContain("location.pathname.match(/\\/admin\\/inbox\\/((?:g:)?\\d+)/)");
  });

  it("a group chat shows who wrote what, lists its members, and can't be answered from here", async () => {
    const env = makeEnv();
    const t = Date.now() - 10 * MIN;
    await db.recordInbound(env.DB, lead("22", "marlon", "our own dm"), t - HOUR);
    const g = "g:340282366841710301281153808080165647092";
    await env.DB.prepare(`INSERT INTO leads (subscriber_id, members, created_at) VALUES (?1, ?2, ?3)`)
      .bind(g, JSON.stringify([{ id: "11", username: "ellis" }, { id: "22", username: "marlon" }]), t)
      .run();
    const add = (sender: string | null, text: string, at: number) =>
      env.DB.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at, mid, sender) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(g, sender ? "lead" : "bot", text, at, `mid-${at}`, sender)
        .run();
    await add("22", "dinner tmrw?", t);
    await add("11", "im in", t + 1000);
    await add("11", "bet", t + 2000);
    await add(null, "I am down", t + 3000);
    await add("22", "see yall there", t + 4000);

    const html = await (await worker.fetch(as("pw", `/admin/inbox/${g}`), env, ctx)).text();
    expect(html.match(/<div class="gs">[^<]*<\/div>/g)).toEqual(['<div class="gs">marlon</div>', '<div class="gs">ellis</div>', '<div class="gs">marlon</div>']);
    expect(html).toContain("Group · 3 people");
    expect(html).toContain(`href="/admin/inbox/22"`); // a member with their own thread links to it
    expect(html).toContain(`href="https://instagram.com/ellis"`);
    expect(html).toContain("Instagram's API can't send to groups");
    expect(html).not.toContain(`/admin/inbox/${g}/reply`);
    expect(html).not.toContain('class="aitog"');
    expect(html).toContain("<b>ellis, marlon</b>"); // the list row
    expect(html).toContain("marlon: see yall there");

    const dash = await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text();
    expect(stat(dash, "Conversations")).toBe(1); // the group isn't a lead
    expect(stat(await (await worker.fetch(as("pw", "/admin/dashboard"), env, ctx)).text(), "People who messaged")).toBe(1); // nor a contact on Home
  });

  it("reviewer sees and touches only test threads", async () => {
    const env = makeEnv();
    await seed(env);
    const admin = await (await worker.fetch(as("pw", "/admin/inbox"), env, ctx)).text();
    expect(admin).toContain("@realguy");
    expect(admin).toContain("@reviewer");
    const review = await (await worker.fetch(as("rv", "/admin/inbox"), env, ctx)).text();
    expect(review).not.toContain("@realguy");
    expect(review).toContain("@reviewer");

    expect((await worker.fetch(as("rv", "/admin/inbox/1"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(post("rv", "/admin/inbox/1/reply", { bubbles: "yo" }), env, ctx)).status).toBe(403);
    expect((await worker.fetch(post("rv", "/admin/inbox/1/pause"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(post("rv", "/admin/inbox/1/tag", { tag: "x" }), env, ctx)).status).toBe(403);
    expect(sent).toHaveLength(0);

    expect((await worker.fetch(as("rv", "/admin/inbox/2"), env, ctx)).status).toBe(200);
    expect((await worker.fetch(post("rv", "/admin/inbox/2/reply", { bubbles: "hey reviewer" }), env, ctx)).status).toBe(303);
    expect(sent).toEqual([{ subscriber_id: 2, texts: ["hey reviewer"] }]);
    expect((await worker.fetch(as("pw", "/admin/inbox/999"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(as("nope", "/admin/inbox"), env, ctx)).status).toBe(401);
  });

  it("manual reply sends inside the 24h window, supersedes the draft, and doesn't count as AI", async () => {
    const env = makeEnv();
    const now = Date.now();
    await db.recordInbound(env.DB, lead("1", "realguy", "hey"), now - 2 * MIN);
    await tick(env, now); // AI draft waiting out its few-second send delay
    const thread = await (await worker.fetch(as("pw", "/admin/inbox/1"), env, ctx)).text();
    expect(thread).toMatch(/23h 5\dm left in the reply window/);
    expect(thread).toContain("AI note");

    const res = await worker.fetch(post("pw", "/admin/inbox/1/reply", { bubbles: "yo whats good\ncheck this {{SKOOL_LINK}}" }), env, ctx);
    expect(res.headers.get("Location")).toBe("https://x/admin/inbox/1");
    expect(sent).toEqual([{ subscriber_id: 1, texts: [`yo whats good\ncheck this ${LINK}`] }]); // one send = one message, like Instagram
    expect((await db.getDraft(env.DB, 1))?.status).toBe("superseded");
    expect((await db.history(env.DB, "1")).map((m) => m.role)).toEqual(["lead", "bot"]);
    await tick(env, now + MIN);
    expect(decide).toHaveBeenCalledTimes(1); // last message is ours: nothing to draft

    const dash = await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text();
    expect(stat(dash, "AI messages sent")).toBe(0);
    expect(stat(dash, "Skool links sent")).toBe(1);
  });

  it("refuses manual replies outside the 24h window", async () => {
    const env = makeEnv();
    const now = Date.now();
    await db.recordInbound(env.DB, lead("1", "realguy", "hey"), now - 25 * HOUR);
    const thread = await (await worker.fetch(as("pw", "/admin/inbox/1"), env, ctx)).text();
    expect(thread).toContain("Reply window closed");
    expect(thread).toContain("disabled");
    const res = await worker.fetch(post("pw", "/admin/inbox/1/reply", { bubbles: "yo" }), env, ctx);
    expect(res.headers.get("Location")).toContain("msg=Not+sent");
    expect(sent).toHaveLength(0);
    expect((await db.history(env.DB, "1")).map((m) => m.role)).toEqual(["lead"]);
  });

  it("a failed send shows the error and is marked rejected", async () => {
    const env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", code: 3011, message: "24h" }, { status: 400 })));
    await db.recordInbound(env.DB, lead("1", "realguy", "hey"), Date.now());
    const res = await worker.fetch(post("pw", "/admin/inbox/1/reply", { bubbles: "yo" }), env, ctx);
    expect(decodeURIComponent(res.headers.get("Location") ?? "")).toContain("3011");
    expect((await db.getDraft(env.DB, 1))?.status).toBe("rejected");
    expect((await worker.fetch(as("pw", "/admin"), env, ctx)).headers.get("Location")).toBe("https://x/admin/dashboard"); // no queue page anymore
  });

  it("pauses, resumes, tags and filters", async () => {
    const env = makeEnv();
    await seed(env);
    await worker.fetch(post("pw", "/admin/inbox/1/pause"), env, ctx);
    expect((await db.getLead(env.DB, "1"))?.status).toBe("paused");
    await worker.fetch(post("pw", "/admin/inbox/1/tag", { tag: " Hot " }), env, ctx);
    const kept = await worker.fetch(post("pw", "/admin/inbox/1/tag", { tag: "hot", f: "?status=paused&evil=1" }), env, ctx);
    expect(kept.headers.get("Location")).toBe("https://x/admin/inbox/1?status=paused"); // list filters survive, junk doesn't
    await worker.fetch(post("pw", "/admin/inbox/2/tag", { tag: "buyer" }), env, ctx);

    const list = async (q: string) => (await (await worker.fetch(as("pw", `/admin/inbox?${q}`), env, ctx)).text()).match(/<b>@\w+/g)?.map((m) => m.slice(3)) ?? [];
    expect(await list("tag=hot")).toEqual(["@realguy"]);
    expect(await list("status=paused")).toEqual(["@realguy"]);
    expect(await list("status=active")).toEqual(["@reviewer"]);
    expect(await list("q=%40revi")).toEqual(["@reviewer"]);
    expect(await list("stage=opener")).toEqual(["@reviewer", "@realguy"]);

    const dash = await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text();
    expect(stat(dash, "Handoffs waiting")).toBe(1);
    expect(dash).toContain("hey how do i start");
    // A friend is the owner's by hand, never a handoff, even while paused.
    await worker.fetch(post("pw", "/admin/inbox/1/tag", { tag: "friend" }), env, ctx);
    expect(stat(await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text(), "Handoffs waiting")).toBe(0);
    await worker.fetch(post("pw", "/admin/inbox/1/untag", { tag: "friend" }), env, ctx);

    await worker.fetch(post("pw", "/admin/inbox/1/untag", { tag: "hot" }), env, ctx);
    await worker.fetch(post("pw", "/admin/inbox/1/resume"), env, ctx);
    expect(await list("tag=hot")).toEqual([]);
    expect((await db.getLead(env.DB, "1"))?.status).toBe("active");
  });
});

describe("dashboard", () => {
  it("counts the furthest stage each lead reached", () => {
    const f = funnel([
      { subscriber_id: "a", stage: "opener" },
      { subscriber_id: "a", stage: "pitch" },
      { subscriber_id: "b", stage: "lead" },
      { subscriber_id: "c", stage: "joined" },
      { subscriber_id: "d", stage: "closed" },
    ]);
    expect(f.map((s) => [s.stage, s.reached, s.through])).toEqual([
      ["opener", 4, 3],
      ["lead", 3, 2],
      ["qualify", 2, 2],
      ["pitch", 2, 1],
      ["link_sent", 1, 1],
      ["joined", 1, 0],
    ]);
  });

  it("scopes stats to test threads for the reviewer and filters by range", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seed(env, now);
    await db.recordInbound(env.DB, lead("3", "oldtimer", "hi"), now - 10 * 24 * HOUR);
    const tiles = async (pw: string, range: string) => {
      const html = await (await worker.fetch(as(pw, `/admin/ai?range=${range}`), env, ctx)).text();
      const home = await (await worker.fetch(as(pw, `/admin/dashboard?range=${range}`), env, ctx)).text();
      expect(stat(home, "People who messaged")).toBe(stat(html, "Conversations")); // Home scopes the same way
      return stat(html, "Conversations");
    };
    expect(await tiles("pw", "7d")).toBe(2);
    expect(await tiles("pw", "30d")).toBe(3);
    expect(await tiles("pw", "all")).toBe(3);
    expect(await tiles("rv", "all")).toBe(1);
  });

  it("Joined only counts joins inside the range, not a member from weeks ago who wrote this week", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seed(env, now);
    const join = (id: string, lead: string, at: number) =>
      env.DB.prepare(
        `INSERT INTO joins (member_id, name, joined_at, subscriber_id, confidence, path, created_at) VALUES (?1, 'x', ?2, ?3, 'confirmed', 'asked', ?2)`,
      ).bind(id, at, lead).run();
    await join("old", "1", now - 15 * 24 * HOUR);
    await db.recordInbound(env.DB, lead("4", "newmember", "im in"), now - 3 * MIN);
    await join("new", "4", now - 2 * 24 * HOUR);
    await env.DB.prepare(`UPDATE leads SET move = 'joined' WHERE subscriber_id IN ('1', '4')`).run();
    const moves = async (range: string) => {
      const html = await (await worker.fetch(as("pw", `/admin/ai?range=${range}`), env, ctx)).text();
      return html.match(/Funnel: ([^"]*)/)?.[1];
    };
    expect(await moves("7d")).toMatch(/Link sent 2, Joined 1$/);
    expect(await moves("30d")).toMatch(/Link sent 2, Joined 2$/);
  });

  it("logs each Claude call's tokens and cost, and the AI tile shows the range's spend (admin only)", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seed(env, now);
    const real = await vi.importActual<typeof import("../src/brain")>("../src/brain");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify({ action: "reply", bubbles: ["yo"], stage: "lead", note: "" }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10_000, output_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000 },
        }),
      ),
    );
    await real.decide("k", "Sam", [{ id: 1, subscriber_id: "1", role: "lead", text: "hey", created_at: 0, mid: null }], undefined, null, null, [], "", meter(env.DB, "reply", "1"));
    // 10k in × $4 + 2k out × $20 + 20k cache reads × $0.20, per million
    expect(await env.DB.prepare(`SELECT kind, subscriber_id, model, cost_micros FROM ai_usage`).first()).toEqual({ kind: "reply", subscriber_id: "1", model: "claude-opus-5-5", cost_micros: 84_000 });
    await env.DB.prepare(`INSERT INTO ai_usage (created_at, kind, model, cost_micros) VALUES (?1, 'console', 'claude-opus-5-5', 13720000)`).bind(now - 2 * 24 * HOUR).run();
    await env.DB.prepare(`INSERT INTO ai_usage (created_at, kind, model, cost_micros) VALUES (?1, 'console', 'claude-opus-5-5', 5000000)`).bind(now - 20 * 24 * HOUR).run();
    const sub = async (pw: string, range: string) =>
      (await (await worker.fetch(as(pw, `/admin/ai?range=${range}`), env, ctx)).text()).match(/AI messages sent<\/div><b>\d+<\/b><small>([^<]*)/)?.[1];
    expect(await sub("pw", "7d")).toBe("$13.80 in AI · Last 7 days");
    expect(await sub("pw", "30d")).toBe("$18.80 in AI · Last 30 days");
    expect(await sub("rv", "7d")).toBe("Last 7 days");
  });

  it("windowLeft counts down from the last inbound message", () => {
    expect(windowLeft({ last_inbound_at: 0 }, 1)).toBe(0);
    expect(windowLeft({ last_inbound_at: null }, 1)).toBe(0);
    expect(windowLeft({ last_inbound_at: 1000 }, 1000 + HOUR)).toBe(23 * HOUR);
  });
});

describe("inbox at scale + master switch", () => {
  it("the AI page's switch flips the AI for everyone, admin only, and the badges follow it", async () => {
    const env = { ...makeEnv(), AUTOPILOT: "false" };
    await db.recordInbound(env.DB, lead("1", "realguy", "hey"), Date.now());
    const off = await (await worker.fetch(as("pw", "/admin/inbox"), env, ctx)).text();
    expect(await (await worker.fetch(as("pw", "/admin/ai"), env, ctx)).text()).toContain("AI replies off");
    expect(off).toContain(">AI off<");
    expect((await worker.fetch(post("rv", "/admin/ai", {}), env, ctx)).status).toBe(403);
    expect((await worker.fetch(post("pw", "/admin/ai", {}), env, ctx)).status).toBe(303);
    expect((await getConfig(env)).autopilot).toBe(true);
    const on = await (await worker.fetch(as("pw", "/admin/inbox"), await withSettings(env), ctx)).text();
    expect(await (await worker.fetch(as("pw", "/admin/ai"), await withSettings(env), ctx)).text()).toContain("AI replies on");
    expect(on).toContain(">AI on<");
  });

  it("keeps each thread's latest message on the lead and pages 50 at a time, newest first", async () => {
    const env = makeEnv();
    const t0 = Date.now() - 3 * 60 * MIN;
    for (let i = 1; i <= 60; i++) await db.recordInbound(env.DB, lead(String(i), `u${i}`, `msg ${i}`), t0 + i * MIN);
    expect((await db.getLead(env.DB, "60"))?.last_at).toBe(t0 + 60 * MIN);
    const first = await (await worker.fetch(as("pw", "/admin/inbox"), env, ctx)).text();
    expect(first).toContain("60 conversations");
    expect(first).toContain("/admin/inbox/60");
    expect(first).not.toContain('href="/admin/inbox/1"');
    expect(first).toContain('href="/admin/inbox?p=1"');
    const second = await (await worker.fetch(as("pw", "/admin/inbox?p=1"), env, ctx)).text();
    expect(second).toContain('href="/admin/inbox/1"');
    expect(second).not.toContain("/admin/inbox/60");
  });
});

it("allows one-click sample access only on the same-origin loopback demo", async () => {
  const req = (host: string, origin: string) => new Request(host + "/login", {
    method: "POST", headers: { Origin: origin }, body: new URLSearchParams({sample:"open"}),
  });
  const local="http://127.0.0.1:8791", remote="https://inbox.example.org";
  const demo=makeEnv({HOST_MODE:"demo"});
  expect((await worker.fetch(req(local,local),demo,ctx)).headers.get("Set-Cookie")).toBeTruthy();
  for(const [reqHost,origin,env] of [[local,remote,demo],[remote,remote,demo],[local,local,makeEnv({HOST_MODE:"live"})]] as const) {
    const result=await worker.fetch(req(reqHost,origin),env,ctx);
    expect(result.status).toBe(403);expect(result.headers.get("Set-Cookie")).toBeNull();
  }
});
