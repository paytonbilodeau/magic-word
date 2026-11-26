import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeD1 } from "./d1shim";

vi.mock("../src/brain", async (orig) => ({ ...(await orig<typeof import("../src/brain")>()), decide: vi.fn() }));

import { applyUpdate, MEDIA_TTL_MS, partsFromApi, resolveThread, splitText, threadLink, type MediaRow } from "../src/attachments";
import * as db from "../src/db";
import worker from "../src/index";
import { hmacHex, parseMessageUpdates, parseParts, parseReplies, parseWebhook, webhookParts } from "../src/meta";
import type { Env } from "../src/setter";
import { syncText } from "../src/sync";
import { messageHtml, previewText, quoteHtml } from "../src/thread_view";

const ME = "17840000000000001";
const LEAD = "990011";
const T0 = Date.UTC(2026, 9, 28, 12);
const CDN = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=abc";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

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
    REPLY_DELAY_MIN_S: "2",
    REPLY_DELAY_MAX_S: "5",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
  };
}

const hook = (messaging: Record<string, unknown>[]) => ({ object: "instagram", entry: [{ id: ME, time: 1, messaging }] });
const inbound = (message: Record<string, unknown>) => hook([{ sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, message }]);

async function postHook(env: Env, payload: unknown) {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request("https://x/meta", { method: "POST", body, headers: { "X-Hub-Signature-256": `sha256=${await hmacHex("appsecret", body)}` } }), env, ctx);
}
const asAdmin = (path: string, pw = "pw", headers: Record<string, string> = {}) =>
  new Request(`https://x${path}`, { headers: { Authorization: `Basic ${btoa(`owner:${pw}`)}`, ...headers } });

