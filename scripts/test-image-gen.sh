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

echo "→ Appel de generate-image (peut prendre 10-40s) ..."
RESP=$(curl -sS "$SUPA_URL/functions/v1/generate-image" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"postContent":"Titre: Offre premium de rentrée. Boostez votre visibilité avec notre accompagnement marketing digital. Réservez votre audit gratuit dès aujourd hui.","platforms":["LinkedIn"],"peopleType":"african"}')

printf '%s' "$RESP" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    r = json.loads(raw)
except Exception:
    print("❌ Réponse non-JSON :"); print(raw[:300]); sys.exit(1)
if r.get("error"):
    print("❌ Erreur Graphiste GPT :", r["error"])
    if r.get("code"):   print("   code   :", r["code"])
    if r.get("detail"): print("   détail :", str(r["detail"])[:300])
    print("   → Vérifie: GRAPHISTE_GPT_API_KEY dans Supabase Secrets ? crédits Graphiste GPT ? service en ligne ?")
    sys.exit(2)
url = r.get("imageUrl") or ""
fmt = r.get("format") or {}
if not url:
    print("❌ Aucune image retournée."); sys.exit(2)
if url.startswith("data:image/svg") or url.lower().split("?")[0].endswith(".svg"):
    print("❌ SVG retourné — ce n est PAS une vraie affiche Graphiste GPT :", url[:90]); sys.exit(3)
print("provider :", r.get("provider"))
print("format   :", fmt.get("label"), fmt.get("aspectRatio"), fmt.get("resolution"))
print("imageUrl :", url[:100] + ("…" if len(url) > 100 else ""))
print()
print("✅ SUCCÈS : vraie affiche Graphiste GPT premium (image réelle, pas de SVG).")
'
