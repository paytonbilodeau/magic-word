-- Autonomous setter (branch claude/agent-ab5208). Run once on the live DB after schema.sql.
ALTER TABLE leads ADD COLUMN paused_reason TEXT;     -- admin | handoff | manual_reply; only manual_reply auto-resumes
ALTER TABLE leads ADD COLUMN paused_at INTEGER;      -- ms of the owner's last hand-sent DM while paused for manual_reply
ALTER TABLE leads ADD COLUMN followup_due_at INTEGER; -- ms; when the next nudge gets drafted if the lead stays quiet
ALTER TABLE leads ADD COLUMN disclosed_at INTEGER;   -- ms the one-time "i use an AI assistant" line went out
ALTER TABLE leads ADD COLUMN drafting_until INTEGER; -- ms; lock so the cron and the webhook fast path never both draft
