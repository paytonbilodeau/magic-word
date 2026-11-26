#!/bin/zsh
# Loads the backfill's numbered .sql chunks into live D1 as they land, oldest first, so the inbox fills in while the
# fetch runs. Each chunk is checked against a throwaway local DB first; a chunk that fails stays put and is retried on
# the next pass (every statement is idempotent). D1 locks writes during each file import, so chunks are spaced out;
# anything live traffic loses in that window is picked up by the missed-DM sync (src/sync.ts). Loaded chunks move to <out>/loaded/. Stops once the fetch is done
# and nothing is left. Usage: scripts/import-loop.sh .backfill/out
set -u
cd "$(dirname "$0")/.."
out=${1:?Pass the directory containing the generated SQL chunks}
db_name=$(node -e 'const f=require("fs");const m=f.readFileSync("wrangler.jsonc","utf8").match(/"database_name"\s*:\s*"([a-z0-9-]+)"/);if (!m) process.exit(1);process.stdout.write(m[1])') || exit 1
mkdir -p "$out/loaded"
while true; do
  for f in $(ls "$out"/*.sql 2>/dev/null | sort); do
    node -e '
      const { DatabaseSync } = require("node:sqlite"); const fs = require("fs");
      const db = new DatabaseSync(":memory:");
      db.exec(fs.readFileSync("schema.sql", "utf8"));
      for (const m of fs.readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(fs.readFileSync("migrations/" + m, "utf8"));
      db.exec(fs.readFileSync(process.argv[1], "utf8"));' "$f" || { echo "$(date +%T) BAD SQL $f"; continue; }
    if npx wrangler d1 execute "$db_name" --remote --file "$f" -y > "$out/last.log" 2>&1 && grep -q "Executed" "$out/last.log"; then
      mv "$f" "$out/loaded/" && echo "$(date +%T) loaded $(basename $f)"
      sleep 4 # D1 blocks other writes while a file import runs: leave the webhook and cron clean gaps
    else
      echo "$(date +%T) retry later $(basename $f): $(grep -m1 -i error "$out/last.log")"
      break
    fi
  done
  if grep -q '"phase":"done"' "$out/state.json" 2>/dev/null && ! ls "$out"/*.sql >/dev/null 2>&1; then
    echo "$(date +%T) all chunks loaded"; exit 0
  fi
  sleep 20
done
