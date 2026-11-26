// What every Claude call cost, so spend is one D1 query instead of a trip to the Console (table ai_usage).
import type Anthropic from "@anthropic-ai/sdk";

// $ per million tokens: input, output, 5-minute cache write, cache read. Server-side fallbacks can answer from an older Opus.
const PRICES: Record<string, [number, number, number, number]> = { "claude-opus-5-5": [4, 20, 5, 0.2] };
const OLDER_OPUS: [number, number, number, number] = [5, 25, 6.25, 0.5];

type Usage = Pick<Anthropic.Beta.BetaUsage, "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens">;

// Tokens × $/MTok = millionths of a dollar.
export function costMicros(model: string, u: Usage): number {
  const [inp, out, write, read] = PRICES[model] ?? OLDER_OPUS;
  return Math.round(u.input_tokens * inp + u.output_tokens * out + (u.cache_creation_input_tokens ?? 0) * write + (u.cache_read_input_tokens ?? 0) * read);
}

export type Meter = (response: Pick<Anthropic.Beta.BetaMessage, "model" | "usage">) => Promise<void>;

// kind: reply | follow_up | learn | image. A failed insert never costs the lead their reply.
export const meter =
  (d1: D1Database, kind: string, lead: string | null = null): Meter =>
  async ({ model, usage: u }) => {
    await d1
      .prepare(
        `INSERT INTO ai_usage (created_at, kind, subscriber_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micros)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(Date.now(), kind, lead, model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0, costMicros(model, u))
      .run()
      .catch((e) => console.error("ai_usage insert:", e));
  };
