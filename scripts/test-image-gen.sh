#!/usr/bin/env bash
#
# test-image-gen.sh — Test END-TO-END de la fonction generate-image déployée.
# Se connecte avec un vrai compte, appelle generate-image, et dit clairement
# si une VRAIE image IA est revenue ou si c'est le visuel de secours.
#
# Usage:
#   ./scripts/test-image-gen.sh <email> <motdepasse>
#   EMAIL=you@ex.com PASSWORD=secret ./scripts/test-image-gen.sh
#
# Lit VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY depuis .env.local
# puis .env (ou directement depuis les variables d'environnement).
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Vite projects usually keep frontend env in .env.local. Load .env after it
# only for variables that are not already set by the shell/.env.local.
if [ -f "$ROOT/.env.local" ]; then set -a; . "$ROOT/.env.local"; set +a; fi
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

SUPA_URL="${VITE_SUPABASE_URL:-}"
ANON="${VITE_SUPABASE_PUBLISHABLE_KEY:-}"
EMAIL="${1:-${EMAIL:-}}"
PASSWORD="${2:-${PASSWORD:-}}"

if [ -z "$SUPA_URL" ] || [ -z "$ANON" ]; then
  echo "❌ VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY introuvables (.env ou env)."; exit 1
fi
if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <email> <motdepasse>   (compte CONFIRMÉ requis)"; exit 1
fi

echo "→ Connexion en tant que $EMAIL ..."
AUTH=$(curl -sS "$SUPA_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(printf '%s' "$AUTH" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ Échec d'authentification :"; printf '%s\n' "$AUTH" | head -c 300; echo; exit 1
fi
echo "✓ Authentifié."

echo "→ Appel de generate-image (génération premium — peut prendre plusieurs minutes) ..."
SUPA_URL="$SUPA_URL" TOKEN="$TOKEN" ANON="$ANON" python3 - <<'PY'
import os, json, urllib.request, urllib.error
base = os.environ["SUPA_URL"].rstrip("/"); token = os.environ["TOKEN"]; anon = os.environ["ANON"]
endpoint = f"{base}/functions/v1/generate-image"

def call(body):
    req = urllib.request.Request(
        endpoint, data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "apikey": anon, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read().decode())
        except Exception: return {"error": f"HTTP {e.code}"}
    except Exception as e:
        return {"error": f"network: {e}"}

body = {"postContent": "Titre: Offre premium de rentrée. Boostez votre visibilité avec notre accompagnement marketing digital. Réservez votre audit gratuit.",
        "platforms": ["LinkedIn"], "peopleType": "african"}

for attempt in range(1, 9):  # resumable: re-call with the job id until ready
    r = call(body)
    if r.get("error"):
        print("❌ Erreur Graphiste GPT :", r["error"])
        if r.get("code"):   print("   code   :", r["code"])
        if r.get("detail"): print("   détail :", str(r["detail"])[:300])
        print("   → Vérifie : GRAPHISTE_GPT_API_KEY dans Supabase Secrets ? crédits Graphiste GPT ? service en ligne ?")
        raise SystemExit(2)
    url = r.get("imageUrl") or ""
    if url:
        if url.startswith("data:image/svg") or url.split("?")[0].lower().endswith(".svg"):
            print("❌ SVG retourné — ce n est PAS une vraie affiche Graphiste GPT :", url[:90]); raise SystemExit(3)
        fmt = r.get("format") or {}
        print("provider :", r.get("provider"))
        print("format   :", fmt.get("label"), fmt.get("aspectRatio"), fmt.get("resolution"))
        print("imageUrl :", url[:100] + ("…" if len(url) > 100 else ""))
        print("\n✅ SUCCÈS : vraie affiche Graphiste GPT premium (image réelle, pas de SVG).")
        raise SystemExit(0)
    if r.get("status") == "processing":
        print(f"… génération en cours (tentative {attempt}) — job {r.get('jobId')}")
        body = {"jobId": r.get("jobId"), "statusUrl": r.get("statusUrl"), "platforms": ["LinkedIn"]}
        continue
    print("❌ Réponse inattendue :", json.dumps(r)[:200]); raise SystemExit(4)

print("❌ Toujours en génération après plusieurs tentatives. Réessayez plus tard."); raise SystemExit(5)
PY
