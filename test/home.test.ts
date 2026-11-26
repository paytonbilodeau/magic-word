import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";

import { lineChart, niceStep } from "../src/charts";
import * as db from "../src/db";
import { homeWindow } from "../src/home";
import worker from "../src/index";
import type { Env } from "../src/setter";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function makeEnv(): Env {
  return {
    DB: makeD1(),
    ANTHROPIC_API_KEY: "test",
    MANYCHAT_API_KEY: "mc",
    INBOUND_SECRET: "s",
    ADMIN_PASSWORD: "pw",
    REVIEW_PASSWORD: "rv",
    AI: {} as Ai,
    SKOOL_LINK: "https://www.skool.com/your-community/about",
    AUTOPILOT: "false",
    REPLY_DELAY_MIN_S: "0",
    REPLY_DELAY_MAX_S: "0",
    TRANSPORT: "meta",
    META_IG_APP_ID: "100000000000001",
    META_APP_SECRET: "appsecret",
    META_VERIFY_TOKEN: "vt",
  };
}
const as = (pw: string, path: string, cookie = "") => new Request(`https://x${path}`, { headers: { Authorization: `Basic ${btoa(`me:${pw}`)}`, ...(cookie ? { Cookie: cookie } : {}) } });
const get = async (env: Env, path: string, pw = "pw", cookie = "") => (await worker.fetch(as(pw, path, cookie), env, ctx)).text();
// A tile's number and the line under it.
const tile = (html: string, label: string) => {
  const m = html.match(new RegExp(`<div class="lbl">${label}</div><b>([^<]*)</b><small[^>]*>(.*?)</small>`, "s"));
  return m ? [m[1], m[2].replace(/<svg.*?<\/svg>/s, "")] : null;
};
const inbound = (env: Env, id: string, text: string, at: number) => db.recordInbound(env.DB, { subscriber_id: id, username: `user${id}`, first_name: null, text, mid: `m${id}-${at}` }, at);

// Automation 5 (a comment keyword) DMs four people this week, one last week. This week: two opened, two tapped (one of
// them a link), one replied; a tap isn't a reply. Last week's person did nothing.
async function seed(env: Env, now: number) {
  const D = env.DB;
  await D.prepare(`INSERT INTO triggers (id, source, keyword, name, dm, enabled, created_at) VALUES (5, 'comment', 'GUIDE', 'Free guide', 'here', 1, 1)`).run();
  const send = async (id: number, lead: string, at: number, extra: { seen?: boolean; urls?: string } = {}) => {
    await inbound(env, lead, "GUIDE pls", at - MIN);
    await D.prepare(`INSERT INTO flow_starts (trigger_id, subscriber_id, status, created_at) VALUES (5, ?1, 'sent', ?2)`).bind(lead, at).run();
    await D.prepare(`INSERT INTO flow_sends (id, trigger_id, subscriber_id, status, node_id, urls, seen_at, created_at) VALUES (?1, 5, ?2, 'sent', 'm0', ?3, ?4, ?5)`)
      .bind(id, lead, extra.urls ?? null, extra.seen ? at + MIN : null, at)
      .run();
  };
  await send(1, "1", now - 2 * HOUR, { seen: true, urls: JSON.stringify({ go: "https://example.com" }) });
  await send(2, "2", now - 3 * HOUR, { seen: true });
  await send(3, "3", now - 4 * HOUR);
  await send(4, "4", now - 5 * HOUR);
  await send(9, "9", now - 9 * DAY);
  await D.prepare(`INSERT INTO flow_taps (send_id, port, created_at) VALUES (1, 'go', ?1), (2, 'nx', ?1)`).bind(now - HOUR).run();
  await inbound(env, "2", "[tapped] Send it", now - HOUR); // the tap lands as a lead message: not a reply, not a message
  await inbound(env, "3", "thanks this is great", now - HOUR);
}

