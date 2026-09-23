import type pg from "pg";
import { query, queryOne, transaction } from "../lib/db.js";
import { env } from "../lib/env.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { emailLayout, escapeHtml, formatDateFr, formatFcfa } from "../lib/html.js";
import { mailEnabled, sendMail } from "../lib/mail.js";
import {
  PAYMENT_METHODS,
  PLAN_LIMITS,
  isPaymentMethod,
  isPlanId,
  priceFor,
  resolveEntitlement,
  type BillingPeriod,
  type PlanId,
} from "../shared/plans.js";
import { toSubscriptionFields } from "./entitlement.js";

// The subscription lifecycle, server side.
//
// Payment is declarative and verified by a person: the customer pays by
// Mobile Money and declares the transaction reference; the operator checks it
// in their Mobile Money app and approves from /admin. Three properties make
// that safe to run with real money:
//
//   * The amount is computed HERE from the canonical price list. Nothing the
//     customer sends can change what they are asked to pay.
//   * A declaration grants nothing. Only an approval (an operator action)
//     changes the account's plan or its end date.
//   * The database refuses a second pending request per account and a
//     reference reused across requests (unique indexes, migration 0003).

export const MAX_TRIAL_EXTENSION_DAYS = 30;

const PHONE_RE = /^\+?[0-9 ().-]{8,20}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/:#-]{3,63}$/;

export interface SubscriptionRequestRow {
  id: string;
  profile_id: string;
  plan: string;
  billing_period: "monthly" | "annual";
  amount_fcfa: number;
  payment_method: string;
  payer_phone: string;
  payment_reference: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  admin_note: string | null;
  decided_at: Date | null;
  created_at: Date;
}

const REQUEST_COLUMNS = `id, profile_id, plan, billing_period, amount_fcfa, payment_method,
  payer_phone, payment_reference, status, admin_note, decided_at, created_at`;

/** Where the operator is told about payments: CONTACT_TO, else the sender. */
function operatorAddress(): string | null {
  if (env.contactTo) return env.contactTo;
  if (!env.resendFrom) return null;
  return env.resendFrom.match(/<([^>]+)>/)?.[1] ?? env.resendFrom;
}

/** Email is a courtesy on top of a database write: failing to send never fails the action. */
async function notify(to: string | null, subject: string, html: string): Promise<boolean> {
  if (!to || !mailEnabled()) return false;
  try {
    await sendMail({ to, subject, html });
    return true;
  } catch (err) {
    console.error("[subscriptions] email failed:", (err as Error).message);
    return false;
  }
}

const planLabel = (plan: string) => (isPlanId(plan) ? PLAN_LIMITS[plan].label : plan);
const periodLabel = (period: string) => (period === "annual" ? "annuel" : "mensuel");

/**
 * Same calendar day `months` later, clamped to the end of a shorter month
 * (31 January + 1 month = 28/29 February, not 3 March).
 */
export function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** The payment channels the operator configured, for the subscription page. */
export function paymentAccounts(): Array<{ method: string; label: string; value: string }> {
  return Object.entries(env.paymentAccounts)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([method, value]) => ({
      method,
      label: PAYMENT_METHODS[method as keyof typeof PAYMENT_METHODS] ?? method,
      value,
    }));
}

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------

export async function listOwnRequests(profileId: string): Promise<SubscriptionRequestRow[]> {
  return query<SubscriptionRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM subscription_requests
      WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [profileId],
  );
}