async function addMessage(env: Env, m: { text: string; mid?: string | null; role?: string; attachments?: unknown; at?: number; lead?: string }) {
  const lead = m.lead ?? LEAD;
  await env.DB.prepare(`INSERT OR IGNORE INTO leads (subscriber_id, username, created_at) VALUES (?1, 'lead.handle', ?2)`).bind(lead, T0).run();
  const r = await env.DB.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at, mid, attachments) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`)
    .bind(lead, m.role ?? "lead", m.text, m.at ?? T0, m.mid === undefined ? `aWdfZAG1faXRl${Math.random().toString(36).slice(2)}` : m.mid, m.attachments ? JSON.stringify(m.attachments) : null)
    .first<{ id: number }>();
  return (await env.DB.prepare(`SELECT * FROM messages WHERE id = ?1`).bind(r!.id).first<MediaRow>())!;
}

afterEach(() => vi.unstubAllGlobals());

describe("webhook parser, per kind", () => {
  const one = (message: Record<string, unknown>) => parseWebhook(inbound({ mid: "mid.1", ...message }))[0];
  const parts = (message: Record<string, unknown>) => parseParts(inbound({ mid: "mid.1", ...message })).get("mid.1");

  it("keeps the model's text summary and adds structure", () => {
    expect(one({ attachments: [{ type: "image", payload: { url: CDN } }] }).text).toBe("[image]");
    expect(parts({ attachments: [{ type: "image", payload: { url: CDN } }] })).toEqual([{ type: "image", url: CDN }]);
    expect(parts({ attachments: [{ type: "image", payload: { url: CDN, sticker_id: 369239263222822 } }] })).toEqual([{ type: "sticker", url: CDN }]);
    expect(one({ attachments: [{ type: "video", payload: { url: CDN } }] }).text).toBe("[video]");
    expect(one({ attachments: [{ type: "audio", payload: { url: CDN } }] }).text).toBe("[voice note]");
    expect(parts({ attachments: [{ type: "audio", payload: { url: CDN } }] })).toEqual([{ type: "audio", url: CDN }]);
    expect(one({ attachments: [{ type: "file", payload: { url: CDN } }] }).text).toBe("[file]");
    expect(one({ attachments: [{ type: "like_heart" }] }).text).toBe("[sent a heart]");
    expect(parts({ attachments: [{ type: "like_heart" }] })).toEqual([{ type: "like" }]);
    expect(one({ attachments: [{ type: "story_mention", payload: { url: CDN } }] }).text).toBe("[mentioned you in their story]");
    expect(parts({ attachments: [{ type: "story_mention", payload: { url: CDN } }] })).toEqual([{ type: "story_mention", url: CDN }]);
    expect(parts({ attachments: [{ type: "ig_story", payload: { url: CDN } }] })).toEqual([{ type: "story_share", url: CDN }]);
  });

  it("one shared post even when it comes as share + ig_post, reels with their id and caption", () => {
    const payload = { url: CDN, title: "how i edit <fast>", ig_post_media_id: "1813" };
    const both = { attachments: [{ type: "share", payload }, { type: "ig_post", payload }] };
    expect(one(both).text).toBe("[shared a post]");
    expect(parts(both)).toEqual([{ type: "post", url: CDN, id: "1813", title: "how i edit <fast>" }]);
    const reel = { attachments: [{ type: "ig_reel", payload: { url: CDN, title: "reel cap", reel_video_id: "777" } }] };
    expect(one(reel).text).toBe("[shared a reel]");
    expect(parts(reel)).toEqual([{ type: "reel", url: CDN, id: "777", title: "reel cap" }]);
  });

  it("story replies, unsupported, and our own templates", () => {
    expect(one({ text: "fire", reply_to: { story: { id: "s1", url: CDN } } }).text).toBe("[replying to your story] fire");
    expect(parts({ text: "fire", reply_to: { story: { id: "s1", url: CDN } } })).toEqual([{ type: "story_reply", url: CDN, id: "s1" }]);
    expect(parts({ is_unsupported: true, text: "x" })).toEqual([{ type: "unsupported" }]);
    expect(webhookParts({ attachments: [{ type: "template", payload: {} as never }] })).toEqual([]);
    expect(parts({ text: "just text" })).toBeUndefined();
  });

  it("reactions, edits and unsends become updates", () => {
    expect(
      parseMessageUpdates(
        hook([
          { sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, reaction: { mid: "m1", action: "react", reaction: "love", emoji: "❤️" } },
          { sender: { id: ME }, recipient: { id: LEAD }, timestamp: T0, reaction: { mid: "m2", action: "react", emoji: "\u{1F602}" } },
          { sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, reaction: { mid: "m1", action: "unreact" } },
          { sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, message_edit: { mid: "m3", text: "fixed typo", num_edit: 1 } },
          { sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, message: { mid: "m4", is_deleted: true } },
        ]),
      ),
    ).toEqual([
      { kind: "reaction", mid: "m1", who: "lead", emoji: "❤️" },
      { kind: "reaction", mid: "m2", who: "you", emoji: "\u{1F602}" },
      { kind: "reaction", mid: "m1", who: "lead", emoji: null },
      { kind: "edit", mid: "m3", text: "fixed typo" },
      { kind: "unsend", mid: "m4" },
    ]);
  });
});

describe("message API mapping", () => {
  it("maps attachments, shares and stories", () => {
    expect(
      partsFromApi({
        id: "m",
        attachments: {
          data: [
            { id: "a1", mime_type: "image/jpeg", image_data: { url: "u1", preview_url: "p1" } },
            { id: "a2", mime_type: "image/gif", image_data: { url: "u2", animated_gif_url: "g2" } },
            { id: "a3", mime_type: "image/png", image_data: { url: "u3", render_as_sticker: true } },
            { id: "a4", mime_type: "video/mp4", video_data: { url: "u4", preview_url: "p4" } },
            { id: "a5", mime_type: "audio/mpeg", video_data: { url: "u5" } },
            { id: "a6", mime_type: "application/pdf", name: "deck.pdf", file_url: "u6" },
          ],
        },
        shares: { data: [{ link: "https://lookaside.fbsbx.com/x", description: "cap" }, { link: "https://www.instagram.com/reel/abc/", name: "r" }] },
        story: { reply_to: { link: "s1", id: "st1" } },
      }),
    ).toEqual([
      { type: "story_reply", url: "s1", id: "st1" },
      { type: "image", id: "a1", mime: "image/jpeg", url: "u1", preview: "p1" },
      { type: "gif", id: "a2", mime: "image/gif", url: "g2", preview: null },
      { type: "sticker", id: "a3", mime: "image/png", url: "u3", preview: null },
      { type: "video", id: "a4", mime: "video/mp4", url: "u4", preview: "p4" },
      { type: "audio", id: "a5", mime: "audio/mpeg", url: "u5", preview: null },
      { type: "file", id: "a6", mime: "application/pdf", url: "u6", title: "deck.pdf" },
      { type: "post", id: null, url: "https://lookaside.fbsbx.com/x", link: null, title: "cap" },
      { type: "reel", id: null, url: null, link: "https://www.instagram.com/reel/abc/", title: "r" },
    ]);
    expect(partsFromApi({ id: "m", story: { mention: { link: "s", id: "x" } } })).toEqual([{ type: "story_mention", url: "s", id: "x" }]);
    expect(partsFromApi({ id: "m", is_unsupported: true })).toEqual([{ type: "unsupported" }]);
  });

  it("the sync writes the same summaries as the webhook", () => {
    const base = { id: "m", created_time: "2026-10-28T12:00:00+0000" };
    expect(syncText({ ...base, attachments: { data: [{ mime_type: "audio/mpeg", video_data: { url: "u" } }] } })).toBe("[voice note]");
    expect(syncText({ ...base, message: "fire", story: { reply_to: { link: "s", id: "x" } } })).toBe("[replying to your story] fire");
    expect(syncText({ ...base, attachments: { data: [{ mime_type: "image/jpeg" }] } })).toBe("[image]"); // plain fields: mime only
  });
});

describe("updates on stored rows", () => {
  it("reactions set and clear, edits keep the story prefix, unsends wipe text, media and cache", async () => {
    const env = makeEnv();
    const m = await addMessage(env, { text: '[replying to your story] fire', mid: "mA" });
    await applyUpdate(env.DB, { kind: "reaction", mid: "mA", who: "lead", emoji: "\u{1F525}" }, T0);
    await applyUpdate(env.DB, { kind: "reaction", mid: "mA", who: "you", emoji: "❤️" }, T0);
    await applyUpdate(env.DB, { kind: "reaction", mid: "mA", who: "lead", emoji: null }, T0);
    await applyUpdate(env.DB, { kind: "edit", mid: "mA", text: "fire fr" }, T0 + 1);
    let row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?1`).bind(m.id).first<MediaRow>();
    expect(JSON.parse(row!.reactions!)).toEqual({ you: "❤️" });
    expect(row!.text).toBe("[replying to your story] fire fr");
    expect(row!.edited_at).toBe(T0 + 1);

    const img = await addMessage(env, { text: '[image] "a selfie"', mid: "mB", attachments: [{ type: "image", url: CDN }] });
    await env.DB.prepare(`INSERT INTO media_cache (mid, data, fetched_at) VALUES ('mB', '{"parts":[],"reactions":[]}', ?1)`).bind(T0).run();
    await applyUpdate(env.DB, { kind: "unsend", mid: "mB" }, T0 + 2);
    row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ?1`).bind(img.id).first<MediaRow>();
    expect(row).toMatchObject({ text: "[unsent a message]", attachments: null, unsent_at: T0 + 2 });
    expect(await env.DB.prepare(`SELECT 1 FROM media_cache WHERE mid = 'mB'`).first()).toBeNull();
    expect(messageHtml(row!, undefined)).toContain("Unsent a message");
  });

  it("the webhook stores structure and applies reactions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ username: "lead.handle", name: "Sam" })));
    const env = makeEnv();
    await postHook(env, inbound({ mid: "mid.web1", attachments: [{ type: "ig_reel", payload: { url: CDN, title: "cap", reel_video_id: "9" } }] }));
    await postHook(env, hook([{ sender: { id: LEAD }, recipient: { id: ME }, timestamp: T0, reaction: { mid: "mid.web1", action: "react", emoji: "\u{1F602}" } }]));
    const row = await env.DB.prepare(`SELECT text, attachments, reactions FROM messages WHERE mid = 'mid.web1'`).first<MediaRow>();
    expect(row!.text).toBe(`[shared a reel] (caption: "cap")`); // the setter reads the caption
    expect(JSON.parse(row!.attachments!)).toEqual([{ type: "reel", url: CDN, id: "9", title: "cap" }]);
    expect(JSON.parse(row!.reactions!)).toEqual({ lead: "\u{1F602}" });
  });
});

describe("resolver", () => {
  let calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  beforeEach(() => {
    calls = [];
    inFlight = maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (url.includes("/me/conversations")) {
          return Response.json({ data: [{ id: "c1", messages: { data: [{ id: "old.1", attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: `${CDN}&old` } }] } }] } }] });
        }
        if (url.includes("/old.1?")) return Response.json({ error: { message: "This message has been deleted", code: 100 } }, { status: 400 });
        const mid = decodeURIComponent(url.match(/v26\.0\/([^?]+)/)![1]);
        return Response.json({ id: mid, attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: `${CDN}&m=${mid}` } }] } });
      }),
    );
  });

  it("asks by mid with bounded parallelism, caches for the TTL, then asks again", async () => {
    const env = makeEnv();
    const rows: MediaRow[] = [];
    for (let i = 0; i < 8; i++) rows.push(await addMessage(env, { text: "[image]", mid: `mid.${i}` }));
    rows.push(await addMessage(env, { text: "just text", mid: "mid.text" }));
    const got = await resolveThread(env.DB, "tok", LEAD, rows, T0);
    expect(calls).toHaveLength(8);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(got.get("mid.3")?.parts[0]).toMatchObject({ type: "image", url: `${CDN}&m=mid.3` });
    expect(calls.some((u) => u.includes("mid.text"))).toBe(false);

    calls = [];
    await resolveThread(env.DB, "tok", LEAD, rows, T0 + 1000);
    expect(calls).toEqual([]); // cached
    await resolveThread(env.DB, "tok", LEAD, rows, T0 + MEDIA_TTL_MS + 1);
    expect(calls).toHaveLength(8); // stale: asked again
  });

  it("only the newest dozen are asked for while rendering", async () => {
    const env = makeEnv();
    const rows: MediaRow[] = [];
    for (let i = 0; i < 20; i++) rows.push(await addMessage(env, { text: "[video]", mid: `mid.${i}` }));
    await resolveThread(env.DB, "tok", LEAD, rows, T0);
    expect(calls).toHaveLength(12);
    expect(calls.some((u) => u.includes("/mid.19?"))).toBe(true);
    expect(calls.some((u) => u.includes("/mid.0?"))).toBe(false);
  });

  it("an old message Instagram won't detail by mid is found through the conversation, and misses are cached", async () => {
    const env = makeEnv();
    const old = await addMessage(env, { text: "[image]", mid: "old.1" });
    const gone = await addMessage(env, { text: "[audio]", mid: "gone.1" });
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ error: { message: "deleted", code: 100 } }, { status: 400 }));
    // Rows in thread order; the resolver asks newest first, so "gone.1" (the newest) hits the mocked error.
    const got = await resolveThread(env.DB, "tok", LEAD, [old, gone], T0);
    expect(got.get("old.1")?.parts[0]).toMatchObject({ type: "image", url: `${CDN}&old` });
    expect(got.has("gone.1")).toBe(false);
    expect(calls.some((u) => u.includes("/me/conversations?platform=instagram&user_id=990011"))).toBe(true);
    calls = [];
    const again = await resolveThread(env.DB, "tok", LEAD, [old, gone], T0 + 1000);
    expect(calls).toEqual([]);
    expect(again.get("gone.1")).toEqual({ parts: [], reactions: [] }); // remembered as nothing to show
  });
});

describe("media proxy", () => {
  it("a history message with only a mid resolves to media and streams through the Worker", async () => {
    const env = makeEnv();
    await db.setSetting(env.DB, "ig_token", "tok");
    const m = await addMessage(env, { text: "[image]", mid: "aWdfhist1" });
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.startsWith("https://graph.instagram.com/v26.0/aWdfhist1?")) {
          return Response.json({ id: "aWdfhist1", attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: CDN } }] } });
        }
        if (url === CDN) return new Response("JPEGBYTES", { headers: { "Content-Type": "image/jpeg", "Content-Length": "9" } });
        return new Response("nope", { status: 404 });
      }),
    );
    const res = await worker.fetch(asAdmin(`/admin/media/${m.id}/0`), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(await res.text()).toBe("JPEGBYTES");
    // Second view: cached URL, no API call.
    seen.length = 0;
    await worker.fetch(asAdmin(`/admin/media/${m.id}/0`), env, ctx);
    expect(seen).toEqual([CDN]);
    // The thread itself links the proxy, never the CDN.
    const page = await (await worker.fetch(asAdmin(`/admin/inbox/${LEAD}`), env, ctx)).text();
    expect(page).toContain(`src="/admin/media/${m.id}/0"`);
    expect(page).not.toContain("lookaside.fbsbx.com");
  });

  it("logged-out, reviewer on a real thread, non-CDN URLs and expired media all get nothing", async () => {
    const env = makeEnv();
    const m = await addMessage(env, { text: "[image]", mid: "aWdfx", attachments: [{ type: "image", url: "https://evil.example/x.jpg" }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { headers: { "Content-Type": "image/jpeg" } })));
    expect((await worker.fetch(new Request(`https://x/admin/media/${m.id}/0`), env, ctx)).status).toBe(302);
    expect((await worker.fetch(asAdmin(`/admin/media/${m.id}/0`, "rv"), env, ctx)).status).toBe(403);
    expect((await worker.fetch(asAdmin(`/admin/media/${m.id}/0`), env, ctx)).status).toBe(404); // no token, URL not Instagram's
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes Range through for video and voice notes, and files download", async () => {
    const env = makeEnv();
    const v = await addMessage(env, { text: "[voice note]", mid: "aWdfv", attachments: [{ type: "audio", url: CDN }] });
    const f = await addMessage(env, { text: "[file]", mid: "aWdff", attachments: [{ type: "file", url: CDN, title: 'deck "q4".pdf' }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("Range");
        return range
          ? new Response("ab", { status: 206, headers: { "Content-Type": "audio/mp4", "Content-Range": "bytes 0-1/10" } })
          : new Response("pdf", { headers: { "Content-Type": "application/pdf" } });
      }),
    );
    const res = await worker.fetch(asAdmin(`/admin/media/${v.id}/0`, "pw", { Range: "bytes=0-1" }), env, ctx);
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/10");
    const file = await worker.fetch(asAdmin(`/admin/media/${f.id}/0?dl=1`), env, ctx);
    expect(file.headers.get("Content-Disposition")).toBe('attachment; filename="deck _q4_.pdf"');
  });
});

