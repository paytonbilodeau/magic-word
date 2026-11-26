-- Swipe-to-reply (2026-11-23): the mid of the message this one answers, from the webhook's message.reply_to.mid (theirs
-- and the owner's from the IG app) or our own send's reply_to. Instagram's API doesn't return it when a message is read
-- later, so replies from before this column can't be linked. The Inbox draws the quoted message above the reply.
ALTER TABLE messages ADD COLUMN reply_to TEXT;
