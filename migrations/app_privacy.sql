CREATE TABLE IF NOT EXISTS deletion_requests(code TEXT PRIMARY KEY, subject TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS deletion_subject ON deletion_requests(subject);
CREATE TABLE IF NOT EXISTS contact_fields(subscriber_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(subscriber_id,name));