export async function createRequest(
  profileId: string,
  input: Record<string, unknown>,
): Promise<{ request: SubscriptionRequestRow; operatorNotified: boolean }> {
  const plan = input.plan;
  if (typeof plan !== "string" || !isPlanId(plan)) throw badRequest("Forfait invalide.");
  const billingPeriod = input.billingPeriod as BillingPeriod;
  if (billingPeriod !== "monthly" && billingPeriod !== "annual") {
    throw badRequest("Période de facturation invalide.");
  }
  const method = input.paymentMethod;
  if (!isPaymentMethod(method)) throw badRequest("Moyen de paiement invalide.");
  const payerPhone = typeof input.payerPhone === "string" ? input.payerPhone.trim() : "";
  if (!PHONE_RE.test(payerPhone)) {
    throw badRequest("Numéro de téléphone invalide. Indiquez le numéro qui a effectué le paiement.");
  }
  const reference = typeof input.paymentReference === "string" ? input.paymentReference.trim() : "";
  if (!REFERENCE_RE.test(reference)) {
    throw badRequest(
      "Référence de paiement invalide. Recopiez l'identifiant de transaction reçu par SMS " +
        "(4 à 64 caractères, lettres et chiffres).",
    );
  }

  const amount = priceFor(plan, billingPeriod);

  let request: SubscriptionRequestRow | null;
  try {
    request = await queryOne<SubscriptionRequestRow>(
      `INSERT INTO subscription_requests
         (profile_id, plan, billing_period, amount_fcfa, payment_method, payer_phone, payment_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${REQUEST_COLUMNS}`,
      [profileId, plan, billingPeriod, amount, method, payerPhone, reference],
    );
  } catch (err) {
    // Both unique indexes are business rules, not failures: say which one.
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === "23505") {
      if (pgErr.constraint === "subscription_requests_reference_unique") {
        throw conflict(
          "Cette référence de paiement a déjà été déclarée. Vérifiez l'identifiant de transaction.",
          "duplicate_reference",
        );
      }
      throw conflict(
        "Vous avez déjà une demande en cours de vérification. Annulez-la pour en envoyer une nouvelle.",
        "pending_exists",
      );
    }
    throw err;
  }
  if (!request) throw badRequest("La demande n'a pas pu être enregistrée.");

  const owner = await queryOne<{ email: string | null; company_name: string | null }>(
    `SELECT email::text AS email, company_name FROM profiles WHERE id = $1`,
    [profileId],
  );
  const rows: Array<[string, string]> = [
    ["Client", `${owner?.email ?? ""}${owner?.company_name ? ` (${owner.company_name})` : ""}`],
    ["Forfait", `${PLAN_LIMITS[plan].label} — ${periodLabel(billingPeriod)}`],
    ["Montant attendu", formatFcfa(amount)],
    ["Moyen de paiement", PAYMENT_METHODS[method]],
    ["Numéro payeur", payerPhone],
    ["Référence", reference],
  ];
  // The request is saved either way and listed in /admin; the email only
  // makes it arrive faster. A missing mail configuration must not turn a
  // customer's payment into an error message.
  const operatorNotified = await notify(
    operatorAddress(),
    `[Abonnement] ${PLAN_LIMITS[plan].label} ${periodLabel(billingPeriod)} — ${formatFcfa(amount)} à vérifier`,
    emailLayout(
      "Nouveau paiement à vérifier",
      `<p>Vérifiez la transaction dans votre application Mobile Money, puis validez
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
       ${env.appPublicUrl ? `<p><a href="${escapeHtml(env.appPublicUrl)}/admin">Ouvrir le centre de contrôle</a></p>` : ""}`,
    ),
  );

  return { request, operatorNotified };
}

export async function cancelOwnRequest(profileId: string, requestId: string): Promise<void> {
  const row = await queryOne(
    `UPDATE subscription_requests SET status = 'cancelled', decided_at = now()
      WHERE id = $1 AND profile_id = $2 AND status = 'pending'
      RETURNING id`,
    [requestId, profileId],
  );
  if (!row) throw conflict("Cette demande a déjà été traitée.", "already_decided");
}

// ---------------------------------------------------------------------------
// Operator side
// ---------------------------------------------------------------------------

export async function listRequestsForAdmin() {
  return query(
    `SELECT r.id, r.profile_id, r.plan, r.billing_period, r.amount_fcfa, r.payment_method,
            r.payer_phone, r.payment_reference, r.status, r.admin_note, r.decided_at, r.created_at,
            p.email::text AS email, p.company_name
       FROM subscription_requests r
       JOIN profiles p ON p.id = r.profile_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
      LIMIT 100`,
  );
}

/**
 * Approves or rejects a pending payment declaration.
 *
 * Runs in one transaction with the request row locked, so two operators
 * clicking at once cannot both grant the same payment, and a payment is never
 * left "approved" on an account that was not upgraded.
 */
