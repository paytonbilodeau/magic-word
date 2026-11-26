import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";

vi.mock("../src/brain", async (orig) => ({ ...(await orig<typeof import("../src/brain")>()), decide: vi.fn() }));

import { cleanBubbles, decide, Decision, renderTranscript } from "../src/brain";
import { authorized, splitBubbles } from "../src/admin";
import * as db from "../src/db";
import { fillLink, parseInbound } from "../src/manychat";
import { sendDelayMs, sendDraft, tick, type Env } from "../src/setter";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: makeD1(),
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "mc",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    SKOOL_LINK: "https://www.skool.com/your-community/about",
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

const inbound = (text: string, id = "123") => ({ subscriber_id: id, username: "lead1", first_name: "Sam", text });
const sent: { subscriber_id: number; data: { content: { type: string; messages: { text: string }[] } } }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ status: "success" });
    }),
  );
  vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["yooo", "whats ur biz rn?"], stage: "lead", note: "" });
});
afterEach(() => vi.unstubAllGlobals());

describe("parseInbound", () => {
  it("accepts a Manychat body and drops unfilled vars", () => {
    expect(parseInbound({ subscriber_id: 987, username: "{{instagram_username}}", first_name: "", text: " hey " })).toEqual({
      subscriber_id: "987",
      username: null,
      first_name: null,
      text: "hey",
    });
  });
  it("rejects missing text, non-numeric ids and junk", () => {
    expect(parseInbound({ subscriber_id: "1", text: "{{last_input_text}}" })).toBeNull();
    expect(parseInbound({ subscriber_id: "abc", text: "hi" })).toBeNull();
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound("hi")).toBeNull();
  });
});

describe("bubbles", () => {
  it("strips em dashes, empties, and caps at 4", () => {
    expect(cleanBubbles(["damn — thats sick", " ", "a", "b", "c", "d"])).toEqual(["damn, thats sick", "a", "b", "c"]);
  });
  it("fills the Skool link placeholder", () => {
    expect(fillLink(["heres the link {{SKOOL_LINK}}"], "L")).toEqual(["heres the link L"]);
  });
  it("splits edited text one bubble per line", () => {
    expect(splitBubbles("yo\r\n\n  whats up  \n")).toEqual(["yo", "whats up"]);
  });
  it("validates model output shape", () => {
    expect(() => Decision.parse({ action: "book_call", bubbles: [], stage: "lead", note: "" })).toThrow();
  });
  it("renders the transcript with roles", () => {
    const t = renderTranscript("Sam", [
      { id: 1, subscriber_id: "1", role: "bot", text: "sent the resource", created_at: 0, mid: null },
      { id: 2, subscriber_id: "1", role: "lead", text: "thanks", created_at: 0, mid: null },
    ]);
    expect(t).toContain("YOU: sent the resource\nTHEM: thanks");
  });
});

describe("helpers", () => {
  it("sendDelayMs stays inside the configured range", () => {
    const env = makeEnv();
    expect(sendDelayMs(env, 0)).toBe(60_000);
    expect(sendDelayMs(env, 1)).toBe(240_000);
  });
  it("basic auth checks the password", () => {
    const req = (pw: string) => new Request("https://x/admin", { headers: { Authorization: `Basic ${btoa(`owner:${pw}`)}` } });
    expect(authorized(req("pw"), "pw")).toBe(true);
    expect(authorized(req("nope"), "pw")).toBe(false);
    expect(authorized(new Request("https://x/admin"), "pw")).toBe(false);
    expect(authorized(req(""), "")).toBe(false);
  });
});

