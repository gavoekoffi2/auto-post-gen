// request-subscription: a signed-in user declares a Mobile Money payment for a
// plan, so the operator can verify it and activate the subscription.
//
//   POST { plan, billingPeriod, paymentMethod, payerPhone, paymentReference }
//        → { request }                       (creates a pending request)
//   POST { action: "cancel", requestId }     → { ok }   (withdraws a pending one)
//
// Why a declaration and not a payment gateway: the target market pays by
// Wave / Orange Money / MTN, and the first customers are few enough to verify
// by hand. The amount is computed HERE from the canonical price list, never
// taken from the request, and approval (admin-api) is what grants the plan —
// this function cannot change anyone's entitlement.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildCorsHeaders, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { emailLayout, escapeHtml, formatFcfa, getEmailConfig, sendEmail } from "../_shared/email.ts";
import {
  isPaymentMethod,
  isPlanId,
  PAYMENT_METHODS,
  PLAN_LIMITS,
  priceFor,
  type BillingPeriod,
} from "../_shared/plans.ts";

const PHONE_RE = /^\+?[0-9 ().-]{8,20}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/:#-]{3,63}$/;

type Body = {
  action?: string;
  requestId?: string;
  plan?: string;
  billingPeriod?: string;
  paymentMethod?: string;
  payerPhone?: string;
  paymentReference?: string;
};

serve(async (req) => {
  const cors = buildCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Méthode non autorisée" }, { status: 405, cors });
  }

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return jsonResponse({ error: "Service indisponible" }, { status: 500, cors });
  }

  const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!jwt) return jsonResponse({ error: "Connexion requise" }, { status: 401, cors });
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userError || !user) return jsonResponse({ error: "Session invalide" }, { status: 401, cors });

  const body = (await req.json().catch(() => ({}))) as Body;

  if (body.action === "cancel") {
    if (!body.requestId) return jsonResponse({ error: "Demande introuvable" }, { status: 400, cors });
    const { data, error } = await admin
      .from("subscription_requests")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("id", body.requestId)
      .eq("user_id", user.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("request-subscription cancel:", error);
      return jsonResponse({ error: "Impossible d'annuler la demande" }, { status: 500, cors });
    }
    if (!data) {
      return jsonResponse({ error: "Cette demande a déjà été traitée." }, { status: 409, cors });
    }
    return jsonResponse({ ok: true }, { cors });
  }

  // ── Validation ────────────────────────────────────────────────────────
  const plan = body.plan;
  if (!isPlanId(plan)) return jsonResponse({ error: "Forfait invalide" }, { status: 400, cors });
  const billingPeriod = body.billingPeriod as BillingPeriod;
  if (billingPeriod !== "monthly" && billingPeriod !== "annual") {
    return jsonResponse({ error: "Période de facturation invalide" }, { status: 400, cors });
  }
  if (!isPaymentMethod(body.paymentMethod)) {
    return jsonResponse({ error: "Moyen de paiement invalide" }, { status: 400, cors });
  }
  const paymentMethod = body.paymentMethod;
  const payerPhone = (body.payerPhone || "").trim();
  if (!PHONE_RE.test(payerPhone)) {
    return jsonResponse(
      { error: "Numéro de téléphone invalide. Indiquez le numéro qui a effectué le paiement." },
      { status: 400, cors },
    );
  }
  const paymentReference = (body.paymentReference || "").trim();
  if (!REFERENCE_RE.test(paymentReference)) {
    return jsonResponse(
      {
        error:
          "Référence de paiement invalide. Recopiez l'identifiant de transaction reçu par SMS " +
          "(4 à 64 caractères, lettres et chiffres).",
      },
      { status: 400, cors },
    );
  }

  const amount = priceFor(plan, billingPeriod);

  const { data: request, error: insertError } = await admin
    .from("subscription_requests")
    .insert({
      user_id: user.id,
      plan,
      billing_period: billingPeriod,
      amount_fcfa: amount,
      payment_method: paymentMethod,
      payer_phone: payerPhone,
      payment_reference: paymentReference,
    })
    .select("*")
    .single();

  if (insertError) {
    // Both unique indexes are business rules, not failures: say which.
    if (insertError.code === "23505") {
      const duplicateReference = /reference/i.test(insertError.message || "");
      return jsonResponse(
        {
          error: duplicateReference
            ? "Cette référence de paiement a déjà été déclarée. Vérifiez l'identifiant de transaction."
            : "Vous avez déjà une demande en cours de vérification. Annulez-la pour en envoyer une nouvelle.",
          code: duplicateReference ? "duplicate_reference" : "pending_exists",
        },
        { status: 409, cors },
      );
    }
    console.error("request-subscription insert:", insertError);
    return jsonResponse({ error: "Impossible d'enregistrer la demande" }, { status: 500, cors });
  }

  // ── Operator notification ─────────────────────────────────────────────
  // The request is saved either way and listed in /admin; the email only
  // makes it arrive faster. A missing email configuration must not turn a
  // customer's payment into an error message.
  const email = getEmailConfig();
  let operatorNotified = false;
  if (email) {
    const { data: profile } = await admin
      .from("profiles")
      .select("company_name")
      .eq("id", user.id)
      .maybeSingle();
    const periodLabel = billingPeriod === "annual" ? "annuel" : "mensuel";
    const rows: [string, string][] = [
      ["Client", `${user.email ?? ""}${profile?.company_name ? ` (${profile.company_name})` : ""}`],
      ["Forfait", `${PLAN_LIMITS[plan].label} — ${periodLabel}`],
      ["Montant attendu", formatFcfa(amount)],
      ["Moyen de paiement", PAYMENT_METHODS[paymentMethod]],
      ["Numéro payeur", payerPhone],
      ["Référence", paymentReference],
    ];
    operatorNotified = await sendEmail(email, {
      to: email.operatorTo,
      replyTo: user.email ?? undefined,
      subject: `[Abonnement] ${PLAN_LIMITS[plan].label} ${periodLabel} — ${formatFcfa(amount)} à vérifier`,
      html: emailLayout(
        "Nouveau paiement à vérifier",
        `<p>Vérifiez la transaction dans votre application Mobile Money, puis activez
        l'abonnement depuis le centre de contrôle.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 0;color:#6b7280;">${escapeHtml(k)}</td>` +
                `<td style="padding:6px 0;font-weight:600;">${escapeHtml(v)}</td></tr>`,
            )
            .join("")}
        </table>
        ${email.appUrl ? `<p><a href="${escapeHtml(email.appUrl)}/admin">Ouvrir le centre de contrôle</a></p>` : ""}`,
      ),
    });
  } else {
    console.error("request-subscription: email not configured; request saved without notification");
  }

  return jsonResponse({ request, operatorNotified }, { cors });
});
