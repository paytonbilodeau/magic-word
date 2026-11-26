-- Inbox media (2026-10-29). Run once on the live DB after schema.sql (which adds media_cache).
ALTER TABLE messages ADD COLUMN attachments TEXT; -- JSON Part[] from the webhook / sync: types, ids, captions, the URL of the moment
ALTER TABLE messages ADD COLUMN reactions TEXT;   -- JSON {"lead": "❤️", "you": "😂"} from message_reactions
ALTER TABLE messages ADD COLUMN edited_at INTEGER; -- ms of the last message_edit (text already replaced)
ALTER TABLE messages ADD COLUMN unsent_at INTEGER; -- ms they unsent it (text set to "[unsent a message]", media dropped)
