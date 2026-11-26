-- One thread at a time: the AI runs on this lead (autopilot) even while the master switch is off.
ALTER TABLE leads ADD COLUMN ai_on INTEGER NOT NULL DEFAULT 0;