export async function decideRequest(input: {
  requestId: string;
  approve: boolean;
  note: string | null;
  deciderId: string;
}): Promise<{ currentPeriodEndsAt: string | null }> {
  const outcome = await transaction(async (client: pg.PoolClient) => {
    const request = (
      await client.query<SubscriptionRequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM subscription_requests WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      )
    ).rows[0];
    if (!request) throw notFound("Demande introuvable.");
    if (request.status !== "pending") throw conflict("Cette demande a déjà été traitée.", "already_decided");

    const owner = (
      await client.query<{
        email: string | null;
        subscription_status: string;
        current_period_ends_at: Date | null;
      }>(
        `SELECT email::text AS email, subscription_status, current_period_ends_at
           FROM profiles WHERE id = $1 FOR UPDATE`,
        [request.profile_id],
      )
    ).rows[0];
    if (!owner) throw notFound("Compte introuvable.");

    await client.query(
      `UPDATE subscription_requests
          SET status = $2, admin_note = $3, decided_at = now(), decided_by = $4
        WHERE id = $1`,
      [request.id, input.approve ? "approved" : "rejected", input.note, input.deciderId],
    );

    if (!input.approve) return { request, owner, periodEnd: null as Date | null };

    // A renewal paid while the current paid period still runs extends it (no
    // day is lost by paying early); anything else starts today. An upgrade
    // mid-period applies the new plan at once and extends from the current
    // end date, in the customer's favour.
    const now = new Date();
    const currentEnd = owner.current_period_ends_at;
    const base = owner.subscription_status === "active" && currentEnd && currentEnd > now ? currentEnd : now;
    const periodEnd = addMonths(base, request.billing_period === "annual" ? 12 : 1);
    await client.query(
      `UPDATE profiles
          SET plan = $2, subscription_status = 'active', current_period_ends_at = $3,
              expiry_reminder_sent_at = NULL
        WHERE id = $1`,
      [request.profile_id, request.plan, periodEnd],
    );
    return { request, owner, periodEnd };
  });

  // Emails after the commit: a customer is never told about a change that
  // then rolled back.
  const { request, owner, periodEnd } = outcome;
  const link = env.appPublicUrl;
  if (periodEnd) {
    await notify(
      owner.email,
      `Votre abonnement ${planLabel(request.plan)} est actif`,
      emailLayout(
        "Merci, votre abonnement est actif",
        `<p>Votre paiement de ${escapeHtml(formatFcfa(request.amount_fcfa))} a été confirmé.
         Votre forfait <strong>${escapeHtml(planLabel(request.plan))}</strong> est actif jusqu'au
         <strong>${escapeHtml(formatDateFr(periodEnd))}</strong>.</p>
         <p>Nous vous enverrons un rappel quelques jours avant l'échéance.</p>
         ${link ? `<p><a href="${escapeHtml(link)}/dashboard">Ouvrir mon tableau de bord</a></p>` : ""}`,
      ),
    );
  } else {
    await notify(
      owner.email,
      "Votre paiement Pro Social AI n'a pas pu être confirmé",
      emailLayout(
        "Paiement non confirmé",
        `<p>Nous n'avons pas pu confirmer votre paiement de ${escapeHtml(formatFcfa(request.amount_fcfa))}
         (référence <strong>${escapeHtml(request.payment_reference)}</strong>) pour le forfait
         ${escapeHtml(planLabel(request.plan))}.</p>
         ${input.note ? `<p><strong>Motif :</strong> ${escapeHtml(input.note)}</p>` : ""}
         <p>Vérifiez la référence de la transaction et renvoyez votre demande, ou répondez à cet
         email si vous pensez qu'il s'agit d'une erreur.</p>
         ${link ? `<p><a href="${escapeHtml(link)}/abonnement">Revenir à mon abonnement</a></p>` : ""}`,
      ),
    );
  }
  return { currentPeriodEndsAt: periodEnd ? periodEnd.toISOString() : null };
}

/**
 * Grants a plan by hand (a complimentary account, a payment received outside
 * the app). A paid period still running keeps its end date — this is a plan
 * change, not a free extension; an elapsed one is cleared, otherwise the
 * account would stay expired and the change would appear to do nothing.
 */
export async function setPlanManually(profileId: string, plan: PlanId): Promise<void> {
  const row = await queryOne(
    `UPDATE profiles
        SET plan = $2,
            subscription_status = 'active',
            current_period_ends_at = CASE
              WHEN current_period_ends_at > now() THEN current_period_ends_at
              ELSE NULL
            END
      WHERE id = $1
      RETURNING id`,
    [profileId, plan],
  );
  if (!row) throw notFound("Compte introuvable.");
}

/**
 * Gives a prospect a few more days to decide. Counted from the later of now
 * and the current trial end, so extending an expired trial reopens it and
 * extending a running one does not waste its remainder.
 */
