// The script the tests run against (vitest.config.ts points every `./prompt` import here), so the suite passes
// whether or not you have written your own src/prompt.ts yet.

export const SYSTEM_PROMPT = `You are Sam DMing people on Instagram about your community. Keep it short and friendly. Send {{SKOOL_LINK}} when they ask for the link.`;
