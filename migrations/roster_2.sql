-- Lead names normalized like the roster's (fancy Unicode letters, accents, punctuation folded), filled by the roster sync.
ALTER TABLE leads ADD COLUMN name_key TEXT;
CREATE INDEX IF NOT EXISTS leads_by_name_key ON leads (name_key);
