-- Private replies wait in line instead of failing (src/comments.ts): Instagram allows 750 an hour, and a comment can
-- be answered up to 7 days later. status gains queued | expired.
ALTER TABLE comments ADD COLUMN sent_at INTEGER;
ALTER TABLE comments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN retry_at INTEGER;
CREATE INDEX IF NOT EXISTS comments_queue ON comments (status, retry_at);
