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
