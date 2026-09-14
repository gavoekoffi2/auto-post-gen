#!/usr/bin/env bash
#
# apply-migrations.sh — apply every Supabase migration that production is
# missing, in filename order, exactly once.
#
# Why this exists: the deploy workflow used to carry ONE hand-written step per
# migration (`Apply the editorial-mix migration`, `Apply poster footer text
# migration`, …). Any migration whose step someone forgot to add simply never
# reached production — the edge functions then query columns that do not exist,
# which is invisible until a user hits the feature.
#
# Replaying everything is not an option either: the oldest migrations are not
# idempotent (CREATE TABLE / CREATE POLICY without guards), so a blind replay
# fails. Hence a ledger:
#
#   public.schema_migrations_applied(name text primary key, applied_at)
#
# Everything up to MIGRATION_BASELINE was already applied by hand before the
# ledger existed: those names are recorded WITHOUT being executed. Every newer
# migration is executed once and recorded.
#
# Required env: SUPABASE_ACCESS_TOKEN, PROJECT_REF.
# Optional env: MIGRATIONS_DIR, MIGRATION_BASELINE, DRY_RUN=1.
#
set -euo pipefail
# Deterministic filename ordering/comparison regardless of runner locale.
export LC_ALL=C

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${PROJECT_REF:?PROJECT_REF is required}"

MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"
# Last migration applied to production before this script existed.
MIGRATION_BASELINE="${MIGRATION_BASELINE:-20260723000000_poster_footer_text.sql}"
API="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Run a SQL string through the Supabase management API and echo the JSON result.
run_sql() {
  printf '%s' "$1" | jq -Rs '{query: .}' > "$WORK/query.json"
  curl --fail-with-body -sS -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@$WORK/query.json" \
    "$API"
}

# Run a whole migration file as one statement batch.
run_sql_file() {
  jq -Rs '{query: .}' < "$1" > "$WORK/query.json"
  curl --fail-with-body -sS -X POST \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary "@$WORK/query.json" \
    "$API" >/dev/null
}

sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }

echo "Ensuring the migration ledger exists…"
run_sql "CREATE TABLE IF NOT EXISTS public.schema_migrations_applied (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.schema_migrations_applied ENABLE ROW LEVEL SECURITY;" >/dev/null

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)
if [ "${#migrations[@]}" -eq 0 ]; then
  echo "::error::No migration found in $MIGRATIONS_DIR"
  exit 1
fi

# Seed the ledger with everything that predates it (baseline included).
seed_values=""
for name in "${migrations[@]}"; do
  if [[ "$name" > "$MIGRATION_BASELINE" ]]; then continue; fi
  seed_values+="('$(sql_quote "$name")'),"
done
if [ -n "$seed_values" ]; then
  echo "Recording pre-ledger migrations as already applied (up to $MIGRATION_BASELINE)…"
  run_sql "INSERT INTO public.schema_migrations_applied (name) VALUES ${seed_values%,}
           ON CONFLICT (name) DO NOTHING;" >/dev/null
fi

applied_json="$(run_sql "SELECT name FROM public.schema_migrations_applied;")"
applied="$(printf '%s' "$applied_json" | jq -r '(if type == "object" then .result else . end)[]?.name' | sort)"

pending=()
for name in "${migrations[@]}"; do
  if printf '%s\n' "$applied" | grep -Fxq "$name"; then continue; fi
  pending+=("$name")
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo "Database schema is up to date (${#migrations[@]} migration(s) already applied)."
  exit 0
fi

echo "Pending migration(s): ${pending[*]}"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 — nothing applied."
  exit 0
fi

for name in "${pending[@]}"; do
  echo "→ Applying $name"
  run_sql_file "$MIGRATIONS_DIR/$name"
  run_sql "INSERT INTO public.schema_migrations_applied (name) VALUES ('$(sql_quote "$name")')
           ON CONFLICT (name) DO NOTHING;" >/dev/null
  echo "✔ $name applied"
done

echo "All migrations applied (${#pending[@]} new)."
