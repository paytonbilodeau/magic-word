-- Automations page + node-graph flows (branch claude/automations-328baa). Run once on the live DB AFTER schema.sql
-- (it fills the new flow_starts / flow_taps tables). The graphs themselves are built from the old columns and
-- flow_steps the first time each automation is loaded (graph.ts ensureGraph), with the ids used below.
ALTER TABLE triggers ADD COLUMN draft TEXT;          -- the editor's unpublished graph (JSON); NULL = no changes since publish
ALTER TABLE triggers ADD COLUMN folder TEXT;         -- Automations page folder; NULL = top level
ALTER TABLE triggers ADD COLUMN updated_at INTEGER;  -- ms; the Modified column
ALTER TABLE triggers ADD COLUMN published_at INTEGER; -- ms; NULL + disabled = DRAFT
ALTER TABLE triggers ADD COLUMN deleted_at INTEGER;  -- ms; in Trash
ALTER TABLE flow_sends ADD COLUMN node_id TEXT;      -- the graph node this message came from
ALTER TABLE flow_sends ADD COLUMN part INTEGER NOT NULL DEFAULT 0; -- bubble index inside the node
ALTER TABLE flow_sends ADD COLUMN urls TEXT;         -- JSON {button id: url} behind /f/<send>/<button>
ALTER TABLE flow_runs ADD COLUMN node_id TEXT;       -- smart delay node; the run continues from its Next Step
UPDATE triggers SET updated_at = created_at, published_at = created_at;
-- Old sends point at the nodes their steps became; their first-message sends are the runs.
INSERT OR IGNORE INTO flow_starts (trigger_id, subscriber_id, status, created_at)
  SELECT trigger_id, subscriber_id, 'sent', MIN(created_at) FROM flow_sends WHERE step_id IS NULL AND status = 'sent' GROUP BY trigger_id, subscriber_id;
UPDATE flow_sends SET node_id = CASE WHEN step_id IS NULL THEN 'm0' ELSE 's' || step_id END WHERE node_id IS NULL;
INSERT OR IGNORE INTO flow_taps (send_id, port, created_at) SELECT id, 'url', clicked_at FROM flow_sends WHERE clicked_at IS NOT NULL;
INSERT OR IGNORE INTO flow_taps (send_id, port, created_at) SELECT id, 'nx', tapped_at FROM flow_sends WHERE tapped_at IS NOT NULL;
-- Smart delays still waiting continue from the delay step's node.
UPDATE flow_runs SET node_id = 's' || (SELECT s.id FROM flow_steps s WHERE s.trigger_id = flow_runs.trigger_id AND s.position = flow_runs.after_position)
  WHERE node_id IS NULL AND status = 'scheduled';
