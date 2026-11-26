CREATE TABLE IF NOT EXISTS page_comment_rules (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  UNIQUE (post_id, keyword)
);
CREATE TABLE IF NOT EXISTS page_comment_claims (
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  PRIMARY KEY (post_id, author_id)
);
