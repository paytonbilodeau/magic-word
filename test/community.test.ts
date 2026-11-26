import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { refreshCommunity, renderCommunity, type Community } from "../src/community";
import type { Env } from "../src/setter";

const NOW = Date.parse("2026-10-29T21:00:00Z"); // Thu 4pm Central
const HOUR = 3_600_000;
const zoom = '{"location_type":1,"location_info":"https://us06web.zoom.us/j/1"}';
const oh = (start: string, end: string) => ({
  startTime: start,
  endTime: end,
  metadata: { title: "📚 Office Hours", description: "Come ask questions, get support, and hang out with the crew!", location: zoom, timezone: "America/Chicago" },
});

const COMMUNITY: Community = {
  members: 694,
  daily: [123, 118, 113, 96, 101, 116, 127, 132],
  weekly: 366,
  events: [
    oh("2026-10-27T16:00:00-05:00", "2026-10-27T17:00:00-05:00"),
    oh("2026-10-29T16:00:00-05:00", "2026-10-29T17:00:00-05:00"),
    oh("2026-11-03T16:00:00-06:00", "2026-11-03T17:00:00-06:00"), // after the clocks change: still 4pm Central
    { startTime: "2026-11-05T18:30:00Z", endTime: "2026-11-05T20:00:00Z", metadata: { title: "Launch workshop", timezone: "America/Chicago" } },
    { startTime: "2026-10-01T18:00:00Z", endTime: "2026-10-01T19:00:00Z", metadata: { title: "Old one-off", timezone: "America/Chicago" } },
  ],
  courses: [{ metadata: { title: "Claude Video Editor ✂️", desc: "Fully Automated Claude Video Editing System", numModules: 5 } }, { metadata: { title: "Group Call Recordings", numModules: 55 } }, {}],
  tz: "America/Chicago",
};

describe("live community facts", () => {
  it("renders size, daily activity, the weekly call slots, upcoming one-offs and the classroom", () => {
    expect(renderCommunity(COMMUNITY, NOW)).toBe(
      [
        "# Live community facts (read from Skool Oct 29; these are current, answer from them)",
        "Members: 694. Active on a normal day: about 96-127 members (yesterday 123). Active in the last 7 days: 366.",
        "Group calls (times Central):",
        "- 📚 Office Hours: every Tue and Thu, 4-5pm on Zoom. Come ask questions, get support, and hang out with the crew!",
        "- Launch workshop: Thu Nov 5 at 12:30pm Central.",
        "Classroom (2 courses):",
        "- Claude Video Editor ✂️ (5 lessons): Fully Automated Claude Video Editing System",
        "- Group Call Recordings (55 lessons)",
      ].join("\n"),
    );
  });

  it("refreshes every 6 hours, and a failed read keeps the old facts and retries in 30 minutes", async () => {
    const env = { DB: makeD1(), SKOOL_AUTH_TOKEN: "tok" } as unknown as Env;
    let reads = 0;
    const ok = async () => (reads++, COMMUNITY);
    await refreshCommunity(env, NOW, ok);
    expect(await db.getSetting(env.DB, "community_facts")).toContain("every Tue and Thu, 4-5pm");
    await refreshCommunity(env, NOW + 5 * HOUR, ok);
    expect(reads).toBe(1);
    const broken = async (): Promise<Community> => (reads++, Promise.reject(new Error("skool down")));
    await expect(refreshCommunity(env, NOW + 6 * HOUR, broken)).rejects.toThrow("skool down");
    expect(await db.getSetting(env.DB, "community_facts")).toContain("every Tue and Thu, 4-5pm");
    await refreshCommunity(env, NOW + 6 * HOUR + 20 * 60_000, ok);
    expect(reads).toBe(2);
    await refreshCommunity(env, NOW + 6 * HOUR + 31 * 60_000, ok);
    expect(reads).toBe(3);
  });
});
