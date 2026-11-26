// What the lead sent, turned into text the setter can read: voice notes and videos are transcribed (Deepgram Nova-3 on
// Workers AI, Whisper as the fallback), images, shared posts and the story they replied to are described by Claude
// vision, shared posts and reels carry their caption (and a reel's audio when Instagram hands us the video). The result
// goes right after the placeholder in the stored message, e.g. `[voice note] "<transcript>"`. Anything that fails keeps
// the plain placeholder, and the next draft tries again (enrichPending).

import Anthropic from "@anthropic-ai/sdk";
import type { Part, PartType } from "./attachments";
import { meter, type Meter } from "./usage";

const NOVA = "@cf/deepgram/nova-3"; // Instagram voice notes are HE-AAC in MP4, which Whisper can't decode
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const MAX_BYTES = 20 * 1024 * 1024;

// Instagram's media links answer a request with no User-Agent (a Worker's default) with a redirect to a web page.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function download(url: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const type = res.headers.get("Content-Type") ?? "";
  if (type.startsWith("text/")) return null; // a page, not the media
  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) return null;
  return { bytes, type };
}

const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

type NovaOut = { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };

async function hear(ai: Ai, file: { bytes: ArrayBuffer; type: string }): Promise<string | null> {
  try {
    const out = await (ai as unknown as { run: (model: string, input: unknown) => Promise<NovaOut> }).run(NOVA, { audio: { body: new Blob([file.bytes]).stream(), contentType: file.type || "audio/mp4" }, detect_language: true, smart_format: true });
    const text = out.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (text) return text;
  } catch (e) {
    console.error("nova-3 failed, trying whisper:", e);
  }
  const out = (await ai.run(WHISPER, { audio: b64(file.bytes) })) as { text?: string };
  return out.text?.trim() || null;
}

export async function transcribe(ai: Ai, url: string): Promise<string | null> {
  const file = await download(url);
  return file ? hear(ai, file) : null;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

const ASK = {
  image: "A lead sent this image in an Instagram DM to the owner of this Instagram account. In one or two short sentences, say what it shows, including any readable text. Description only.",
  post: "A lead shared this Instagram post in a DM to the owner of this Instagram account. In one or two short sentences, say what it shows, including any readable text. Description only.",
  story: "This is the creator's own Instagram story, which a lead just replied to in a DM. In one short sentence, say what it shows, including any readable text. Description only.",
};
type Look = keyof typeof ASK;

export async function describeImage(apiKey: string, url: string, look: Look = "image"): Promise<string | null> {
  const file = await download(url);
  if (!file) return null;
  return see(apiKey, file, look);
}

async function see(apiKey: string, file: { bytes: ArrayBuffer; type: string }, look: Look, log?: Meter): Promise<string | null> {
  const type = IMAGE_TYPES.find((t) => file.type.startsWith(t)) ?? "image/jpeg";
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: type, data: b64(file.bytes) } },
          { type: "text", text: ASK[look] },
        ],
      },
    ],
  });
  await log?.(response);
  if (response.stop_reason === "refusal") return null;
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  return text || null;
}

// Whatever a URL turns out to be: a picture is described, a video or audio is transcribed, anything else (a web page) is
// nothing we can read.
export async function inspect(env: MediaEnv, url: string, look: Look): Promise<string | null> {
  const file = await download(url);
  if (!file) return null;
  // Reading pictures is Claude's job: without a key they keep their bare [image] label (voice notes still transcribe).
  if (file.type.startsWith("image/")) return env.ANTHROPIC_API_KEY ? see(env.ANTHROPIC_API_KEY, file, look, env.DB && meter(env.DB, "image")) : null;
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) return hear(env.AI, file);
  return null;
}

export interface MediaEnv {
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  DB?: D1Database; // logs what each image read cost
}
export interface Senses {
  listen: (url: string) => Promise<string | null>;
  look: (url: string, look: Look) => Promise<string | null>; // a picture described, a video's speech transcribed
}
export const senses = (env: MediaEnv): Senses => ({ listen: (url) => transcribe(env.AI, url), look: (url, look) => inspect(env, url, look) });

