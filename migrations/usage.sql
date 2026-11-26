-- Token and dollar cost of every Claude call (src/usage.ts). Run: npx wrangler d1 execute dm-setter --remote --file migrations/usage.sql
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,             -- ms
  kind TEXT NOT NULL,                      -- reply | follow_up | learn | image | console (spend before logging, from the Console)
  subscriber_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, -- thinking included
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL              -- millionths of a dollar
);
CREATE INDEX IF NOT EXISTS ai_usage_by_time ON ai_usage (created_at);