describe("home", () => {
  it("counts messages, people and what they did with the automation DMs, against the week before", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seed(env, now);
    const html = await get(env, "/admin/dashboard");
    expect(tile(html, "Messages received")).toEqual(["5", "+400%"]); // 4 comments-turned-DMs + 1 reply; the tap isn't one
    expect(tile(html, "People who messaged")).toEqual(["4", "+300%"]);
    expect(tile(html, "Automation reach")).toEqual(["4", "+300%"]);
    expect(tile(html, "Reply rate")).toEqual(["25%", "+25 pts"]);
    expect(tile(html, "Click-through rate")).toEqual(["50%", "+50 pts"]);
    // The funnel: share of the four who got a DM.
    const row = (label: string) => html.match(new RegExp(`<div class="fb-l">${label}.*?<b>(\\d+)</b>([^<]*)`, "s"))?.slice(1);
    expect(row("Got an automation DM")).toEqual(["4", "100%"]);
    expect(row("Opened it")).toEqual(["2", "50%"]);
    expect(row("Tapped a button")).toEqual(["2", "50%"]);
    expect(row("Opened a link button")).toEqual(["1", "100%"]); // of the one person whose DM had a link button
    expect(html).toContain("of 1 who got one");
    expect(html).not.toContain("Link opens aren't shown");
    expect(row("Replied")).toEqual(["1", "25%"]);
    // Ranked automations and what started them.
    expect(html).toMatch(/<a class="nm" href="\/admin\/flows\/5">Free guide<\/a><small>Comment keyword · GUIDE · Live<\/small><\/td>\s*<td class="r">4<\/td><td class="r wide">50%<\/td><td class="r wide">2<\/td><td class="r">50%<\/td>/);
    expect(row("Comment keyword")).toEqual(["4", "100%"]);
    expect(html).toContain("<b>5</b> contacts");
    expect(html).toContain("Arrows compare with the 7 days before");
    expect(html).toContain("<b>1</b> automations live");
    expect(html).not.toMatch(/AI messages|Handoffs|Skool/); // the setter has its own page

    const all = await get(env, "/admin/dashboard?range=all");
    expect(tile(all, "Automation reach")).toEqual(["5", "All time"]);
    expect(tile(all, "Reply rate")).toEqual(["20%", "All time"]);
  });

  it("the reviewer sees test threads only, and an empty account reads as empty, not broken", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seed(env, now);
    await inbound(env, "77", "SETTERTEST hello", now - MIN);
    const rv = await get(env, "/admin/dashboard", "rv");
    expect(tile(rv, "People who messaged")?.[0]).toBe("1");
    expect(tile(rv, "Automation reach")?.[0]).toBe("0");
    expect(tile(rv, "Reply rate")?.[0]).toBe("–");
    expect(rv).toContain("No automation DMs went out in this range.");
    // Links typed into the text can't be counted: say so instead of showing a zero.
    await env.DB.prepare(`UPDATE flow_sends SET urls = NULL`).run();
    const typed = await get(env, "/admin/dashboard");
    expect(typed).toContain("Link opens aren't shown");
    expect(typed).not.toContain("Opened a link button");
    expect(rv).not.toContain("Delivery problems");

    const empty = await get(makeEnv(), "/admin/dashboard");
    expect(tile(empty, "Messages received")).toEqual(["0", "No change"]);
    expect(empty).toContain("No messages in this range yet.");
    expect(empty).toContain("Nothing ran in this range.");
  });

  it("days are the viewer's days: the tz cookie moves the buckets", () => {
    const now = Date.UTC(2026, 10, 24, 3); // 03:00 UTC = still Nov 23 in Chicago (UTC-6)
    const utc = homeWindow("7d", now, 0);
    const chi = homeWindow("7d", now, 360);
    expect(new Date(utc.since).toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(new Date(chi.since).toISOString()).toBe("2026-11-17T06:00:00.000Z"); // local midnight, six days before "today"
    expect(chi.prev).toBe(chi.since - 7 * DAY);
    expect(homeWindow("all", now, 360)).toMatchObject({ since: 0, prev: null, days: null });
  });
});

describe("charts", () => {
  it("gridlines land on round numbers", () => {
    expect([0, 3, 4, 7, 19, 40, 95, 101, 1234].map((v) => niceStep(v))).toEqual([1, 1, 1, 2, 5, 10, 25, 50, 500]);
  });

  it("draws every series, labels the axes, and says so when there's nothing", () => {
    const svg = lineChart(
      [
        { name: "Received", color: "var(--pri)", values: [0, 8, 4], fill: true },
        { name: "Sent <b>", color: "#777", values: [2, 2, 2] },
      ],
      ["Nov 22", "Nov 23", "Nov 24"],
      { label: "Messages per day", empty: "Nothing yet" },
    );
    expect(svg.match(/<polyline/g)).toHaveLength(2);
    expect(svg).toContain('points="0,100 500,0 1000,50"'); // 8 is the top gridline
    expect(svg).toContain("<span>8</span><span>6</span><span>4</span><span>2</span><span>0</span>");
    expect(svg).toContain("<span>Nov 22</span><span>Nov 23</span><span>Nov 24</span>");
    expect(svg).toContain("Sent &#60;b&#62;"); // names are data
    const none = lineChart([{ name: "Received", color: "red", values: [0, 0] }], ["a", "b"], { label: "x", empty: "Nothing yet" });
    expect(none).toContain('<div class="lc-none">Nothing yet</div>');
    expect(none).not.toContain("<polyline");
  });
});