export async function extendTrial(profileId: string, days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRIAL_EXTENSION_DAYS) {
    throw badRequest(`Durée invalide (1 à ${MAX_TRIAL_EXTENSION_DAYS} jours).`);
  }
  const row = await queryOne(
    `UPDATE profiles
        SET trial_ends_at = GREATEST(now(), COALESCE(trial_ends_at, now())) + make_interval(days => $2),
            expiry_reminder_sent_at = NULL
      WHERE id = $1 AND subscription_status = 'trialing'
      RETURNING id`,
    [profileId, days],
  );
  if (!row) throw badRequest("Ce compte n'est pas en essai.");
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

// How far ahead each kind of end date is announced.
const TRIAL_NOTICE_DAYS = 2;
const PERIOD_NOTICE_DAYS = 3;

/**
 * Emails each account once before its trial or paid period ends.
 *
 * There is no automatic debit, so a paid month simply runs out; without this
 * every renewal would depend on the customer remembering the date. Each end
 * date is reminded at most once, and only marked after a successful send, so
 * running it hourly is harmless and a mail outage delays reminders rather
 * than losing them.
 */
export async function runSubscriptionReminders(): Promise<{ sent: number; failed: number; skipped?: string }> {
  if (!mailEnabled()) return { sent: 0, failed: 0, skipped: "email_not_configured" };

  const rows = await query<{
    id: string;
    email: string | null;
    company_name: string | null;
    plan: string;
    subscription_status: string;
    trial_plan: string;
    trial_ends_at: Date | null;
    current_period_ends_at: Date | null;
  }>(
    `SELECT id, email::text AS email, company_name, plan, subscription_status, trial_plan,
            trial_ends_at, current_period_ends_at
       FROM profiles
      WHERE blocked_at IS NULL
        AND email IS NOT NULL
        AND expiry_reminder_sent_at IS NULL
        AND (
          (subscription_status = 'trialing'
            AND trial_ends_at > now()
            AND trial_ends_at <= now() + make_interval(days => $1))
          OR
          (subscription_status = 'active'
            AND current_period_ends_at > now()
            AND current_period_ends_at <= now() + make_interval(days => $2))
        )
      LIMIT 200`,
    [TRIAL_NOTICE_DAYS, PERIOD_NOTICE_DAYS],
  );

  let sent = 0;
  let failed = 0;
  const link = env.appPublicUrl ? `${env.appPublicUrl}/abonnement` : "";
  for (const row of rows) {
    const entitlement = resolveEntitlement(toSubscriptionFields(row));
    if (entitlement.state === "expired" || !entitlement.endsAt) continue;
    const isTrial = entitlement.state === "trialing";
    const when = new Date(entitlement.endsAt).toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Africa/Abidjan",
    });
    const label = entitlement.limits.label;
    const ok = await notify(
      row.email,
      isTrial
        ? `Votre essai gratuit Pro Social AI se termine ${when}`
        : `Votre abonnement Pro Social AI arrive à échéance ${when}`,
      emailLayout(
        isTrial ? "Votre essai se termine bientôt" : "Votre abonnement arrive à échéance",
        `<p>Bonjour${row.company_name ? ` ${escapeHtml(row.company_name)}` : ""},</p>
         <p>${
           isTrial
             ? `Votre essai gratuit du forfait <strong>${escapeHtml(label)}</strong> se termine
                <strong>${escapeHtml(when)}</strong>. Pour continuer à générer vos posts et affiches
                sans interruption, choisissez votre forfait dès maintenant — le paiement se fait par
                Wave, Orange Money, MTN ou Moov.`
             : `Votre abonnement <strong>${escapeHtml(label)}</strong> arrive à échéance
                <strong>${escapeHtml(when)}</strong>. Renouvelez-le pour que la génération de vos
                posts continue sans interruption.`
         }</p>
         <p>Sans renouvellement, vos posts déjà programmés seront quand même publiés ; seule la
         création de nouveaux contenus est mise en pause.</p>
         ${
           link
             ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#1e3a8a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Choisir mon forfait</a></p>`
             : ""
         }`,
      ),
    );
    if (ok) {
      // Marked for the end date that was announced: if an approval moved it
      // meanwhile, the new date gets its own reminder.
      await query(
        isTrial
          ? `UPDATE profiles SET expiry_reminder_sent_at = now() WHERE id = $1 AND trial_ends_at = $2`
          : `UPDATE profiles SET expiry_reminder_sent_at = now() WHERE id = $1 AND current_period_ends_at = $2`,
        [row.id, isTrial ? row.trial_ends_at : row.current_period_ends_at],
      );
      sent++;
    } else {
      failed++;
    }
  }
  return { sent, failed };
}
