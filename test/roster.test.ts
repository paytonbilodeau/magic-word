import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { renderTranscript } from "../src/brain";
import { customerLine, igHandle, matchRoster, parseRosterUser, saveRoster, tagLeads, type RosterRow } from "../src/roster";

const T = 1_800_000_000_000;

const row = (over: Partial<RosterRow> = {}): RosterRow => ({
  member_id: "m1",
  name: "Nils Hartmann",
  fullname: "nils hartmann",
  handle: "nils-hartmann-1234",
  ig: null,
  status: "active",
  joined_at: T - 90 * 86_400_000,
  left_at: null,
  ltv_cents: 22_500,
  ...over,
});
const lead = (d1: D1Database, id: string, name: string, username: string) =>
  db.recordInbound(d1, { subscriber_id: id, username, first_name: name, text: "hey", mid: `in-${id}` }, T);
const tags = async (d1: D1Database, id: string) =>
  (await d1.prepare(`SELECT tag FROM lead_tags WHERE subscriber_id = ?1 ORDER BY tag`).bind(id).all<{ tag: string }>()).results.map((r) => r.tag);

describe("Skool roster", () => {
  it("reads the Instagram handle off any shape of profile link", () => {
    expect(igHandle("https://www.instagram.com/_zebrazed/")).toBe("_zebrazed");
    expect(igHandle("http://www.instagram.com/mira.visuals")).toBe("mira.visuals");
    expect(igHandle("instagram.com/Some.One?igsh=abc123")).toBe("some.one");
    expect(igHandle("@handle")).toBe("handle");
    expect(igHandle("https://linktr.ee/someone")).toBeNull();
    expect(igHandle(undefined)).toBeNull();
  });

  it("parses a churned member with when they left (Skool gives nanoseconds) and what they paid", () => {
    const r = parseRosterUser(
      {
        name: "luca-f",
        firstName: "Luca",
        lastName: "Fratelli",
        metadata: { linkInstagram: "https://www.instagram.com/lucafratelli/" },
        member: { id: "x9", approvedAt: "2026-09-11T11:11:36Z", metadata: { removedAt: 1793258352082498000, mbsltv: 7500 } },
      },
      "churned",
    );
    expect(r).toMatchObject({ member_id: "x9", fullname: "luca fratelli", ig: "lucafratelli", status: "churned", left_at: 1793258352082, ltv_cents: 7500 });
  });

  it("matches on the Instagram link, a verified join, or a unique exact full name, and tags member / churned", async () => {
    const d1 = makeD1();
    await lead(d1, "L-ig", "Different Name", "lucafratelli");
    await lead(d1, "L-join", "Ali", "ali.edits");
    await lead(d1, "L-name", "Nils Hartmann", "nhartmann");
    await lead(d1, "L-dup1", "Sam Lee", "sam1");
    await lead(d1, "L-dup2", "Sam Lee", "sam2");
    await lead(d1, "L-first", "Marcus", "marcus");
    await lead(d1, "L-fancy", "𝑮𝒂𝒆𝒍 𝑴𝒐𝒓𝒆𝒏𝒐", "gaelm09");
    await d1.prepare(`INSERT INTO joins (member_id, joined_at, subscriber_id, confidence, created_at) VALUES ('m-join', ?1, 'L-join', 'confirmed', ?1)`).bind(T).run();
    await saveRoster(
      d1,
      [
        row({ member_id: "m-ig", name: "Luca F", fullname: "luca f", ig: "lucafratelli", status: "churned", left_at: T - 86_400_000 }),
        row({ member_id: "m-join", name: "Omar Haddad", fullname: "omar haddad" }),
        row({ member_id: "m-name" }),
        row({ member_id: "m-dup", name: "Sam Lee", fullname: "sam lee" }), // two leads share the name: no match
        row({ member_id: "m-first", name: "Marcus", fullname: "marcus" }), // one word: never enough
        row({ member_id: "m-fancy", name: "Gael Moreno", fullname: "gael moreno", status: "churned" }), // fancy Unicode on Instagram
      ],
      T,
    );
    const matched = await matchRoster(d1, T);
    expect(matched.sort()).toEqual(["L-fancy", "L-ig", "L-join", "L-name"]);
    const how = (await d1.prepare(`SELECT member_id, matched_by FROM roster WHERE subscriber_id IS NOT NULL ORDER BY member_id`).all()).results;
    expect(how).toEqual([
      { member_id: "m-fancy", matched_by: "name" },
      { member_id: "m-ig", matched_by: "ig" },
      { member_id: "m-join", matched_by: "join" },
      { member_id: "m-name", matched_by: "name" },
    ]);
    await tagLeads(d1, matched, T);
    expect(await tags(d1, "L-ig")).toEqual(["churned"]);
    expect(await tags(d1, "L-name")).toEqual(["member"]);
    expect(await tags(d1, "L-dup1")).toEqual([]);

    // Unmatched members are re-checked at most daily.
    expect(await matchRoster(d1, T + 60_000)).toEqual([]);

    // Nils cancels: the next roster read lists him under churned, and his tag flips.
    const touched = await saveRoster(d1, [row({ member_id: "m-name", status: "churned", left_at: T + 1000 })], T + 2000);
    expect(touched).toEqual(["L-name"]);
    await tagLeads(d1, touched, T + 2000);
    expect(await tags(d1, "L-name")).toEqual(["churned"]);
  });

  it("tells the setter who's a member, who left, and nothing for a prospect", async () => {
    const d1 = makeD1();
    await saveRoster(
      d1,
      [
        row({ member_id: "a", ig: "in.now", joined_at: Date.UTC(2026, 8, 3) }),
        row({ member_id: "c", name: "Gone Guy", fullname: "gone guy", ig: "gone.guy", status: "churned", joined_at: Date.UTC(2026, 5, 1), left_at: Date.UTC(2026, 8, 20), ltv_cents: 15000 }),
      ],
      T,
    );
    await lead(d1, "A", "x", "in.now");
    await lead(d1, "C", "y", "gone.guy");
    await lead(d1, "P", "z", "prospect");
    await matchRoster(d1, T);
    expect(await customerLine(d1, "A")).toBe("already a paying member of Your Community (joined Sep 2026)");
    expect(await customerLine(d1, "C")).toBe("former member of Your Community: joined Jun 2026, left Sep 2026, paid $150 in total");
    expect(await customerLine(d1, "P")).toBeNull();
    // A verified DM join counts before the roster catches up.
    await d1.prepare(`INSERT INTO lead_tags (subscriber_id, tag, created_at) VALUES ('P', 'member', 1)`).run();
    expect(await customerLine(d1, "P")).toBe("already a paying member of Your Community");
    expect(renderTranscript("Sam", [], "Write your next move.", "already a paying member of Your Community")).toContain("Lead: Sam\nCustomer: already a paying member");
  });
});