describe("the shell and its other pages", () => {
  it("the sidebar is Home, Contacts, Automation, AI, Inbox, Settings, then the collapse button, My Profile and the light / dark toggle", async () => {
    const env = makeEnv();
    const html = await get(env, "/admin/contacts");
    expect([...html.matchAll(/<a class="nv[^"]*" href="([^"]+)" title="([^"]+)"/g)].map((m) => `${m[2]} ${m[1]}`)).toEqual([
      "Home /admin/dashboard",
      "Contacts /admin/contacts",
      "Automation /admin/automations",
      "AI /admin/ai",
      "Inbox /admin/inbox",
      "Settings /admin/settings",
      "My Profile /admin/profile",
    ]);
    // The last thing in the sidebar is the light / dark toggle; Help is reached from My Profile.
    expect(html.indexOf('onclick="flipTheme()"')).toBeGreaterThan(html.indexOf('title="My Profile"'));
    expect(html).toMatch(/<button type="button" class="nv" onclick="flipTheme\(\)"[^>]*>.*Dark mode.*Light mode.*<\/button><\/div><\/aside>/s);
    expect(html).not.toContain('title="Help"');
    expect(html).toContain('<a class="nv on" href="/admin/contacts" title="Contacts" aria-current="page">');
    expect(html.indexOf('aria-label="Collapse navigation"')).toBeGreaterThan(html.indexOf('title="Settings"'));
    expect(html.indexOf('aria-label="Collapse navigation"')).toBeLessThan(html.indexOf('title="My Profile"'));
    expect(html).toContain("<h1>Contacts</h1>");
    // The connected account, once Instagram has told us who it is (cached, so pages don't wait on Instagram).
    await db.setSetting(env.DB, "ig_profile", JSON.stringify({ username: "yourhandle", name: "Sam <Lee>", pic: null, at: Date.now() }));
    const named = await get(env, "/admin/help");
    expect(named).toContain("Sam &#60;Lee&#62;<small>@yourhandle</small>");
    expect(named).toContain("Why didn't a DM send?");
    const profile = await get(env, "/admin/profile");
    expect(profile).toContain('href="/logout"');
    expect(profile).toContain('href="/admin/help"');
    expect(profile).toContain('data-theme-btn="dark"');
    expect(await get(env, "/admin/profile", "rv")).not.toContain("/auth/start");
  });

  it("contacts: newest activity first, searchable, filtered by tag, test threads only for the reviewer", async () => {
    const env = makeEnv();
    const now = Date.now();
    await db.recordInbound(env.DB, { subscriber_id: "1", username: "alpha", first_name: "Alpha One", text: "hi", mid: "a" }, now - 3 * HOUR);
    await db.recordInbound(env.DB, { subscriber_id: "2", username: "beta_two", first_name: null, text: "yo", mid: "b" }, now - HOUR);
    await db.recordInbound(env.DB, { subscriber_id: "3", username: "gamma", first_name: null, text: "SETTERTEST", mid: "c" }, now - 2 * HOUR);
    await env.DB.prepare(`INSERT INTO lead_tags (subscriber_id, tag, created_at) VALUES ('1', 'buyer', 1), ('1', 'hot', 1), ('3', 'buyer', 1)`).run();
    await env.DB.prepare(`INSERT INTO leads (subscriber_id, members, created_at) VALUES ('g:9', '[]', 1)`).run(); // a group chat isn't a contact
    const names = (html: string) => [...html.matchAll(/<a class="ct-row" href="\/admin\/inbox\/(\w+)"/g)].map((m) => m[1]);
    const all = await get(env, "/admin/contacts");
    expect(names(all)).toEqual(["2", "3", "1"]);
    expect(all).toContain("3 contacts");
    expect(all).toContain("<b>Alpha One</b><small>@alpha</small>");
    expect(all).toMatch(/<span>buyer<\/span><span>2<\/span>/);
    expect(names(await get(env, "/admin/contacts?tag=buyer"))).toEqual(["3", "1"]);
    expect(names(await get(env, "/admin/contacts?q=%40beta_"))).toEqual(["2"]); // _ is a literal, not a wildcard
    expect(names(await get(env, "/admin/contacts?q=one"))).toEqual(["1"]);
    expect(await get(env, "/admin/contacts?q=zzz")).toContain("Nobody matches");
    expect(names(await get(env, "/admin/contacts", "rv"))).toEqual(["3"]);
  });

  it("each settings form saves its own section and leaves the other alone", async () => {
    const env = makeEnv();
    const post = (form: Record<string, string>) =>
      worker.fetch(new Request("https://x/admin/settings", { method: "POST", body: new URLSearchParams(form), headers: { Authorization: `Basic ${btoa("me:pw")}` } }), env, ctx);
    const { getConfig } = await import("../src/settings");
    await post({ autopilot: "true", skool_link: "https://example.com/a", track_links: "true", pause_on_manual_reply: "true", auto_resume_hours: "4", reply_delay_min_s: "1", reply_delay_max_s: "2" });
    const ai = await post({ section: "ai", auto_resume_hours: "9", reply_delay_min_s: "3", reply_delay_max_s: "5" });
    expect(ai.headers.get("Location")).toBe("https://x/admin/ai?saved=1");
    expect(await getConfig(env)).toEqual({ autopilot: true, skool_link: "https://example.com/a", track_links: true, pause_on_manual_reply: false, auto_resume_hours: 9, reply_delay_min_s: 3, reply_delay_max_s: 5 });
    const general = await post({ section: "general", skool_link: "https://example.com/b" });
    expect(general.headers.get("Location")).toBe("https://x/admin/settings?saved=1");
    expect(await getConfig(env)).toEqual({ autopilot: true, skool_link: "https://example.com/b", track_links: false, pause_on_manual_reply: false, auto_resume_hours: 9, reply_delay_min_s: 3, reply_delay_max_s: 5 });
  });
});
