#!/usr/bin/env bash
#
# test-openrouter-image.sh — Test ISOLÉ du modèle d'image OpenRouter, sans
# passer par Supabase. Permet de distinguer un problème de MODÈLE d'un
# problème de CRÉDIT ou de déploiement.
#
# Usage:
#   OPENROUTER_API_KEY=sk-or-... ./scripts/test-openrouter-image.sh
#   OPENROUTER_API_KEY=sk-or-... MODEL=google/gemini-3.1-flash-image-preview ./scripts/test-openrouter-image.sh
#
set -uo pipefail

KEY="${OPENROUTER_API_KEY:-}"
MODEL="${MODEL:-google/gemini-2.5-flash-image}"

if [ -z "$KEY" ]; then echo "❌ Renseigne OPENROUTER_API_KEY (secret OpenRouter)."; exit 1; fi

echo "→ Test direct du modèle : $MODEL"
RESP=$(curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"modalities\":[\"image\",\"text\"],\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Un visuel abstrait moderne, couleurs vives, sans aucun texte.\"}]}]}")

printf '%s' "$RESP" | python3 -c '
import sys, json
try:
    r = json.load(sys.stdin)
except Exception:
    print("❌ Réponse non-JSON :"); print(sys.stdin.read()[:300]); sys.exit(1)
if "error" in r:
    err = r["error"]
    msg = err.get("message", err) if isinstance(err, dict) else err
    print("❌ Erreur API:", str(msg)[:300])
    print("   (402 = crédit insuffisant ; 404/400 = modèle invalide ; 401 = clé invalide)")
    sys.exit(1)
msg = (r.get("choices") or [{}])[0].get("message", {})
imgs = msg.get("images") or []
if imgs:
    u = imgs[0].get("image_url", {}).get("url", "") if isinstance(imgs[0], dict) else ""
    print("✅ Le modèle a renvoyé une image —", (u[:60] + "…") if u else "(format à vérifier)")
else:
    print("⚠️  Pas d’image dans la réponse. Clés de message:", list(msg.keys()))
    print("    Réponse (début):", json.dumps(r)[:300])
    sys.exit(2)
'