describe("tick", () => {
  it("waits for a burst to go quiet, then drafts once", async () => {
    const env = makeEnv();
    await db.recordInbound(env.DB, inbound("hey"), T0);
    await db.recordInbound(env.DB, inbound("saw ur reel"), T0 + 10_000);

    await tick(env, T0 + 30_000); // still inside the quiet window
    expect(decide).not.toHaveBeenCalled();

    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN); // no new lead message: no second draft
    expect(decide).toHaveBeenCalledTimes(1);
    const history = vi.mocked(decide).mock.calls[0][2];
    expect(history.map((m) => m.text)).toEqual(["hey", "saw ur reel"]);
    expect(sent).toHaveLength(1); // AI on: that one draft goes out, once
  });

  it("AI off drafts nothing at all", async () => {
    const env = makeEnv({ AUTOPILOT: "false" });
    await db.recordInbound(env.DB, inbound("hey"), T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 2 * MIN);
    expect(decide).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("a new lead message supersedes the pending draft and gets a fresh one", async () => {
    const env = makeEnv();
    await db.recordInbound(env.DB, inbound("hey"), T0);
    await tick(env, T0 + MIN);
    await db.recordInbound(env.DB, inbound("also how much is it"), T0 + 2 * MIN);
    const old = await db.getDraft(env.DB, 1);
    expect(old?.status).toBe("superseded");
    await tick(env, T0 + 3 * MIN);
    expect(decide).toHaveBeenCalledTimes(2);
    expect((await db.getDraft(env.DB, 2))?.status).toBe("pending");
  });

  it("autopilot sends after the delay through Manychat with the link filled", async () => {
    const env = makeEnv({ AUTOPILOT: "true" });
    vi.mocked(decide).mockResolvedValue({ action: "reply", bubbles: ["sick heres the link", "{{SKOOL_LINK}}"], stage: "link_sent", note: "" });
    await db.recordInbound(env.DB, inbound("yes"), T0);
    await tick(env, T0 + MIN);
    expect(sent).toHaveLength(0);
    await tick(env, T0 + MIN + 241_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].subscriber_id).toBe(123);
    expect(sent[0].data.content.type).toBe("instagram");
    expect(sent[0].data.content.messages.map((m) => m.text)).toEqual(["sick heres the link", env.SKOOL_LINK]);
    expect((await db.history(env.DB, "123")).map((m) => m.role)).toEqual(["lead", "bot", "bot"]);
    expect((await db.getLead(env.DB, "123"))?.stage).toBe("link_sent");
  });

  it("flag pauses the lead for good and never sends", async () => {
    const env = makeEnv({ AUTOPILOT: "true" });
    vi.mocked(decide).mockResolvedValue({ action: "flag", bubbles: [], stage: "opener", note: "pitching a setter service" });
    await db.recordInbound(env.DB, inbound("i run a dm setting agency"), T0);
    await tick(env, T0 + MIN);
    await db.recordInbound(env.DB, inbound("u there?"), T0 + 2 * MIN);
    await tick(env, T0 + 10 * MIN);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect((await db.getLead(env.DB, "123"))?.status).toBe("flagged");
  });

  it("stop closes the lead, and a later message reopens it", async () => {
    const env = makeEnv({ AUTOPILOT: "true" });
    vi.mocked(decide).mockResolvedValue({ action: "stop", bubbles: ["respect! hit me up whenever ur ready"], stage: "closed", note: "" });
    await db.recordInbound(env.DB, inbound("not rn"), T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 6 * MIN);
    expect((await db.getLead(env.DB, "123"))?.status).toBe("done");
    await db.recordInbound(env.DB, inbound("ok im ready now"), T0 + 60 * MIN);
    expect((await db.getLead(env.DB, "123"))?.status).toBe("active");
  });

  it("never sends outside the 24h window", async () => {
    const env = makeEnv();
    await db.recordInbound(env.DB, inbound("hey"), T0);
    await tick(env, T0 + MIN);
    await tick(env, T0 + 25 * 60 * MIN);
    expect((await db.getDraft(env.DB, 1))?.status).toBe("expired");
    await sendDraft(env, (await db.getDraft(env.DB, 1))!, T0 + 25 * 60 * MIN); // a late send attempt is refused too
    expect(sent).toHaveLength(0);
  });

  it("a Manychat failure marks the draft failed and keeps it retryable", async () => {
    const env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "error", code: 3011, message: "24h" }, { status: 400 })));
    await db.recordInbound(env.DB, inbound("hey"), Date.now());
    await tick(env, Date.now() + MIN);
    await tick(env, Date.now() + 2 * MIN); // autopilot sends it, Manychat refuses
    const d = await db.getDraft(env.DB, 1);
    expect(d?.status).toBe("failed");
    expect(d?.error).toContain("3011");
  });
});
