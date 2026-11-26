-- Where a tracked link was opened (Cloudflare's geo on the click), matched against Skool's join location.
ALTER TABLE clicks ADD COLUMN country TEXT;
ALTER TABLE clicks ADD COLUMN city TEXT;
