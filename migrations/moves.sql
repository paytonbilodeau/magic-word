-- The furthest setting move each lead actually reached, read from their thread (src/moves.ts), for the Dashboard funnel.
-- Separate from `stage`, which is the AI's own working stage. move_at = the lead's last_at when it was computed.
ALTER TABLE leads ADD COLUMN move TEXT;
ALTER TABLE leads ADD COLUMN move_at INTEGER;
