import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, CheckCircle2, Clock, Copy, CreditCard, ExternalLink, Loader2, Smartphone, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { profile as profileApi, subscription, type SubscriptionRequest, type SubscriptionState } from "@/lib/api";
import {
  PAYMENT_METHODS,
  PLAN_LIMITS,
  PLAN_PRICES_FCFA,
  isPlanId,
  priceFor,
  resolveEntitlement,
  type BillingPeriod,
  type PaymentMethod,
  type PlanId,
  type SubscriptionFields,
} from "@/lib/plans";

// Where customers are sent when the operator has configured no payment number.
const SUPPORT_EMAIL = "contact@prosocialai.com";

const PLAN_ORDER: PlanId[] = ["starter", "pro", "enterprise"];

const PLAN_HIGHLIGHTS: Record<PlanId, string[]> = {
  starter: [
    `${PLAN_LIMITS.starter.postsPerWeek} posts par semaine`,
    `${PLAN_LIMITS.starter.socialAccounts} réseaux sociaux`,
    `${PLAN_LIMITS.starter.monthlyImageGenerations} affiches IA / mois`,
  ],
  pro: [
    `${PLAN_LIMITS.pro.postsPerWeek} posts par semaine`,
    `${PLAN_LIMITS.pro.socialAccounts} réseaux sociaux`,
    `${PLAN_LIMITS.pro.monthlyImageGenerations} affiches IA / mois`,
  ],
  enterprise: [
    `${PLAN_LIMITS.enterprise.postsPerWeek} posts par semaine`,
    `${PLAN_LIMITS.enterprise.socialAccounts} réseaux sociaux`,
    `${PLAN_LIMITS.enterprise.monthlyImageGenerations} affiches IA / mois`,
    "Réponses IA aux commentaires",
  ],
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  pending: { label: "En vérification", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  approved: { label: "Validé", className: "bg-green-500/15 text-green-600 dark:text-green-400" },
  rejected: { label: "Refusé", className: "bg-destructive/15 text-destructive" },
  cancelled: { label: "Annulé", className: "bg-muted text-muted-foreground" },
};

const fcfa = (amount: number) => `${amount.toLocaleString("fr-FR")} FCFA`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export default function Subscription() {
  useEffect(() => {
    document.title = "Abonnement · Pro Social AI";
  }, []);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [profile, setProfile] = useState<SubscriptionFields | null>(null);
  const [requests, setRequests] = useState<SubscriptionRequest[]>([]);
  const [accounts, setAccounts] = useState<SubscriptionState["paymentAccounts"]>([]);
  const [beneficiary, setBeneficiary] = useState("Pro Social AI");
  const [loading, setLoading] = useState(true);

  const [plan, setPlan] = useState<PlanId>("pro");
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [payerPhone, setPayerPhone] = useState("");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // The route is behind ProtectedRoute; a 401 here means the session expired
  // mid-visit, which the API client reports as a readable message.
  const load = useCallback(async (): Promise<SubscriptionFields | null> => {
    try {
      const [profileRow, state] = await Promise.all([profileApi.get(), subscription.get()]);
      setProfile(profileRow);
      setRequests(state.requests);
      setAccounts(state.paymentAccounts);
      setBeneficiary(state.beneficiary);
      setMethod((current) => current || state.paymentAccounts[0]?.method || "");
      return profileRow;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible de charger votre abonnement.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().then((row) => {
      // Preselect what the customer most likely wants to pay for: the plan in
      // the link, else the one they are trying or already paying for.
      // An expired account resolves to Starter; the plan it had is a better guess.
      const fromLink = searchParams.get("plan");
      if (isPlanId(fromLink)) {
        setPlan(fromLink);
      } else if (row) {
        const current = resolveEntitlement(row);
        const previous = row.subscription_status === "trialing" ? row.trial_plan : row.plan;
        setPlan(current.state === "expired" && isPlanId(previous) ? previous : current.plan);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entitlement = useMemo(() => (profile ? resolveEntitlement(profile) : null), [profile]);
  const pending = requests.find((r) => r.status === "pending") || null;
  const amount = priceFor(plan, period);
  const account = accounts.find((a) => a.method === method) || null;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copié");
    } catch {
      toast.error("Copie impossible — sélectionnez le texte manuellement.");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!method) {
      toast.error("Choisissez le moyen de paiement utilisé.");
      return;
    }
    setSubmitting(true);
    try {
      const data = await subscription.declarePayment({
        plan,
        billingPeriod: period,
        paymentMethod: method,
        payerPhone,
        paymentReference: reference,
      });
      toast.success(
        data.operatorNotified === false
          ? "Demande enregistrée. Nous la vérifions au plus vite."
          : "Demande envoyée ! Vous recevrez un email dès que le paiement est vérifié.",
      );
      setReference("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'envoyer votre demande.");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelPending = async () => {
    if (!pending) return;
    setCancelling(true);
    try {
      await subscription.cancel(pending.id);
      toast.success("Demande annulée. Vous pouvez en envoyer une nouvelle.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Impossible d'annuler la demande.");
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-5xl px-4 py-4 flex items-center gap-3 flex-wrap">
          <Button variant="outline" size="sm" className="glass-card" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Tableau de bord
          </Button>
          <h1 className="font-bold text-xl flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" />
            Abonnement
          </h1>
        </div>
      </header>

      <main className="container mx-auto max-w-5xl px-4 py-6 space-y-6">
        {/* ── Where the account stands ── */}
        {entitlement && (
          <Card className={`glass-card p-5 ${entitlement.state === "expired" ? "border-destructive/50" : ""}`}>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Votre forfait</p>
            {entitlement.state === "trialing" && (
              <>
                <p className="text-lg font-semibold">Essai gratuit — {entitlement.limits.label}</p>
                <p className="text-sm text-muted-foreground">
                  Se termine le {formatDate(entitlement.endsAt!)} (encore {entitlement.daysLeft} jour
                  {entitlement.daysLeft === 1 ? "" : "s"}). Toutes les fonctionnalités du forfait sont incluses.
                </p>
              </>
            )}
            {entitlement.state === "active" && (
              <>
                <p className="text-lg font-semibold">{entitlement.limits.label} — actif</p>
                <p className="text-sm text-muted-foreground">
                  {entitlement.endsAt
                    ? `Payé jusqu'au ${formatDate(entitlement.endsAt)}. Un rappel vous est envoyé quelques jours avant.`
                    : "Sans date d'échéance."}
                </p>
              </>
            )}
            {entitlement.state === "expired" && (
              <>
                <p className="text-lg font-semibold text-destructive">
                  {profile?.subscription_status === "trialing" ? "Essai gratuit terminé" : "Abonnement expiré"}
                </p>
                <p className="text-sm text-muted-foreground">
                  La création de nouveaux posts est en pause. Vos posts déjà programmés continuent d'être
                  publiés. Choisissez un forfait ci-dessous pour tout réactiver.
                </p>
              </>
            )}
          </Card>
        )}

        {/* ── A payment already declared ── */}
        {pending && (
          <Card className="glass-card p-5 border-amber-500/40 bg-amber-500/5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Paiement en cours de vérification</p>
                  <p className="text-sm text-muted-foreground">
                    {PLAN_LIMITS[pending.plan as PlanId]?.label ?? pending.plan} ·{" "}
                    {pending.billing_period === "annual" ? "annuel" : "mensuel"} · {fcfa(pending.amount_fcfa)} ·{" "}
                    {PAYMENT_METHODS[pending.payment_method as PaymentMethod] ?? pending.payment_method} · réf.{" "}
                    <span className="font-mono">{pending.payment_reference}</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Envoyée le {formatDate(pending.created_at)}. Vous recevrez un email dès l'activation,
                    généralement sous 24 h ouvrées.
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={cancelPending} disabled={cancelling}>
                {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : "Annuler cette demande"}
              </Button>
            </div>
          </Card>
        )}

        {!pending && (
          <>
            {/* ── 1. Plan and period ── */}
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h2 className="text-lg font-semibold">1. Choisissez votre forfait</h2>
                <div className="inline-flex items-center gap-1 p-1 rounded-full glass-card" role="group" aria-label="Période de facturation">
                  {(["monthly", "annual"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPeriod(p)}
                      aria-pressed={period === p}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                        period === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p === "monthly" ? "Mensuel" : "Annuel · ≈ 2 mois offerts"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3" role="radiogroup" aria-label="Forfait">
                {PLAN_ORDER.map((id) => {
                  const selected = plan === id;
                  const price = PLAN_PRICES_FCFA[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPlan(id)}
                      className={`text-left rounded-2xl border p-5 transition-all ${
                        selected ? "border-primary ring-2 ring-primary/40 bg-primary/5" : "border-border/60 glass-card hover:border-primary/40"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold">{PLAN_LIMITS[id].label}</span>
                        {selected && <CheckCircle2 className="w-5 h-5 text-primary" />}
                      </div>
                      <p className="text-2xl font-bold">
                        {fcfa(period === "annual" ? price.annualPerMonth : price.monthly)}
                        <span className="text-sm font-normal text-muted-foreground"> /mois</span>
                      </p>
                      {period === "annual" && (
                        <p className="text-xs text-muted-foreground">soit {fcfa(priceFor(id, "annual"))} par an</p>
                      )}
                      <ul className="mt-3 space-y-1.5">
                        {PLAN_HIGHLIGHTS[id].map((line) => (
                          <li key={line} className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                            {line}
                          </li>
                        ))}
                      </ul>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── 2. Pay ── */}
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">2. Payez par Mobile Money</h2>
              {accounts.length === 0 ? (
                <Card className="glass-card p-5">
                  <p className="text-sm">
                    Écrivez-nous à{" "}
                    <a className="underline font-medium" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Abonnement ${PLAN_LIMITS[plan].label}`)}`}>
                      {SUPPORT_EMAIL}
                    </a>{" "}
                    : nous vous envoyons les coordonnées de paiement pour le forfait {PLAN_LIMITS[plan].label} (
                    {fcfa(amount)}).
                  </p>
                </Card>
              ) : (
                <Card className="glass-card p-5 space-y-4">
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Moyen de paiement">
                    {accounts.map((a) => (
                      <button
                        key={a.method}
                        type="button"
                        role="radio"
                        aria-checked={method === a.method}
                        onClick={() => setMethod(a.method)}
                        className={`px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${
                          method === a.method ? "border-primary bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {PAYMENT_METHODS[a.method]}
                      </button>
                    ))}
                  </div>
                  {account && (
                    <div className="rounded-xl bg-muted/40 p-4 space-y-2 text-sm">
                      <p>
                        Envoyez <strong>{fcfa(amount)}</strong> à <strong>{beneficiary}</strong> par{" "}
                        {PAYMENT_METHODS[account.method]} :
                      </p>
                      {account.value.startsWith("https://") ? (
                        <Button asChild size="sm" className="bg-gradient-to-r from-primary to-secondary">
                          <a href={account.value} target="_blank" rel="noopener noreferrer">
                            Payer avec {PAYMENT_METHODS[account.method]}
                            <ExternalLink className="w-4 h-4 ml-2" />
                          </a>
                        </Button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-lg font-semibold">{account.value}</span>
                          <Button type="button" variant="ghost" size="sm" onClick={() => copy(account.value)} aria-label="Copier le numéro">
                            <Copy className="w-4 h-4" />
                          </Button>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Vous recevez ensuite un SMS de confirmation contenant l'identifiant de la transaction.
                      </p>
                    </div>
                  )}
                </Card>
              )}
            </section>

            {/* ── 3. Declare ── */}
            {accounts.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-lg font-semibold">3. Confirmez votre paiement</h2>
                <Card className="glass-card p-5">
                  <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="payer-phone">Numéro qui a payé</Label>
                      <Input
                        id="payer-phone"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="+225 07 00 00 00 00"
                        value={payerPhone}
                        onChange={(e) => setPayerPhone(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="payment-reference">Identifiant de la transaction (SMS)</Label>
                      <Input
                        id="payment-reference"
                        placeholder="Ex. : PP231001.1234.A12345"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        required
                        minLength={4}
                        maxLength={64}
                        aria-describedby="payment-reference-rule"
                      />
                      <p id="payment-reference-rule" className="text-xs text-muted-foreground">
                        Une référence ne peut être déclarée qu'une seule fois : vérifiez-la avant d'envoyer.
                      </p>
                    </div>
                    <div className="md:col-span-2 flex items-center justify-between gap-4 flex-wrap">
                      <p className="text-sm text-muted-foreground">
                        {PLAN_LIMITS[plan].label} · {period === "annual" ? "annuel" : "mensuel"} ·{" "}
                        <strong className="text-foreground">{fcfa(amount)}</strong>
                      </p>
                      <Button type="submit" disabled={submitting} className="bg-gradient-to-r from-primary to-secondary">
                        {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Smartphone className="w-4 h-4 mr-2" />}
                        J'ai payé — envoyer
                      </Button>
                    </div>
                  </form>
                  <p className="text-xs text-muted-foreground mt-4">
                    Nous vérifions chaque paiement avant d'activer le forfait, généralement sous 24 h ouvrées. Aucun
                    prélèvement automatique : vous renouvelez vous-même à chaque échéance, après un rappel par email.
                  </p>
                </Card>
              </section>
            )}
          </>
        )}

        {/* ── History ── */}
        {requests.filter((r) => r.status !== "pending").length > 0 && (
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Historique</h2>
            <Card className="glass-card divide-y divide-border/50">
              {requests
                .filter((r) => r.status !== "pending")
                .map((r) => {
                  const status = STATUS_LABELS[r.status] ?? STATUS_LABELS.cancelled;
                  return (
                    <div key={r.id} className="p-4 flex items-start justify-between gap-4 flex-wrap text-sm">
                      <div>
                        <p className="font-medium">
                          {PLAN_LIMITS[r.plan as PlanId]?.label ?? r.plan} · {r.billing_period === "annual" ? "annuel" : "mensuel"} ·{" "}
                          {fcfa(r.amount_fcfa)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(r.created_at)} · {PAYMENT_METHODS[r.payment_method as PaymentMethod] ?? r.payment_method} · réf.{" "}
                          <span className="font-mono">{r.payment_reference}</span>
                        </p>
                        {r.status === "rejected" && r.admin_note && (
                          <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                            <XCircle className="w-3.5 h-3.5" /> {r.admin_note}
                          </p>
                        )}
                      </div>
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${status.className}`}>{status.label}</span>
                    </div>
                  );
                })}
            </Card>
          </section>
        )}
      </main>
    </div>
  );
}
