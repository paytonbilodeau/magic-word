-- Inbox at scale (2026-10-28). Run once on the live DB after schema.sql.
ALTER TABLE leads ADD COLUMN last_at INTEGER;     -- ms of the thread's newest message; the inbox sorts on it
ALTER TABLE leads ADD COLUMN last_msg_id INTEGER; -- that message, for the preview line
ALTER TABLE leads ADD COLUMN profile_pic TEXT;    -- Instagram CDN URL (linked, never stored); expires, so refreshed
ALTER TABLE leads ADD COLUMN profile_at INTEGER;  -- ms of the last profile lookup
UPDATE leads SET last_msg_id = (SELECT MAX(id) FROM messages WHERE subscriber_id = leads.subscriber_id);
UPDATE leads SET last_at = COALESCE((SELECT created_at FROM messages WHERE id = leads.last_msg_id), created_at);
CREATE INDEX IF NOT EXISTS leads_by_last_at ON leads (last_at);
-- Every write path (webhook, sends, flows, comments, the history import) moves the pointer, so nothing else has to.
CREATE TRIGGER IF NOT EXISTS messages_touch_lead AFTER INSERT ON messages BEGIN
  UPDATE leads SET last_at = NEW.created_at, last_msg_id = NEW.id
  WHERE subscriber_id = NEW.subscriber_id AND COALESCE(last_at, 0) <= NEW.created_at;
END;
-- A new lead's first message is often written just before its lead row: pick it up when the row appears.
CREATE TRIGGER IF NOT EXISTS leads_pick_up_last AFTER INSERT ON leads WHEN NEW.last_msg_id IS NULL BEGIN
  UPDATE leads SET
    last_msg_id = (SELECT MAX(id) FROM messages WHERE subscriber_id = NEW.subscriber_id),
    last_at = (SELECT created_at FROM messages WHERE id = (SELECT MAX(id) FROM messages WHERE subscriber_id = NEW.subscriber_id))
  WHERE subscriber_id = NEW.subscriber_id AND EXISTS (SELECT 1 FROM messages WHERE subscriber_id = NEW.subscriber_id);
END;
