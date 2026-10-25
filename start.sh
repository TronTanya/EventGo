#!/usr/bin/env sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS, then run: sh start.sh'
  exit 1
fi
for f in db.env mail.env; do
  if [ -f "$f" ]; then set -a; . "./$f"; set +a; fi
done
exec node --no-warnings server.mjs --open