// A message id shaped like Instagram's: a binary-ish prefix, then base64 of "...:<account>:<thread>:<item>".
const THREAD = "340282366841710301244200000000000000001";
const THREAD_MID = "aW" + btoa(`ig_message_item:1:IGMessageID:17800000000000001:${THREAD}:33100000000000000000000000000000001`);

describe("threadLink", () => {
  it("reads the chat's thread id out of a message id, at any base64 offset", () => {
    expect(threadLink(THREAD_MID)).toBe(`https://www.instagram.com/direct/t/${THREAD}/`);
    expect(threadLink(btoa(`x:17800000000000001:${THREAD}:331000000000001`))).toBe(`https://www.instagram.com/direct/t/${THREAD}/`);
    expect(threadLink("aWdfZ")).toBeNull();
    expect(threadLink("pb:12:q1")).toBeNull();
    expect(threadLink(null)).toBeNull();
  });
});

describe("renderer, per kind", () => {
  const row = (text: string, extra: Partial<MediaRow> = {}): MediaRow =>
    ({ id: 7, subscriber_id: LEAD, role: "lead", text, created_at: T0, mid: "aWdfZ", attachments: null, reactions: null, edited_at: null, unsent_at: null, ...extra }) as MediaRow;
  const html = (text: string, extra: Partial<MediaRow> = {}, r?: Parameters<typeof messageHtml>[1]) => messageHtml(row(text, extra), r);

  it("a heart reaction shows as the red emoji, like the app (Instagram sends a bare ❤)", () => {
    expect(html("totally get it", { role: "bot", reactions: JSON.stringify({ lead: "\u2764" }) })).toContain('<span class="rx">\u2764\uFE0F</span>');
    expect(html("lol", { reactions: JSON.stringify({ you: "😂" }) })).toContain('<span class="rx">😂</span>');
  });

  it("plain text stays a plain bubble", () => {
    expect(html("hey <b>")).toBe('<div class="m lead">hey &#60;b&#62;</div>');
  });

  it("images and GIFs inline, tap to open; stickers bare", () => {
    const h = html('[image] "a <script> selfie" look', { attachments: JSON.stringify([{ type: "image", url: CDN }]) });
    expect(h).toContain('<img src="/admin/media/7/0" loading="lazy"');
    expect(h).toContain('onclick="return lb(this)"');
    expect(h).toContain('alt="a &#60;script&#62; selfie"');
    expect(h).toContain('<div class="bb">look</div>');
    expect(h).not.toContain(CDN);
    expect(html("[image]", { attachments: JSON.stringify([{ type: "sticker", url: CDN }]) })).toContain('class="mx stk"');
  });

  it("video player with poster, voice note with transcript, file chip", () => {
    const v = html("[video]", {}, { parts: [{ type: "video", url: CDN, preview: CDN }], reactions: [] });
    expect(v).toContain('<video class="mx-vid" controls playsinline preload="none" data-src="/admin/media/7/0" poster="/admin/media/7/0/thumb"');
    const a = html('[voice note] "yo i make <b>reels</b>"', { attachments: JSON.stringify([{ type: "audio", url: CDN }]) });
    expect(a).toContain('class="mx vn"');
    expect(a).toContain('<audio preload="metadata" data-src="/admin/media/7/0"');
    expect(a).toContain('<div class="vn-x">yo i make &#60;b&#62;reels&#60;/b&#62;</div>');
    const f = html("[file]", { attachments: JSON.stringify([{ type: "file", url: CDN, title: "<deck>.pdf" }]) });
    expect(f).toContain('href="/admin/media/7/0?dl=1"');
    expect(f).toContain("&#60;deck&#62;.pdf");
  });

  it("post and reel cards, story replies and mentions", () => {
    const own = html("[shared a reel]", {}, { parts: [{ type: "reel", id: "1", author: "yourhandle", link: "https://www.instagram.com/reel/abc/", title: "how i <edit>", preview: CDN }], reactions: [] });
    expect(own).toContain('<a class="mx-card" href="https://www.instagram.com/reel/abc/"');
    expect(own).toContain("@yourhandle");
    expect(own).toContain('<div class="mx-cap">how i &#60;edit&#62;</div>');
    const other = html("[shared a post]", { attachments: JSON.stringify([{ type: "post", url: CDN, title: "cap" }]) });
    expect(other).toContain("<b>Post</b>");
    expect(other).toContain('src="/admin/media/7/0/thumb"');
    // Someone else's post has no link: tapping it opens the chat on Instagram, never the raw image (a HEIC download).
    const inChat = html("[shared a post]", { mid: THREAD_MID, attachments: JSON.stringify([{ type: "post", url: CDN, title: "cap" }]) });
    expect(inChat).toContain(`<a class="mx-card" href="https://www.instagram.com/direct/t/${THREAD}/"`);
    expect(inChat).not.toContain('href="/admin/media/');
    expect(html("[shared a post]", { mid: THREAD_MID }, { parts: [], reactions: [] })).toContain("Open chat on Instagram ↗");
    // A webhook reel keeps its instagram.com link in `url`: still a link, even after Instagram stops detailing it.
    const reel = html("[shared a reel]", { attachments: JSON.stringify([{ type: "reel", url: "https://www.instagram.com/reel/abc/", id: "9" }]) }, { parts: [], reactions: [] });
    expect(reel).toContain('<a class="mx-card" href="https://www.instagram.com/reel/abc/"');
    expect(reel).toContain("View on Instagram ↗");
    expect(reel).not.toContain("Reel unavailable");
    const story = html("[replying to your story] fire", { attachments: JSON.stringify([{ type: "story_reply", url: CDN, id: "s" }]) });
    expect(story).toContain("Replied to your story");
    expect(story).toContain("Story unavailable"); // the fallback, shown if the thumbnail 404s
    expect(story.indexOf("mx-story")).toBeLessThan(story.indexOf('<div class="bb">fire</div>'));
    const mention = html("[mentioned you in their story]", { attachments: JSON.stringify([{ type: "story_mention", url: CDN }]) });
    expect(mention).toContain("Mentioned you in their story");
  });

  it("dead media shows labels without requests; reactions, edits, hearts, buttons, unsupported", () => {
    const dead = html("[image]", {}, { parts: [], reactions: [] });
    expect(dead).toContain('class="mx gone"');
    expect(dead).not.toContain("/admin/media/");
    const noMid = html("[audio]", { mid: null });
    expect(noMid).toContain("Voice message unavailable");
    expect(noMid).not.toContain("<audio");
    const rx = html("lol", { reactions: JSON.stringify({ lead: "\u{1F602}", you: "<x>" }), edited_at: T0 });
    expect(rx).toContain('<span class="rx">\u{1F602}&#60;x&#62;</span>');
    expect(rx).toContain("Edited");
    expect(html("[sent a heart]", { attachments: JSON.stringify([{ type: "like" }]) })).toContain("mx-like");
    const btn = html("grab it\n[buttons: Guide (https://x.co/g) | Not now]", { role: "bot", mid: "out-1" });
    expect(btn).toContain('<a class="mx-btn" href="https://x.co/g"');
    expect(btn).toContain('<span class="mx-btn">Not now</span>');
    expect(btn).toContain('<div class="t">grab it</div>');
    expect(html("[attachment]")).toContain("Sent an attachment");
    expect(html("[attachment]", {}, { parts: [{ type: "unsupported" }], reactions: [] })).toContain("be shown here");
  });

  it("conversation list previews stay short", () => {
    expect(previewText('[voice note] "long transcript"')).toBe("Sent a voice message");
    expect(previewText("[audio]")).toBe("Sent a voice message");
    expect(previewText("[image]")).toBe("Sent a photo");
    expect(previewText("[shared a reel]")).toBe("Shared a reel");
    expect(previewText("[shared a post]")).toBe("Shared a post");
    expect(previewText("[replying to your story] fire")).toBe("Replied to your story");
    expect(previewText("[mentioned you in their story]")).toBe("Mentioned you in their story");
    expect(previewText("[unsent a message]")).toBe("Unsent a message");
    expect(previewText("[tapped] Send it")).toBe("Send it");
    expect(previewText("hey [image] in the middle")).toBe("hey [image] in the middle");
    expect(previewText("grab it\n[buttons: A | B]")).toBe("grab it");
    expect(splitText('[voice note] "a" [image] hi').tags).toEqual([
      { tag: "voice note", note: "a" },
      { tag: "image", note: null },
    ]);
  });
});

