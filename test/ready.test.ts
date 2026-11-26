import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import worker from "../src/index";
import { aiBlocker } from "../src/ready";
import { getConfig } from "../src/settings";
import { draftFor, type Env } from "../src/setter";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const auth = { Authorization: `Basic ${btoa("a:pw")}` };

const makeEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    INBOUND_SECRET: "s",
    AI: {} as Ai,
    SKOOL_LINK: "https://example.com",
    AUTOPILOT: "false",
    REPLY_DELAY_MIN_S: "2",
    REPLY_DELAY_MAX_S: "5",
    TRANSPORT: "meta",
    META_IG_APP_ID: "1",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
    ...over,
  }) as Env;

describe("the AI needs a script and a key before it can run", () => {
  it("a script with blanks left, or no API key, blocks it; both in place don't", () => {
    expect(aiBlocker({ ANTHROPIC_API_KEY: "k" }, "You are <<FILL: your full name>>")).toContain("script");
    expect(aiBlocker({}, "You are Sam")).toContain("API key");
    expect(aiBlocker({ ANTHROPIC_API_KEY: "" }, "You are Sam")).toContain("API key");
    expect(aiBlocker({ ANTHROPIC_API_KEY: "k" }, "You are Sam")).toBeNull();
  });

  it("without a key the switch stays off and says why, a thread can't be switched on, and nothing is drafted", async () => {
    const env = makeEnv({ ANTHROPIC_API_KEY: "" });
    await db.recordInbound(env.DB, { subscriber_id: "1", username: "realguy", first_name: "Real", text: "hey", mid: "m1" }, Date.now());

    const page = await (await worker.fetch(new Request("https://x/admin/ai", { headers: auth }), env, ctx)).text();
    expect(page).toContain("AI replies off");
    expect(page).toContain("Not set up yet");
    expect(page).toContain("Anthropic API key");

    const flip = await worker.fetch(new Request("https://x/admin/ai", { method: "POST", headers: auth }), env, ctx);
    expect(flip.status).toBe(303);
    expect((await getConfig(env)).autopilot).toBe(false);

    const solo = await worker.fetch(new Request("https://x/admin/inbox/1/ai", { method: "POST", headers: auth, body: new URLSearchParams() }), env, ctx);
    expect(solo.headers.get("Location")).toBe("https://x/admin/ai");
    expect((await db.getLead(env.DB, "1"))?.ai_on ?? 0).toBe(0);

    expect(await draftFor({ ...env, AUTOPILOT: "true" }, (await db.getLead(env.DB, "1"))!, Date.now())).toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) n FROM drafts`).first<{ n: number }>())?.n).toBe(0);
  });

  it("an AI that's already on can always be switched off", async () => {
    const env = makeEnv({ ANTHROPIC_API_KEY: "", AUTOPILOT: "true" });
    const page = await (await worker.fetch(new Request("https://x/admin/ai", { headers: auth }), env, ctx)).text();
    expect(page).toContain("Turn off");
    await worker.fetch(new Request("https://x/admin/ai", { method: "POST", headers: auth }), env, ctx);
    expect((await getConfig(env)).autopilot).toBe(false);
  });
});
