CREATE TABLE IF NOT EXISTS channel_rules(
 id INTEGER PRIMARY KEY, channel TEXT NOT NULL, keyword TEXT NOT NULL, reply TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 UNIQUE(channel,keyword)
);
CREATE TABLE IF NOT EXISTS channel_events(
 channel TEXT NOT NULL, event_id TEXT NOT NULL, contact TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
 rule_id INTEGER, reply TEXT, state TEXT NOT NULL, provider_id TEXT,
 PRIMARY KEY(channel,event_id)
);
CREATE INDEX IF NOT EXISTS channel_contact_time ON channel_events(channel,contact,at);
CREATE TABLE IF NOT EXISTS channel_manual(
 request_id TEXT PRIMARY KEY, channel TEXT NOT NULL, contact TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, provider_id TEXT
);