describe("button cards (generic template)", () => {
  it("parses Manychat's card from the message API and draws it with its button", async () => {
    const { partsFromApi } = await import("../src/attachments");
    const parts = partsFromApi({
      id: "m1",
      attachments: {
        data: [
          {
            generic_template: {
              title: "yooooo what up it's the owner 👋\n\nJust tap the button below to get my FREE guide",
              cta: [{ title: "Send the Link! 🔗", type: "postback" }, { title: "Join", type: "web_url", url: "https://www.skool.com/your-community/about" }],
            },
          },
        ],
      },
    });
    expect(parts).toEqual([
      expect.objectContaining({
        type: "card",
        title: expect.stringContaining("what up it's the owner"),
        buttons: ["Send the Link! 🔗", "Join (https://www.skool.com/your-community/about)"],
      }),
    ]);
  });
});

describe("swipe-to-reply", () => {
  const echo = (message: Record<string, unknown>, at = T0) => hook([{ sender: { id: ME }, recipient: { id: LEAD }, timestamp: at, message: { is_echo: true, ...message } }]);

  it("reads reply_to.mid off their messages and our echoes, never off a story reply", () => {
    expect([...parseReplies(inbound({ mid: "m.2", text: "yes", reply_to: { mid: "m.1" } }))]).toEqual([["m.2", "m.1"]]);
    expect([...parseReplies(echo({ mid: "m.3", text: "bet", reply_to: { mid: "m.2" } }))]).toEqual([["m.3", "m.2"]]);
    expect(parseReplies(inbound({ mid: "m.4", text: "fire", reply_to: { story: { id: "s1", url: CDN } } })).size).toBe(0);
    expect(parseReplies(inbound({ mid: "m.5", text: "plain" })).size).toBe(0);
  });

  it("a reply sent from the IG app shows the message it quotes above it, like Instagram", async () => {
    const env = makeEnv();
    await addMessage(env, { text: "Can I not use sounds that are on youtube?", mid: "mid.q", at: T0 });
    await postHook(env, echo({ mid: "mid.r", text: "not if they're popular, they're probably copyrighted", reply_to: { mid: "mid.q" } }, T0 + 60_000));
    expect(await env.DB.prepare(`SELECT role, reply_to FROM messages WHERE mid = 'mid.r'`).first()).toEqual({ role: "bot", reply_to: "mid.q" });
    const page = await (await worker.fetch(asAdmin(`/admin/inbox/${LEAD}`), env, ctx)).text();
    const q = page.indexOf('class="rq bot"');
    expect(q).toBeGreaterThan(-1);
    expect(page.slice(q, q + 400)).toContain("You replied");
    expect(page.slice(q, q + 400)).toContain('data-to="mid.q"');
    expect(page.slice(q, q + 400)).toContain("Can I not use sounds that are on youtube?");
    expect(page.lastIndexOf("probably copyrighted")).toBeGreaterThan(q); // the reply itself comes after its quote (the first hit is the list preview)
  });

  it("their reply to one of ours, stored even when the webhook arrives before nothing else", async () => {
    const env = makeEnv();
    await addMessage(env, { text: "what do u make videos about", mid: "mid.ours", role: "bot", at: T0 });
    await postHook(env, inbound({ mid: "mid.theirs", text: "fitness mostly", reply_to: { mid: "mid.ours" } }));
    expect(await env.DB.prepare(`SELECT reply_to FROM messages WHERE mid = 'mid.theirs'`).first()).toEqual({ reply_to: "mid.ours" });
    const page = await (await worker.fetch(asAdmin(`/admin/inbox/${LEAD}`), env, ctx)).text();
    expect(page).toContain('class="rq lead"');
    expect(page).toMatch(/lead\.handle replied to you/);
  });

  it("labels: names, themselves, unsent, media and missing originals", () => {
    const lead = { role: "lead" as const, reply_to: "x" };
    const bot = { role: "bot" as const, reply_to: "x" };
    expect(quoteHtml(lead, { role: "bot", text: "hey", unsent_at: null }, "Sam")).toContain("Sam replied to you");
    expect(quoteHtml(lead, { role: "lead", text: "hey", unsent_at: null }, "Sam")).toContain("Sam replied to themself");
    expect(quoteHtml(bot, { role: "bot", text: "hey", unsent_at: null }, "Sam")).toContain("You replied to yourself");
    expect(quoteHtml(bot, { role: "lead", text: "<b>hi</b>", unsent_at: null }, "Sam")).not.toContain("<b>hi");
    expect(quoteHtml(bot, { role: "lead", text: '[image] "a dog"', unsent_at: null }, "Sam")).toContain(">Photo<");
    expect(quoteHtml(bot, { role: "lead", text: "[voice note]", unsent_at: null }, "Sam")).toContain(">Voice message<");
    expect(quoteHtml(bot, { role: "lead", text: "[unsent a message]", unsent_at: T0 }, "Sam")).toMatch(/class="rq bot gone".*Unsent message/);
    expect(quoteHtml(bot, null, "Sam")).toMatch(/class="rq bot gone".*You replied.*Message unavailable/);
    expect(quoteHtml({ role: "bot", reply_to: null }, null, "Sam")).toBe("");
  });
});
