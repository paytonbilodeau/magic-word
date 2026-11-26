-- Telling a flow's echo from the owner typing: has this exact text gone out to other people? (src/autonomy.ts automated)
CREATE INDEX IF NOT EXISTS messages_by_text ON messages (text);
