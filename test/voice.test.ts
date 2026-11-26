import { describe, expect, it } from "vitest";
import { renderTranscript } from "../src/brain";
import type { Message } from "../src/db";
import { capAddress, leanedOn } from "../src/voice";

let id = 0;
const m = (role: "lead" | "bot", text: string): Message => ({ id: ++id, subscriber_id: "1", role, text, created_at: id, mid: null });

// The AI's side of @dex.044's thread, 20:11 to 20:13.
const DEX = [
  m("lead", "crazy I literally lost my job 4 months ago"),
  m("bot", "lost ur job 4 months ago and now ur closing 18k deals?? thats insane brother"),
  m("bot", "respect fr, locking in like that is rare"),
  m("lead", "My ai taught me sales bro so fuvked"),
  m("bot", "lmaooo ur AI taught u sales and now ur closing 18k deals"),
  m("bot", "thats literally the move brother, most people just ask it random questions"),
  m("lead", "We have objection sessions"),
  m("bot", "objection reps with an AI over and over is lowk genius brother"),
];

describe("word variety", () => {
  it("names the pet words the AI just leaned on, only from its own bubbles", () => {
    expect(leanedOn(DEX)).toEqual(["brother"]);
    expect(leanedOn([...DEX, m("bot", "fr thats insane"), m("bot", "lowk")])).toEqual(["brother", "fr", "lowk", "insane"]);
    expect(leanedOn([m("lead", "bro bro bro fr fr")])).toEqual([]);
  });

  it("the transcript tells the model to skip them", () => {
    expect(renderTranscript("Dex", DEX)).toContain("THEM: We have objection sessions\nYOU: objection reps with an AI over and over is lowk genius brother\n\nWords you've leaned on lately (don't use them in this reply): brother\nWrite your next move.");
    expect(renderTranscript("Sam", [m("lead", "hey")])).toContain("THEM: hey\n\nWrite your next move.");
  });

  it("drops bro/brother when one went out in the last 4 bubbles, and keeps only the first in a reply", () => {
    expect(capAddress(["thats sick brother", "bro how long u been at it?"], DEX)).toEqual(["thats sick", "how long u been at it?"]);
    const fresh = [m("bot", "yo"), m("bot", "whats up"), m("bot", "nice"), m("bot", "word")];
    expect(capAddress(["alright bet take care broski", "talk soon bro!"], fresh)).toEqual(["alright bet take care broski", "talk soon!"]);
    expect(capAddress(["my bro Marco runs the same setup", "brother"], DEX)).toEqual(["my bro Marco runs the same setup", "brother"]);
  });
});
