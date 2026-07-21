// Claude-powered audience segmentation. The function only proposes segments;
// the browser persists them separately and a human explicitly selects the ones
// that become target_audiences.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { buildCorsHeaders } from "../_shared/cors.ts";
import { chatText, getOpenRouterKey, getTextModel } from "../_shared/ai.ts";
import { normalizeAudiences } from "../_shared/audience.ts";

const MAX_PAYLOAD_BYTES = 32 * 1024;

function clean(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("Audience analysis returned invalid JSON");
  }
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req.headers.get("origin"));
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: jsonHeaders });
  }
  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413, headers: jsonHeaders });
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!jwt) return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: jsonHeaders });
  if (!supabaseUrl || !serviceKey || !getOpenRouterKey()) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 503, headers: jsonHeaders });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: jsonHeaders });
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: jsonHeaders });
    }
    const companyName = clean(body.companyName ?? body.company_name, 120);
    const sector = clean(body.sector, 100);
    const description = clean(body.description, 2400);
    const contentTypes = Array.isArray(body.contentTypes ?? body.content_types)
      ? (body.contentTypes ?? body.content_types).map((item: unknown) => clean(item, 60)).filter(Boolean).slice(0, 8)
      : [];
    if (companyName.length < 2 || sector.length < 2 || description.length < 20) {
      return new Response(
        JSON.stringify({ error: "Renseignez le nom, le secteur et une description précise de l'activité." }),
        { status: 400, headers: jsonHeaders },
      );
    }

    const { data: allowed, error: quotaError } = await supabase.rpc("consume_generation_quota", {
      p_user: userData.user.id,
      p_function: "detect-audiences",
      p_max: 10,
      p_window_seconds: 3600,
    });
    if (!quotaError && allowed === false) {
      return new Response(JSON.stringify({ error: "Limite d'analyses atteinte. Réessayez dans une heure." }), { status: 429, headers: jsonHeaders });
    }

    const prompt = `Tu es Claude, stratège senior en segmentation client et en contenu. Analyse l'entreprise ci-dessous et propose 3 à 6 segments de clientèle réellement distincts et exploitables.

ENTREPRISE: ${companyName}
SECTEUR: ${sector}
DESCRIPTION PRÉCISE: ${description}
TYPES DE CONTENU SOUHAITÉS: ${contentTypes.join(", ") || "mixte"}

EXIGENCES DE QUALITÉ:
- Ne propose jamais des catégories vagues comme « tout le monde », « entreprises » ou « particuliers » seules.
- Chaque segment doit être identifiable par sa situation, son besoin, son niveau de maturité ou son usage.
- Distingue les acheteurs des utilisateurs lorsque c'est pertinent.
- Les pain_points doivent être des problèmes concrets vécus.
- Les goals doivent être des résultats désirés précis.
- Les content_topics doivent être des thèmes à forte valeur que cette cible voudrait réellement lire.
- Les buying_triggers doivent expliquer ce qui pourrait la pousser à agir ou acheter.
- Classe les segments par potentiel stratégique pour cette entreprise.

Réponds UNIQUEMENT avec un tableau JSON valide. Chaque objet doit respecter exactement cette forme:
{
  "id": "identifiant-court",
  "name": "Nom humain et précis du segment",
  "description": "Qui est cette cible et dans quelle situation elle se trouve",
  "pain_points": ["douleur 1", "douleur 2", "douleur 3"],
  "goals": ["objectif 1", "objectif 2", "objectif 3"],
  "content_topics": ["sujet 1", "sujet 2", "sujet 3", "sujet 4"],
  "buying_triggers": ["déclencheur 1", "déclencheur 2"],
  "preferred_tone": "ton recommandé",
  "priority": 1
}`;

    const raw = await chatText({
      model: getTextModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.25,
      top_p: 0.8,
      timeoutMs: 60_000,
    });
    const audiences = normalizeAudiences(extractJson(raw));
    if (audiences.length < 2) throw new Error("Claude did not return enough usable audience segments");

    return new Response(JSON.stringify({ audiences, model: getTextModel() }), { headers: jsonHeaders });
  } catch (error) {
    console.error("detect-audiences:", error);
    return new Response(
      JSON.stringify({ error: "L'analyse des cibles n'a pas abouti. Réessayez dans quelques instants." }),
      { status: 502, headers: jsonHeaders },
    );
  }
});
