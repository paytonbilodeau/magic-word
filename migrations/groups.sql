-- Group chats (2026-11-01): each Instagram group thread is its own conversation, leads row 'g:<thread id>' (src/sync.ts).
-- Before this the import and the sync filed a group under its first member as that person's DMs.
ALTER TABLE leads ADD COLUMN members TEXT;   -- group chats: JSON [{id, username}] of everyone in it but you; NULL = a 1:1 thread
ALTER TABLE messages ADD COLUMN sender TEXT; -- group chats: IGSID of the member who wrote it (NULL = you, or a 1:1 thread)
