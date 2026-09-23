import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Clock, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { subscription } from "@/lib/api";
import { resolveEntitlement, type SubscriptionFields } from "@/lib/plans";

// Paid periods are announced this many days ahead (the reminder email goes
// out at 3); earlier than that, a banner on every visit is just noise.
const RENEWAL_NOTICE_DAYS = 5;

function daysLabel(days: number): string {
  return days <= 1 ? "moins de 24 h" : `${days} jours`;
}

/**
 * Where the account stands, on the screen people open every day: trial days
 * left, a paid period about to end, or generation paused. Renders nothing for
 * an account with no deadline in sight.
 */
export function SubscriptionBanner({ profile }: { profile: SubscriptionFields | null }) {
  const [pendingPayment, setPendingPayment] = useState(false);
  const entitlement = profile ? resolveEntitlement(profile) : null;
  const relevant =
    !!entitlement &&
    (entitlement.state !== "active" ||
      (entitlement.daysLeft !== null && entitlement.daysLeft <= RENEWAL_NOTICE_DAYS));

  // Only asked when a deadline is in sight: most dashboards never make this call.
  useEffect(() => {
    if (!relevant) return;
    let cancelled = false;
    subscription
      .get()
      .then((state) => {
        if (!cancelled) setPendingPayment(state.requests.some((r) => r.status === "pending"));
      })
      .catch(() => {
        // The banner still shows the deadline; only the "being verified" hint is lost.
      });
    return () => {
      cancelled = true;
    };
  }, [relevant]);

  if (!entitlement || !relevant) return null;

  const cta = pendingPayment ? (
    <Button asChild size="sm" variant="outline" className="glass-card">
      <Link to="/abonnement">Paiement en cours de vérification</Link>
    </Button>
  ) : (
    <Button asChild size="sm" className="bg-gradient-to-r from-primary to-secondary">
      <Link to="/abonnement">
        {entitlement.state === "active" ? "Renouveler" : "Choisir mon forfait"}
      </Link>
    </Button>
  );

  if (entitlement.state === "expired") {
    const wasTrial = profile?.subscription_status === "trialing";
    return (
      <Card className="glass-card p-4 mb-6 border-destructive/50 bg-destructive/5" role="alert">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold">
                {wasTrial ? "Votre essai gratuit est terminé" : "Votre abonnement a expiré"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                La création de nouveaux posts est en pause. Vos posts déjà programmés
                continuent d'être publiés.
              </p>
            </div>
          </div>
          {cta}
        </div>
      </Card>
    );
  }

  const days = entitlement.daysLeft ?? 0;
  const urgent = days <= 2;
  const isTrial = entitlement.state === "trialing";
  const Icon = isTrial ? Gift : Clock;

  return (
    <Card className={`glass-card p-4 mb-6 ${urgent ? "border-amber-500/50 bg-amber-500/5" : "border-primary/30"}`}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${urgent ? "text-amber-500" : "text-primary"}`} />
          <div>
            <p className="text-sm font-semibold">
              {isTrial
                ? `Essai gratuit ${entitlement.limits.label} — encore ${daysLabel(days)}`
                : `Votre abonnement ${entitlement.limits.label} se termine dans ${daysLabel(days)}`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {isTrial
                ? "Toutes les fonctionnalités du forfait sont incluses. Choisissez votre forfait avant la fin pour ne rien interrompre."
                : "Aucun prélèvement automatique : renouvelez pour continuer à générer vos posts."}
            </p>
          </div>
        </div>
        {cta}
      </div>
    </Card>
  );
}
