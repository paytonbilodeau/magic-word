-- Flows (branch claude/flows-96de47). Run once on the live DB, then run schema.sql again for the new tables
-- (flow_steps, flow_sends, flow_runs; all CREATE IF NOT EXISTS).
ALTER TABLE triggers ADD COLUMN source TEXT NOT NULL DEFAULT 'comment'; -- comment | dm | story (story reply) | mention (story mention) | welcome | none (only reached by a button)
ALTER TABLE triggers ADD COLUMN name TEXT;           -- shown in the admin; falls back to the keyword
ALTER TABLE triggers ADD COLUMN button_title TEXT;   -- optional URL button on the first message
ALTER TABLE triggers ADD COLUMN button_url TEXT;     -- {{SKOOL_LINK}} allowed; sent through /f/<send id> to count clicks
ALTER TABLE triggers ADD COLUMN next_title TEXT;     -- optional "continue" button: the rest of the flow waits for this tap
ALTER TABLE triggers ADD COLUMN quick_replies TEXT;  -- one per line, "Title" or "Title > automation name" to jump to that automation
