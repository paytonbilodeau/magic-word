CREATE TABLE IF NOT EXISTS ig_manual_requests(id TEXT PRIMARY KEY, subscriber_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL);
