#!/usr/bin/env bash
#
# verify-schema.sh — fail the deploy when production is missing a column the
# code reads. A missing column is invisible until a user hits the feature (the
# edge function 500s, or the profile page silently fails to save), so this is
# the safety net behind scripts/apply-migrations.sh.
#
# Required env: SUPABASE_ACCESS_TOKEN, PROJECT_REF.
#
set -euo pipefail
export LC_ALL=C

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${PROJECT_REF:?PROJECT_REF is required}"

API="https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query"

# table:column pairs the application depends on. Add a line whenever a feature
# starts reading a new column.
REQUIRED=(
  "profiles:plan"
  "profiles:auto_publish"
  "profiles:auto_generate_enabled"
  "profiles:preferred_time"
  "profiles:promo_posts_per_week"
  "profiles:research_posts_per_week"
  "profiles:target_audiences"
  "profiles:poster_footer_text"
  "profiles:use_poster_person_image"
  "profiles:poster_person_image_url"
  "profiles:poster_person_label"
  "profiles:poster_person_placement"
  "profiles:image_style"
  "profiles:image_people_type"
  "profiles:brand_font"
  "posts:content_category"
  "posts:image_job_id"
  "posts:image_status_url"
  "posts:image_status"
  "posts:validation_token"
  "posts:validation_token_created_at"
  "posts:validation_email_sent_at"
  "social_connections:provider"
  "generation_usage:function_name"
)

values=""
for pair in "${REQUIRED[@]}"; do
  values+="('${pair%%:*}','${pair##*:}'),"
done

read -r -d '' QUERY <<SQL || true
SELECT r.tbl AS tbl, r.col AS col
FROM (VALUES ${values%,}) AS r(tbl, col)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
WHERE c.column_name IS NULL;
SQL

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '%s' "$QUERY" | jq -Rs '{query: .}' > "$WORK/query.json"

response="$(curl --fail-with-body -sS -X POST \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@$WORK/query.json" \
  "$API")"

missing="$(printf '%s' "$response" | jq -r '(if type == "object" then .result else . end)[]? | "\(.tbl).\(.col)"')"

if [ -n "$missing" ]; then
  echo "::error::Production schema is missing: $(printf '%s' "$missing" | tr '\n' ' ')"
  echo "Run the pending migrations (scripts/apply-migrations.sh) or add the missing migration."
  exit 1
fi

echo "Production schema matches the code (${#REQUIRED[@]} columns checked)."
