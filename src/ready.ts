// What the AI needs before it can answer anyone: a finished script and an Anthropic API key. Everything else (the
// automations, the Inbox, Contacts, the numbers) runs without either, so a fresh install can go live with the AI's
// script still a template. Until both are there the AI can't be switched on and never drafts.

import { KNOWLEDGE } from "./knowledge";
import { SYSTEM_PROMPT } from "./prompt";

const TEMPLATE = /<<FILL/; // a blank left in the script or the product facts

// Why the AI can't run yet, in the console's words; null when it can.
export function aiBlocker(env: { ANTHROPIC_API_KEY?: string }, script: string = SYSTEM_PROMPT + KNOWLEDGE): string | null {
  if (TEMPLATE.test(script)) {
    return "The AI's script isn't written yet. Fill in the blanks in src/prompt.ts and src/knowledge.ts (what you sell, how you talk), then deploy again.";
  }
  if (!env.ANTHROPIC_API_KEY) return "The AI needs an Anthropic API key. Add ANTHROPIC_API_KEY to the Worker's secrets, then reload this page.";
  return null;
}
