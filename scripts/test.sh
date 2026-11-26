#!/usr/bin/env bash
# The full test suite, in one command: `pnpm test` / `npm test`.
#
# Over half the suite (search, move_facts, merges, preferences, connector
# policy) needs a real Postgres, and those suites skip silently when
# TEST_DATABASE_URL is unset, so a run without a database still reports all
# green. This script makes the database run the default: it starts a loopback
# pgvector container (familiar-test-pg), migrates it, and runs every test against
# it. No database is a loud failure, not a quiet skip.
#
#   TEST_DATABASE_URL=...  use that database instead of the container
#   pnpm test:unit         the no-database subset, explicitly (scripts/test.sh --unit)
set -euo pipefail
cd "$(dirname "$0")/.."

# Node 22+ (type stripping). A shell whose default is older gets the newest
# installed nvm version rather than a cryptic "bad option".
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 22 ]; then
  NODE_BIN=""
  for n in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V -r); do
    if [ "$(node_major "$n")" -ge 22 ]; then NODE_BIN="$n"; break; fi
  done
  [ -n "$NODE_BIN" ] || { echo "FAIL: Familiar needs Node 22 or newer (found $(node -v 2>/dev/null || echo none)). Install one with: nvm install 22" >&2; exit 1; }
  export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

if [ "${1:-}" = --unit ]; then
  echo "test:unit: database suites will be SKIPPED; run pnpm test for the full suite" >&2
  exec "$NODE_BIN" --test --experimental-strip-types test/*.test.ts
fi

CONTAINER=familiar-test-pg
PORT=55433
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  command -v docker >/dev/null && docker info >/dev/null 2>&1 \
    || { echo "FAIL: the database suites need Docker running (or set TEST_DATABASE_URL to a local *test* database). For the no-database subset only: pnpm test:unit" >&2; exit 1; }
  state="$(docker ps -a --filter "name=^/${CONTAINER}\$" --format '{{.State}}')"
  if [ -z "$state" ]; then
    docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=familiar_test \
      -p "127.0.0.1:$PORT:5432" pgvector/pgvector:pg17 >/dev/null
  elif [ "$state" != running ]; then
    docker start "$CONTAINER" >/dev/null
  fi
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres -d familiar_test >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U postgres -d familiar_test >/dev/null 2>&1 \
    || { echo "FAIL: $CONTAINER did not become ready" >&2; exit 1; }
  export TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:$PORT/familiar_test"
fi

# Same guard the suites apply, checked before migrating: never touch anything
# but a loopback database with "test" in its name.
"$NODE_BIN" -e '
  const u = new URL(process.env.TEST_DATABASE_URL)
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || !u.pathname.includes("test")) {
    console.error(`FAIL: TEST_DATABASE_URL must be a loopback database with "test" in its name (got ${u.hostname}${u.pathname})`)
    process.exit(1)
  }'

# drizzle-kit prefers DATABASE_PUBLIC_URL, which in a .env or shell points at
# production. Strip it so the migration can only reach the test database.
env -u DATABASE_PUBLIC_URL DATABASE_URL="$TEST_DATABASE_URL" ./node_modules/.bin/drizzle-kit migrate >/dev/null \
  || { echo "FAIL: migrating the test database failed; rerun: DATABASE_URL=\$TEST_DATABASE_URL drizzle-kit migrate" >&2; exit 1; }

exec "$NODE_BIN" --test --experimental-strip-types test/*.test.ts