const TAG: Partial<Record<PartType, string>> = {
  audio: "[voice note]",
  image: "[image]",
  sticker: "[image]",
  video: "[video]",
  post: "[shared a post]",
  reel: "[shared a reel]",
  story_reply: "[replying to your story]",
};
const quote = (s: string, max = 500) => `"${s.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, max)}"`;
const filledAt = (text: string, end: number) => text.startsWith(' "', end) || text.startsWith(" (", end);

// Placeholders still waiting on their media (nothing filled in after them).
export const pendingMedia = (text: string, parts: Part[]) =>
  parts.some((p) => {
    const tag = TAG[p.type];
    if (!tag) return false;
    const at = text.indexOf(tag);
    return at >= 0 && !filledAt(text, at + tag.length) && Boolean(p.url || p.title);
  });

async function note(p: Part, sense: Senses): Promise<string | null> {
  const url = p.url ?? null;
  const caption = p.title?.trim() ? `caption: ${quote(p.title)}` : null;
  switch (p.type) {
    case "audio":
    case "video": {
      const said = url ? await sense.listen(url) : null;
      return said ? ` ${quote(said, 2000)}` : null;
    }
    case "image":
    case "sticker": {
      const seen = url ? await sense.look(url, "image") : null;
      return seen ? ` ${quote(seen)}` : null;
    }
    case "post": {
      const seen = url ? await sense.look(url, "post") : null;
      const bits = [caption, seen && `shows: ${quote(seen)}`].filter(Boolean);
      return bits.length ? ` (${bits.join("; ")})` : null;
    }
    case "reel": {
      const said = url ? await sense.look(url, "post") : null; // a CDN video when Instagram gives one; a page link reads as nothing
      const bits = [caption, said && `content: ${quote(said, 1500)}`].filter(Boolean);
      return bits.length ? ` (${bits.join("; ")})` : null;
    }
    case "story_reply": {
      const seen = url ? await sense.look(url, "story") : null;
      return seen ? ` (your story: ${quote(seen)})` : null;
    }
    default:
      return null;
  }
}

// The message text with each part's transcript / description / caption filled in after its placeholder. Parts and
// placeholders come in the same order; a placeholder that's already filled is skipped.
export async function enrichText(text: string, parts: Part[], sense: Senses): Promise<string> {
  let from = 0;
  for (const p of parts) {
    const tag = TAG[p.type];
    if (!tag) continue;
    const at = text.indexOf(tag, from);
    if (at < 0) continue;
    const end = at + tag.length;
    from = end;
    if (filledAt(text, end)) continue;
    let got: string | null = null;
    try {
      got = await note(p, sense);
    } catch (e) {
      console.error(`${tag} failed:`, e);
    }
    if (!got) continue;
    text = text.slice(0, end) + got + text.slice(end);
    from = end + got.length;
  }
  return text;
}

// Before a draft: anything the lead sent lately that the webhook couldn't read yet (a sync-imported message, a hiccup)
// gets another go. Recent only, and a few at most, so a dead link can't slow every reply down.
export async function enrichPending(env: MediaEnv & { DB: D1Database }, lead: string, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, text, attachments FROM messages WHERE subscriber_id = ?1 AND role = 'lead' AND attachments IS NOT NULL AND created_at > ?2 ORDER BY id DESC LIMIT 3`,
  )
    .bind(lead, now - 24 * 60 * 60 * 1000)
    .all<{ id: number; text: string; attachments: string }>();
  for (const m of results) {
    const parts = JSON.parse(m.attachments) as Part[];
    if (!pendingMedia(m.text, parts)) continue;
    const text = await enrichText(m.text, parts, senses(env));
    if (text !== m.text) await env.DB.prepare(`UPDATE messages SET text = ?2 WHERE id = ?1`).bind(m.id, text).run();
  }
}
