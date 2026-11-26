import { describe, expect, it } from "vitest";
import { makeD1 } from "./d1shim";
import * as db from "../src/db";
import { furthestMove, refreshMoves } from "../src/moves";
import type { Env } from "../src/setter";

const L = (text: string) => ({ role: "lead", text });
const B = (text: string) => ({ role: "bot", text });

describe("furthest move from the thread", () => {
  it("a freebie link with no conversation is still just an opener", () => {
    expect(furthestMove([L("Send the Link! 🔗"), B("here's the FREE guide https://www.skool.com/your-community/about"), B("yoooo did you get a chance to check it out?")])).toBe("opener");
  });

  it("a question only counts once they answer it with real words", () => {
    expect(furthestMove([B("btw curious whats ur biz and what u got going on rn?")])).toBe("opener");
    expect(furthestMove([B("btw curious whats ur biz and what u got going on rn?"), L("Send the Link! 🔗")])).toBe("opener");
    expect(furthestMove([B("btw curious whats ur biz and what u got going on rn?"), L("I own a duct company")])).toBe("lead");
    expect(furthestMove([B("do u mind if i ask a couple questions?"), L("Sure")])).toBe("qualify");
  });

  it("pitch, then the link after the pitch, then a join from the DMs", () => {
    const t = [
      B("curious whats ur biz?"),
      L("dealership"),
      B("whats the biggest bottleneck in ur biz rn?"),
      L("follow ups"),
      B("thats literally what i help people with inside my community, would u be open to joining?"),
    ];
    expect(furthestMove(t)).toBe("pitch");
    expect(furthestMove([...t, L("yes"), B("https://www.skool.com/your-community/about")])).toBe("link_sent");
    expect(furthestMove([...t, L("yes"), B("https://www.skool.com/your-community/about")], true)).toBe("joined");
  });

  it("the cron reads leads active in the last 30 days and only re-reads ones whose thread changed", async () => {
    const d1 = makeD1();
    const now = 1_800_000_000_000;
    await db.recordInbound(d1, { subscriber_id: "a", username: "a", first_name: "A", text: "I own a duct company", mid: "m1" }, now - 1000);
    await d1.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES ('a', 'bot', 'whats ur biz?', ?1)`).bind(now - 2000).run();
    await d1.prepare(`UPDATE messages SET id = 0 WHERE role = 'bot'`).run(); // the question came first
    await db.recordInbound(d1, { subscriber_id: "old", username: "o", first_name: "O", text: "hey", mid: "m2" }, now - 40 * 86400000);
    const env = { DB: d1 } as unknown as Env;
    expect(await refreshMoves(env, now)).toBe(1);
    expect(await d1.prepare(`SELECT move FROM leads WHERE subscriber_id = 'a'`).first()).toEqual({ move: "lead" });
    expect(await d1.prepare(`SELECT move FROM leads WHERE subscriber_id = 'old'`).first()).toEqual({ move: null });
    expect(await refreshMoves(env, now + 10 * 60_000)).toBe(0); // nothing changed
  });

  it("a link bubble stamped earlier than the one before it still counts", async () => {
    const d1 = makeD1();
    const now = 1_800_000_000_000;
    const env = { DB: d1 } as unknown as Env;
    await db.recordInbound(d1, { subscriber_id: "a", username: "a", first_name: "A", text: "ok sure", mid: "m1" }, now - 60_000);
    await d1.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES ('a', 'bot', 'would u be open to joining?', ?1)`).bind(now - 50_000).run();
    await refreshMoves(env, now - 40_000); // the cron reads mid-send
    await d1.prepare(`INSERT INTO messages (subscriber_id, role, text, created_at) VALUES ('a', 'bot', 'heres the link https://www.skool.com/your-community/about', ?1)`).bind(now - 51_000).run();
    await refreshMoves(env, now);
    expect(await d1.prepare(`SELECT move FROM leads WHERE subscriber_id = 'a'`).first()).toEqual({ move: "link_sent" });
  });
});
