import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { candidates, decideMatch, joinPath, nameScore, parseMember, recordJoin, syncJoins, type Member } from "../src/joins";
import type { Env } from "../src/setter";

const MIN = 60_000;
const T = 1_800_000_000_000; // the join

const member = (over: Partial<Member> = {}): Member => ({
  member_id: "m1",
  first: "Nils",
  last: "Hartmann",
  handle: "nils-hartmann-1234",
  joined_at: T,
  location: "manila (philippines)",
  source: "Instagram",
  ...over,
});

async function lead(d1: D1Database, id: string, name: string, username: string, at = T - 60 * MIN) {
  await db.recordInbound(d1, { subscriber_id: id, username, first_name: name, text: "hey", mid: `in-${id}` }, at);
}
const click = (d1: D1Database, id: string, at: number, country: string | null = null, city: string | null = null) =>
  d1.prepare(`INSERT INTO clicks (code, subscriber_id, created_at, country, city) VALUES ('c', ?1, ?2, ?3, ?4)`).bind(id, at, country, city).run();
const say = (d1: D1Database, id: string, role: string, text: string, at: number) =>
  d1.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(id, role, text, at).run();

describe("Skool member records", () => {
  it("reads the join time, location and the 'where did you hear' answer", () => {
    const m = parseMember({
      name: "wesley-k-4410",
      firstName: "Wesley",
      lastName: "P",
      member: {
        id: "c279",
        createdAt: "2026-10-29T01:40:21.225822Z",
        metadata: {
          requestLocation: "fairview (united states)",
          survey: JSON.stringify({ survey: [{ question: "Where did you hear about Your Community?", answer: "YouTube" }, { question: "Level?", answer: "Beginner" }] }),
        },
      },
    });
    expect(m).toEqual({ member_id: "c279", first: "Wesley", last: "P", handle: "wesley-k-4410", joined_at: Date.parse("2026-10-29T01:40:21.225Z"), location: "fairview (united states)", source: "YouTube" });
  });

  it("scores names against the Instagram name and handle", () => {
    expect(nameScore({ first: "Nils", last: "Hartmann" }, "Nils Hartmann", "zqvbluefox")).toBe(35);
    expect(nameScore({ first: "Desmond", last: "Van Den Berg" }, "Desmond", "velvet_rooms")).toBe(15);
    expect(nameScore({ first: "Tj", last: "Mouradian" }, "TJ", "tjmouradian")).toBe(15); // "tj" is too short to count
    expect(nameScore({ first: "Nils", last: "Hartmann" }, "Iron Bones (Studio)", "ironbonestudios")).toBe(0);
  });
});

