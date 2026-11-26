CREATE TABLE IF NOT EXISTS leads (
  subscriber_id TEXT PRIMARY KEY,           -- Instagram-scoped id (Meta) or Manychat subscriber id
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- active | paused | flagged | done
  stage TEXT NOT NULL DEFAULT 'opener',
  last_inbound_at INTEGER,                  -- ms; the 24h send window runs from here
  created_at INTEGER NOT NULL,
  test INTEGER NOT NULL DEFAULT 0,          -- 1 once they've said SETTERTEST: the only threads the reviewer login sees
  mc_id TEXT                                -- Manychat subscriber id once they DM'd through Manychat; replies go out through it
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  role TEXT NOT NULL,                       -- lead | bot
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  mid TEXT                                  -- Instagram message id; dedupes webhook retries and our own echoes
);
CREATE INDEX IF NOT EXISTS messages_by_lead ON messages (subscriber_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_mid ON messages (mid);
CREATE INDEX IF NOT EXISTS messages_by_time ON messages (created_at); -- join matching scans a time window

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id TEXT NOT NULL,
  after_message_id INTEGER NOT NULL,        -- last lead message this draft answers
  action TEXT NOT NULL,                     -- reply | stop | handoff | flag
  bubbles TEXT NOT NULL,                    -- JSON array of message bubbles
  stage TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | rejected | superseded | expired | failed
  send_after INTEGER,                       -- ms; set only on autopilot
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_by_lead ON drafts (subscriber_id, id);
CREATE INDEX IF NOT EXISTS drafts_by_status ON drafts (status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,                     -- ig_token, ig_token_at, ig_user_id
  value TEXT NOT NULL
);

-- Comment-to-DM: a comment matching a keyword gets one private reply DM (Instagram allows one per comment, within 7 days).
CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,                    -- whole word/phrase, case-insensitive; "*" = any comment
  media_id TEXT,                            -- only this post/reel; NULL = every post
  dm TEXT NOT NULL,                         -- private reply, one bubble; {{SKOOL_LINK}} filled at send time
  public_reply TEXT,                        -- optional reply under the comment; one per line, picked at random
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL               -- more columns in migrations/flows.sql (a trigger row is a whole automation)
);

-- Steps after a trigger's first message, in position order: another message (same fields) or a smart delay.
CREATE TABLE IF NOT EXISTS flow_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- message | delay
  text TEXT,
  button_title TEXT,
  button_url TEXT,
  next_title TEXT,
  quick_replies TEXT,
  delay_s INTEGER                           -- delay steps: wait this long, then continue
);
CREATE INDEX IF NOT EXISTS flow_steps_by_trigger ON flow_steps (trigger_id, position);

-- Every flow message sent: per-step Sent/Clicked stats, one-per-person, and the id inside button payloads and /f/ links.
CREATE TABLE IF NOT EXISTS flow_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id INTEGER NOT NULL,
  step_id INTEGER,                          -- NULL = the trigger's first message
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',   -- sending | sent | failed
  url TEXT,                                 -- where the URL button's /f/ link redirects
  mid TEXT,
  error TEXT,
  clicked_at INTEGER,                       -- first click on the URL button
  tapped_at INTEGER,                        -- first tap on a continue button or quick reply (a continue tap only works once)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_sends_by_trigger ON flow_sends (trigger_id, step_id);
CREATE INDEX IF NOT EXISTS flow_sends_by_lead ON flow_sends (subscriber_id, trigger_id);

-- Smart delays waiting on the cron. Cancelled if the lead says anything after after_msg_id (the chat moved on).
CREATE TABLE IF NOT EXISTS flow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id INTEGER NOT NULL,
  subscriber_id TEXT NOT NULL,
  after_position INTEGER NOT NULL,          -- continue with steps after this position
  after_msg_id INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | done | cancelled
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_runs_due ON flow_runs (status, run_at);

