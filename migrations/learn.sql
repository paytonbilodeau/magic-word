-- When the setter learned from the owner's own answer to this handoff (or gave up waiting for one); NULL = not yet.
ALTER TABLE drafts ADD COLUMN learned_at INTEGER;