describe("matching a join to a lead", () => {
  it("a click minutes before from the same city confirms it", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Desmond", "velvet_rooms");
    await lead(d1, "b", "Someone Else", "else");
    await click(d1, "a", T - 8 * MIN, "PH", "Manila");
    const m = decideMatch(await candidates(d1, member({ first: "Desmond", last: "Reyes" })));
    expect(m).toMatchObject({ subscriber_id: "a", confidence: "confirmed" });
    expect(m.evidence.join(" | ")).toMatch(/opened their Skool link 8 min before joining from Manila/);
  });

  it("no click: saying they joined plus their real name in the thread still confirms (the 'I'm Nils Hartmann' case)", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Arok", "zqvbluefox");
    await say(d1, "a", "bot", "check it out here https://www.skool.com/your-community/about", T - 3 * 60 * MIN);
    await say(d1, "a", "lead", "Landed and posted. I'm Nils Hartmann.", T + 5 * MIN);
    await say(d1, "a", "lead", "I joined the community and posted a short intro.", T + 2 * 60 * MIN);
    const m = decideMatch(await candidates(d1, member()));
    expect(m).toMatchObject({ subscriber_id: "a", confidence: "confirmed" });
  });

  it("a click alone, with no location to back it, names nobody (two leads clicked around the same time)", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "A", "a1");
    await lead(d1, "b", "B", "b1");
    await click(d1, "a", T - 10 * MIN);
    await click(d1, "b", T - 12 * MIN);
    await say(d1, "a", "bot", "skool.com/your-community", T - HOURS(1));
    expect(decideMatch(await candidates(d1, member({ first: "Zed", last: "Q" })))).toMatchObject({ subscriber_id: null, confidence: "none" });
  });

  it("a click from another country than the member's never matches (Jammu click vs a Phoenix joiner, 2026-10-29)", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Raghav Verma", "raghav_21");
    await say(d1, "a", "bot", "skool.com/your-community", T - HOURS(1));
    await click(d1, "a", T - 33 * MIN, "IN", "Jammu");
    const m = decideMatch(await candidates(d1, member({ first: "Chase", last: "Farber", location: "phoenix (united states)" })));
    expect(m).toMatchObject({ subscriber_id: null, confidence: "none" });
  });

  it("no evidence at all leaves the join unmatched", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Random Person", "rando");
    expect(decideMatch(await candidates(d1, member()))).toMatchObject({ subscriber_id: null, confidence: "none" });
  });

  it("a confirmed join marks the lead joined, tags them and stops nudges; the cron only looks every 10 minutes", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Nils Hartmann", "nilsh");
    await d1.prepare(`UPDATE leads SET followup_due_at = ?1 WHERE subscriber_id = 'a'`).bind(T + 60 * MIN).run();
    await click(d1, "a", T - 5 * MIN);
    const env = { DB: d1, SKOOL_AUTH_TOKEN: "tok" } as unknown as Env;
    let fetches = 0;
    const fetchMembers = async (_t: string, page: number) => (fetches++, page === 1 ? [member()] : []);
    expect(await syncJoins(env, T + 2 * MIN, fetchMembers)).toBe(1);
    expect(await syncJoins(env, T + 5 * MIN, fetchMembers)).toBe(0); // inside 10 min: no fetch
    expect(fetches).toBe(2); // page 1, then an empty page 2 ends the walk
    expect(await syncJoins(env, T + 13 * MIN, fetchMembers)).toBe(0); // already recorded
    const row = await d1.prepare(`SELECT subscriber_id, confidence FROM joins`).first();
    expect(row).toEqual({ subscriber_id: "a", confidence: "confirmed" });
    expect(await db.getLead(d1, "a")).toMatchObject({ stage: "joined", followup_due_at: null });
    expect(await d1.prepare(`SELECT tag FROM lead_tags WHERE subscriber_id = 'a'`).first()).toEqual({ tag: "member" });
  });

  it("chat that isn't about joining doesn't count, and one lead can't claim two joins", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Tyler", "swiftvisionsystems");
    await say(d1, "a", "bot", "https://www.skool.com/your-community/about", T - 60 * MIN);
    await say(d1, "a", "lead", "haha yah bet thats nice. Im in the AI Advising world lol", T + 5 * MIN);
    await say(d1, "a", "lead", "It's going well, just recently bought it for my portfolio", T + 6 * MIN);
    expect(decideMatch(await candidates(d1, member({ member_id: "x", first: "Luca", last: "De Santis" })))).toMatchObject({ confidence: "none" }); // "bought it" + link, but nothing says it's Luca
    await recordJoin(d1, member({ member_id: "x", first: "Tyler", last: "Swift" }), decideMatch(await candidates(d1, member({ member_id: "x", first: "Tyler", last: "Swift" }))), T);
    expect(decideMatch(await candidates(d1, member({ member_id: "y", first: "Jan", last: "Pedersen", joined_at: T + MIN })))).toMatchObject({ subscriber_id: null, confidence: "none" });
    const d2 = makeD1();
    await lead(d2, "b", "Tyler", "swiftvisionsystems");
    await say(d2, "b", "lead", "haha yah bet thats nice. Im in the AI Advising world lol", T + 5 * MIN);
    expect(decideMatch(await candidates(d2, member()))).toMatchObject({ confidence: "none" });
  });

  it("a full-name match with an Instagram 'where did you hear' answer confirms", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Alex Guba | Video Editor / Social Media Operator", "alexmediacrafts");
    expect(decideMatch(await candidates(d1, member({ first: "Alex", last: "Guba", source: "Instagram" })))).toMatchObject({ subscriber_id: "a", confidence: "confirmed" });
    expect(decideMatch(await candidates(d1, member({ first: "Alex", last: "Guba", source: "YouTube" })))).toMatchObject({ subscriber_id: "a", confidence: "likely" });
  });

  it("recording is idempotent", async () => {
    const d1 = makeD1();
    await recordJoin(d1, member(), { subscriber_id: null, score: 0, confidence: "none", evidence: [] }, T);
    await recordJoin(d1, member(), { subscriber_id: null, score: 0, confidence: "none", evidence: [] }, T);
    expect((await d1.prepare(`SELECT COUNT(*) n FROM joins`).first<{ n: number }>())!.n).toBe(1);
  });
});