CREATE TABLE IF NOT EXISTS comments (
  comment_id TEXT PRIMARY KEY,              -- dedupes webhook retries
  subscriber_id TEXT NOT NULL,              -- commenter's Instagram-scoped id
  username TEXT,
  media_id TEXT,
  text TEXT NOT NULL,
  trigger_id INTEGER,
  status TEXT NOT NULL,                     -- ignored | repeat | sent | failed | queued (waiting on the hourly cap or a retry) | expired
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_time ON comments (created_at);

-- Texts this Worker is about to send. An echo that matches one is ours (it beat our own insert), not the owner typing.
CREATE TABLE IF NOT EXISTS outbox (
  subscriber_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_by_lead ON outbox (subscriber_id, created_at);

-- Link tracking (opt-in at /admin/settings): {{SKOOL_LINK}} goes out as /l/<code>, one code per lead and link.
CREATE TABLE IF NOT EXISTS links (
  code TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS links_by_lead ON links (subscriber_id, url);

CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clicks_by_time ON clicks (created_at);

-- Inbox tags, free text, any number per lead.
CREATE TABLE IF NOT EXISTS lead_tags (
  subscriber_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, tag)
);

-- Automations as a node graph (the whiteboard editor). The published graph lives here; the editor's unpublished
-- draft is JSON in triggers.draft. Node ids are short strings, unique per automation ("trigger" is the When... node;
-- automations from the linear builder became m0 = first message, s<flow_steps.id> = each step).
CREATE TABLE IF NOT EXISTS flow_nodes (
  trigger_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- trigger | message | delay | condition | action | randomizer
  data TEXT NOT NULL DEFAULT '{}',          -- JSON, shape per kind (src/graph.ts)
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (trigger_id, id)
);

-- One edge per output port: next | yes | no | a button / quick reply / randomizer variant id.
CREATE TABLE IF NOT EXISTS flow_edges (
  trigger_id INTEGER NOT NULL,
  from_id TEXT NOT NULL,
  port TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (trigger_id, from_id, port)
);

-- One row per person per automation they entered: the one-run rule and the Runs column.
CREATE TABLE IF NOT EXISTS flow_starts (
  trigger_id INTEGER NOT NULL,
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',   -- sending | sent | failed
  created_at INTEGER NOT NULL,
  PRIMARY KEY (trigger_id, subscriber_id)
);

-- Button taps and link clicks, once per sent message and port (a next-step button only works once).
CREATE TABLE IF NOT EXISTS flow_taps (
  send_id INTEGER NOT NULL,
  port TEXT NOT NULL,                       -- button / quick reply id; 'url' for an old single-link /f/<id> click
  created_at INTEGER NOT NULL,
  PRIMARY KEY (send_id, port)
);

-- Which way conditions and randomizers sent people, and actions that ran: per-node stats on the canvas.
CREATE TABLE IF NOT EXISTS flow_hits (
  trigger_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  port TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_hits_by_node ON flow_hits (trigger_id, node_id);

-- What the message API said about a message's media, by mid (src/attachments.ts). Signed CDN URLs expire, so rows
-- are fresh for an hour and pruned after a day; nothing here is the media itself.
CREATE TABLE IF NOT EXISTS media_cache (
  mid TEXT PRIMARY KEY,
  data TEXT NOT NULL,                       -- JSON {parts: Part[], reactions: string[]}; empty parts = nothing to show
  fetched_at INTEGER NOT NULL               -- ms
);
CREATE INDEX IF NOT EXISTS media_cache_by_age ON media_cache (fetched_at);

-- Skool joins, matched to the DM lead they came from (src/joins.ts). One row per Skool member seen joining; the match
-- is the lead with the most evidence (a click on their tracked link just before, the click's city, name, "just
-- joined" in the thread, a Skool link sent). Unmatched joins stay with subscriber_id NULL.
CREATE TABLE IF NOT EXISTS joins (
  member_id TEXT PRIMARY KEY,               -- Skool member id
  name TEXT,
  handle TEXT,                              -- Skool handle (skool.com/@handle)
  joined_at INTEGER NOT NULL,               -- ms
  location TEXT,                            -- Skool's requestLocation, e.g. "manila (philippines)"
  source TEXT,                              -- their answer to "Where did you hear about Your Community?"
  subscriber_id TEXT,                       -- matched lead, or NULL
  score INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL DEFAULT 'none',  -- confirmed | likely | none
  evidence TEXT,                            -- JSON list of what matched, for the console
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS joins_by_time ON joins (joined_at);
CREATE INDEX IF NOT EXISTS joins_by_lead ON joins (subscriber_id);

-- The whole Skool roster (active + churned), matched to DM leads: members don't get set, churned members get won back.
CREATE TABLE IF NOT EXISTS roster (
  member_id TEXT PRIMARY KEY,               -- Skool member id
  name TEXT NOT NULL,                       -- "first last" as on Skool
  fullname TEXT NOT NULL,                   -- normalized for exact name matching
  handle TEXT,                              -- Skool handle
  ig TEXT,                                  -- Instagram username from their Skool profile link, lowercase
  status TEXT NOT NULL,                     -- active | churned
  joined_at INTEGER,                        -- ms
  left_at INTEGER,                          -- ms (churned)
  ltv_cents INTEGER NOT NULL DEFAULT 0,
  subscriber_id TEXT,                       -- matched lead
  matched_by TEXT,                          -- ig | join | name
  checked_at INTEGER NOT NULL DEFAULT 0,    -- last match attempt
  seen_at INTEGER NOT NULL                  -- last time a roster read listed them
);
CREATE INDEX IF NOT EXISTS roster_by_lead ON roster (subscriber_id);
CREATE INDEX IF NOT EXISTS roster_by_check ON roster (checked_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,             -- ms
  kind TEXT NOT NULL,                      -- reply | follow_up | learn | image | console (spend before logging, from the Console)
  subscriber_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, -- thinking included
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL              -- millionths of a dollar
);
CREATE INDEX IF NOT EXISTS ai_usage_by_time ON ai_usage (created_at);


-- Failures that used to reach only console.error (health.ts logError): the Dashboard's Problems card and checkHealth read it.
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- what failed, human words ("public reply", "AI draft", ...)
  ref TEXT,                                 -- the lead, comment, flow run or route it was about
  detail TEXT NOT NULL,                     -- message + top of the stack
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS errors_by_time ON errors (created_at);
