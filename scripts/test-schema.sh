#!/usr/bin/env bash
#
# Apply every migration to a real Postgres, prove the post-cutoff ones are
# replay-safe (the deploy re-applies them on every push), then run the
# behavioural checks in supabase/tests/schema.test.sql.
#
# Local use:
#   docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
#   ./scripts/test-schema.sh
#
# Override the connection with DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD.
set -euo pipefail

cd "$(dirname "$0")/.."

PSQL_BASE=${DATABASE_URL:-"postgresql://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${PGHOST:-localhost}:${PGPORT:-5432}"}
TEST_DB=${TEST_DB:-auto_post_gen_schema_test}

# Migrations at or after this stamp are re-applied by the production deploy on
# every push, so they must stay idempotent. Keep in sync with
# .github/workflows/deploy-functions.yml → MIGRATION_CUTOFF.
MIGRATION_CUTOFF=${MIGRATION_CUTOFF:-20260721000000}

run() { psql -v ON_ERROR_STOP=1 -q "$@"; }

echo "==> Recreating $TEST_DB"
run "$PSQL_BASE/postgres" -c "DROP DATABASE IF EXISTS $TEST_DB;" -c "CREATE DATABASE $TEST_DB;"

DB="$PSQL_BASE/$TEST_DB"

echo "==> Scaffolding the Supabase-provided objects the migrations reference"
run "$DB" -f supabase/tests/scaffold.sql

echo "==> Applying every migration, in order"
for migration in supabase/migrations/*.sql; do
  echo "    $(basename "$migration")"
  run "$DB" -f "$migration" >/dev/null
done

echo "==> Re-applying the migrations the deploy replays (they must be idempotent)"
for migration in supabase/migrations/*.sql; do
  stamp="$(basename "$migration" | cut -d_ -f1)"
  [ "$stamp" \< "$MIGRATION_CUTOFF" ] && continue
  echo "    replay $(basename "$migration")"
  run "$DB" -f "$migration" >/dev/null
done

echo "==> Behavioural checks"
# Run ONCE (the checks insert fixtures, so a second run would collide) and keep
# both the output and the exit status: every check RAISEs on failure, so
# ON_ERROR_STOP makes psql exit non-zero.
status=0
psql -v ON_ERROR_STOP=1 "$DB" -f supabase/tests/schema.test.sql >/tmp/schema-test.out 2>&1 || status=$?
grep -E "ok  -|FAILED|ERROR" /tmp/schema-test.out || true

if [ "$status" -ne 0 ]; then
  echo "==> Schema checks FAILED."
  exit 1
fi
echo "==> Schema checks passed."
