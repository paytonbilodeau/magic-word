import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { KNOWLEDGE } from "./knowledge";
import { SYSTEM_PROMPT } from "./prompt";
import type { Message } from "./db";
import type { Meter } from "./usage";
import { capAddress, leanedOn } from "./voice";

export const STAGES = ["opener", "lead", "qualify", "pitch", "link_sent", "joined", "closed"] as const;

export const Decision = z.object({
  action: z.enum(["reply", "stop", "react", "handoff", "flag"]),
  bubbles: z.array(z.string()),
  stage: z.enum(STAGES),
  note: z.string(),
});
export type Decision = z.infer<typeof Decision>;

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["reply", "stop", "react", "handoff", "flag"] },
    bubbles: { type: "array", items: { type: "string" } },
    stage: { type: "string", enum: [...STAGES] },
    note: { type: "string" },
  },
  required: ["action", "bubbles", "stage", "note"],
  additionalProperties: false,
};

// Asked instead of "Write your next move" when the bot spoke last and the lead went quiet.
export const FOLLOW_UP_ASK =
  "They haven't answered your last message in a few hours. Bump it with ONE tiny bubble, like \"?\" or \"yo did u see my last msg ^\" or \"u still around?\". Nothing else: no new question, no recap, never refer to what you asked (no \"no rush on that\"). Don't reuse a bump you already sent in this thread. If a nudge would be pushy or pointless, return action \"stop\" with no bubbles.";

export function renderTranscript(name: string | null, history: Message[], ask = "Write your next move.", customer: string | null = null, magnet: string | null = null, free: { id: number; name: string }[] = []): string {
  const lines = history.map((m) => `${m.role === "lead" ? "THEM" : "YOU"}: ${m.text}`);
  const guide = magnet ? `\nLead magnet: they asked for "${magnet}" ({{GUIDE_LINK}} sends its link)` : "";
  const catalog = free.length ? `\n\nFree stuff you can send when they ask for it:\n${free.map((m) => `- ${m.name}: {{GUIDE_LINK:${m.id}}}`).join("\n")}` : "";
  const worn = leanedOn(history);
  const skip = worn.length ? `\nWords you've leaned on lately (don't use them in this reply): ${worn.join(", ")}` : "";
  return `Lead: ${name || "unknown"}${customer ? `\nCustomer: ${customer}` : ""}${guide}${catalog}\n\nConversation so far (oldest first):\n${lines.join("\n")}\n${skip}\n${ask}`;
}

// Bubbles must never carry a raw URL or em dash; the link only goes out via the placeholder.
export function cleanBubbles(bubbles: string[]): string[] {
  return bubbles
    .map((b) => b.replace(/—/g, ",").replace(/\s+,/g, ",").trim())
    .filter((b) => b.length > 0)
    .slice(0, 4);
}

export async function decide(apiKey: string, name: string | null, history: Message[], ask?: string, customer: string | null = null, magnet: string | null = null, free: { id: number; name: string }[] = [], live = "", log?: Meter): Promise<Decision> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: DECISION_SCHEMA } },
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      { type: "text", text: KNOWLEDGE, cache_control: { type: "ephemeral" } },
      ...(live ? [{ type: "text" as const, text: live }] : []),
    ],
    messages: [{ role: "user", content: renderTranscript(name, history, ask, customer, magnet, free) }],
  });
  await log?.(response);
  if (response.stop_reason === "refusal") {
    return { action: "handoff", bubbles: [], stage: "lead", note: "model declined to answer this thread" };
  }
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const decision = Decision.parse(JSON.parse(text));
  return { ...decision, bubbles: capAddress(cleanBubbles(decision.bubbles), history) };
}
