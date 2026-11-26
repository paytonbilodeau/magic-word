-- Automations follow-up (branch claude/automations-328baa). Run once on the live DB after automations.sql.
ALTER TABLE flow_sends ADD COLUMN seen_at INTEGER;   -- ms of the read receipt (messaging_seen) that covered it: Opened
-- Comment-to-DM sends from before flow tracking (old private replies) only live in the comments log. Give them the
-- run and first-message send the canvas counts (the message the When... node leads to; m0 = not converted yet), so
-- the When... and Send Message cards match the list's Runs. These two INSERTs are idempotent: safe to run again.
INSERT OR IGNORE INTO flow_starts (trigger_id, subscriber_id, status, created_at)
  SELECT trigger_id, subscriber_id, 'sent', MIN(created_at) FROM comments WHERE status = 'sent' AND trigger_id IS NOT NULL GROUP BY trigger_id, subscriber_id;
INSERT INTO flow_sends (trigger_id, node_id, part, subscriber_id, status, created_at)
  SELECT c.trigger_id,
    COALESCE((SELECT e.to_id FROM flow_edges e JOIN flow_nodes n ON n.trigger_id = e.trigger_id AND n.id = e.to_id
              WHERE e.trigger_id = c.trigger_id AND e.from_id = 'trigger' AND n.kind = 'message'), 'm0'),
    0, c.subscriber_id, 'sent', MIN(c.created_at) FROM comments c
  WHERE c.status = 'sent' AND c.trigger_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM flow_sends s WHERE s.trigger_id = c.trigger_id AND s.subscriber_id = c.subscriber_id)
  GROUP BY c.trigger_id, c.subscriber_id;
