// Real people don't say the same word in every message; a model does. Two guards on the setter's word choice:
// its own recent bubbles are scanned for its pet words and the model is told to skip the ones it just leaned on, and
// calling them bro/brother is capped in code (the owner, 2026-10-29: "brother in like every line" in @dex.044's
// thread, where nearly every reply opened by rating what he said and ended in "brother").

import type { Message } from "./db";

// Word → how it shows up stretched or cased ("lmaooo", "yessirrr", "LETS GOOO").
const PET: [string, RegExp][] = [
  ["brother", /\bbrother\b/i],
  ["brotha", /\bbrotha\b/i],
  ["bro", /\bbro\b/i],
  ["broski", /\bbroski\b/i],
  ["G", /\bG\b/],
  ["fr", /\bfr\b/i],
  ["lowk", /\blowk(?:ey)?\b/i],
  ["ngl", /\bngl\b/i],
  ["tbh", /\btbh\b/i],
  ["asf", /\basf\b/i],
  ["sick", /\bsick\b/i],
  ["dope", /\bdope\b/i],
  ["insane", /\binsane\b/i],
  ["huge", /\bhuge\b/i],
  ["genius", /\bgenius\b/i],
  ["clutch", /\bclutch\b/i],
  ["crazy", /\bcrazy\b/i],
  ["next level", /\bnext level\b/i],
  ["literally", /\bliterally\b/i],
  ["respect", /\brespect\b/i],
  ["haha", /\bha(?:ha)+\b/i],
  ["lmao", /\blmao+\b/i],
  ["yessir", /\byes+i+r+\b/i],
  ["lets go", /\blets go+\b/i],
  ["W", /\bW\b/],
  ["bet", /\bbet+\b/i],
];
const ADDRESS = /^(?:brother|brotha|bro|broski)$/;

const ours = (history: Message[], n: number) => history.filter((m) => m.role === "bot").slice(-n).map((m) => m.text);

// Pet words in 2+ of our last 8 bubbles, and any bro/brother in our last 4: the model skips these this time.
export function leanedOn(history: Message[]): string[] {
  const recent = ours(history, 8);
  const last4 = recent.slice(-4);
  return PET.filter(([w, re]) => recent.filter((t) => re.test(t)).length >= 2 || (ADDRESS.test(w) && last4.some((t) => re.test(t)))).map(([w]) => w);
}

const LEAD_IN = /^(?:brother|brotha|broski|bro),?\s+/i;
const TAIL = /,?\s+(?:brother|brotha|broski|bro)(?=[\s!?.)]*$)/i;

// At most one bro/brother a reply, and none when one went out in our last 4 bubbles. Only the vocative spots (the start
// or end of a bubble) are touched, so "my bro Marco" stays.
export function capAddress(bubbles: string[], history: Message[]): string[] {
  let spent = ours(history, 4).some((t) => /\b(?:brother|brotha|broski|bro)\b/i.test(t));
  return bubbles
    .map((b) => {
      const named = LEAD_IN.test(b) || TAIL.test(b);
      if (!named) return b;
      if (spent) return b.replace(LEAD_IN, "").replace(TAIL, "").trim();
      spent = true;
      return b;
    })
    .filter(Boolean);
}