function HOURS(n: number) {
  return n * 60 * MIN;
}

describe("nicknames", () => {
  it("a nickname plus 'just joined' right at the join confirms (Kuba = Jakub Nowak)", async () => {
    const d1 = makeD1();
    await lead(d1, "a", "Kuba Nowak", "kuba.nowak");
    await say(d1, "a", "bot", "https://www.skool.com/your-community/about", T - 60 * MIN);
    await say(d1, "a", "lead", "Yeah just joined", T + 2 * MIN);
    expect(decideMatch(await candidates(d1, member({ first: "Jakub", last: "Nowak", source: "Instagram" })))).toMatchObject({ subscriber_id: "a", confidence: "confirmed" });
  });
});

describe("how a join came about", () => {
  const thread = async (d1: D1Database, id: string, lines: [string, string][]) => {
    let t = T - lines.length * MIN;
    for (const [role, text] of lines) await say(d1, id, role, text, (t += MIN));
  };
  it("set: they talked, we pitched; asked: we only handed the link; self: no pitch", async () => {
    const d1 = makeD1();
    await thread(d1, "tj", [
      ["lead", "Send the Link! 🔗"],
      ["bot", "yoooo did you get a chance to watch the yt video? curious what you think"],
      ["lead", "Looks awesome I'm finishing it up now"],
      ["bot", "btw curious whats ur biz and what u got going on rn?"],
      ["lead", "I own a commercial air conditioning company"],
      ["bot", "thats literally what i help people with inside my community, would u be open to joining?"],
      ["lead", "Yes send it"],
      ["bot", "https://www.skool.com/your-community/about"],
    ]);
    await thread(d1, "dan", [
      ["lead", "Send the Link! 🔗"],
      ["bot", "here's the FREE Grokbot template 🎁"],
      ["bot", "[attachment]"],
      ["lead", "I'm going to buy your skool"],
      ["lead", "100%"],
      ["bot", "https://www.skool.com/your-community/about"],
      ["bot", "lets gooo heres the link, lmk when ur in!"],
      ["bot", "[attachment]"],
    ]);
    await thread(d1, "alex", [
      ["lead", "Send the Link! 🔗"],
      ["bot", "here's the FREE AI editing agency guide 🎁"],
      ["bot", "yoooo did you get a chance to check out the guide? curious what you think"],
      ["lead", "Building a Claude editing system rn"],
    ]);
    await thread(d1, "carlos", [
      ["lead", "not yet brother"],
      ["bot", "curious whats ur biz and what u got going on rn?"],
      ["lead", "I got a dealership"],
      ["bot", "thats dope having ur own dealership"],
    ]);
    expect(await joinPath(d1, "tj", T)).toBe("set");
    expect(await joinPath(d1, "dan", T)).toBe("asked");
    expect(await joinPath(d1, "alex", T)).toBe("self");
    expect(await joinPath(d1, "carlos", T)).toBe("self");
    expect(await joinPath(d1, "nobody", T)).toBe("self");
  });
});
