import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { admin } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Activity, BarChart3, Ban, CheckCircle2, CreditCard, KeyRound, LogOut, Plus, RefreshCw, Search, Send, ShieldCheck, TimerReset, Trash2, Unplug, Users, XCircle } from "lucide-react";
import { PAYMENT_METHODS, PLAN_LIMITS, resolveEntitlement, type PaymentMethod, type PlanId, type SubscriptionFields } from "@/lib/plans";

type AdminUser = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  role: "user" | "admin" | "super_admin";
  blocked: boolean;
  /** Computed by the server: this operator may not act on that account. */
  protectedOwner?: boolean;
  profile: (SubscriptionFields & { company_name?: string | null; sector?: string | null }) | null;
  posts: { total: number; published: number };
  generations: number;
  connections: number;
};

type Overview = {
  actor: AdminUser;
  stats: { users: number; active: number; blocked: number; admins: number; posts: number; published: number; generations: number; connections: number; pendingSubscriptions?: number };
  users: AdminUser[];
};

type PaymentRequest = {
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
  created_at: string;
  email: string | null;
  company_name: string | null;
};

const REQUEST_STATUS: Record<PaymentRequest["status"], string> = {
  pending: "À vérifier",
  approved: "Validé",
  rejected: "Refusé",
  cancelled: "Annulé par le client",
};

const fcfa = (amount: number) => `${amount.toLocaleString("fr-FR")} FCFA`;
const planLabel = (plan: string) => PLAN_LIMITS[plan as PlanId]?.label ?? plan;
const methodLabel = (method: string) => PAYMENT_METHODS[method as PaymentMethod] ?? method;

/** One-line billing state for an account row. */
function billingSummary(profile: AdminUser["profile"]): { text: string; tone: "default" | "secondary" | "destructive" | "outline" } {
  if (!profile) return { text: "Profil absent", tone: "outline" };
  const e = resolveEntitlement(profile);
  if (e.state === "trialing") return { text: `Essai ${e.limits.label} · J-${e.daysLeft}`, tone: "outline" };
  if (e.state === "expired") return { text: profile.subscription_status === "trialing" ? "Essai terminé" : "Abonnement expiré", tone: "destructive" };
  return {
    text: e.endsAt ? `${e.limits.label} · jusqu'au ${new Date(e.endsAt).toLocaleDateString("fr-FR")}` : `${e.limits.label} · offert`,
    tone: "default",
  };
}

// An empty plan creates the account on the standard free trial.
const defaultCreate = { email: "", password: "", companyName: "", plan: "", role: "user" };

export default function Admin() {
  const navigate = useNavigate();
  const { signOut: endSession } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(defaultCreate);
  const [payments, setPayments] = useState<PaymentRequest[]>([]);

  // The server re-checks the admin role on every one of these calls; the page
  // rendering is only a convenience.
  const invoke = async (body: Record<string, unknown>) => admin.action<Overview>(body);

  const loadPayments = async () => {
    try {
      const response = await admin.action<{ requests: PaymentRequest[] }>({ action: "subscriptions" });
      setPayments(response.requests || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Paiements indisponibles");
    }
  };

  const decide = async (request: PaymentRequest, approve: boolean) => {
    let note: string | null = null;
    if (approve) {
      const ok = window.confirm(
        `Confirmez-vous avoir reçu ${fcfa(request.amount_fcfa)} via ${methodLabel(request.payment_method)} ` +
          `(réf. ${request.payment_reference}) ?\n\nLe forfait ${planLabel(request.plan)} sera activé immédiatement.`,
      );
      if (!ok) return;
    } else {
      note = window.prompt("Motif du refus (envoyé au client) :", "Transaction introuvable avec cette référence.");
      if (note === null) return;
    }
    setBusy(request.id);
    try {
      await admin.action({ action: approve ? "approve_subscription" : "reject_subscription", requestId: request.id, note });
      toast.success(approve ? "Abonnement activé — le client est prévenu par email" : "Demande refusée — le client est prévenu");
      await Promise.all([loadPayments(), load()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action impossible");
    } finally { setBusy(null); }
  };

  const load = async () => {
    setLoading(true);
    try {
      setData(await invoke({ action: "overview" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Impossible de charger l’administration");
    } finally {
      setLoading(false);
    }
  };

  // The admin API client is stable for the lifetime of this page; run the
  // initial overview exactly once and let explicit actions refresh it later.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); void loadPayments(); }, []);

  const users = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data?.users || [];
    return (data?.users || []).filter((user) =>
      [user.email, user.profile?.company_name, user.profile?.sector, user.profile?.plan, billingSummary(user.profile).text, user.role]
        .some((value) => String(value || "").toLowerCase().includes(needle)),
    );
  }, [data, query]);

  const action = async (user: AdminUser, body: Record<string, unknown>, success: string) => {
    setBusy(user.id);
    try {
      await invoke({ ...body, userId: user.id });
      toast.success(success);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action impossible");
    } finally { setBusy(null); }
  };

  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("create");
    try {
      await invoke({ action: "create_user", ...form });
      toast.success("Compte créé et activé");
      setCreateOpen(false);
      setForm(defaultCreate);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Création impossible");
    } finally { setBusy(null); }
  };

  const resetPassword = async (user: AdminUser) => {
    const password = window.prompt(`Nouveau mot de passe temporaire pour ${user.email} (8 caractères minimum) :`);
    if (!password) return;
    await action(user, { action: "reset_password", password }, "Mot de passe remplacé");
  };

  const signOut = async () => {
    await endSession();
    navigate("/auth");
  };

  const stats = data?.stats;
  const cards = [
    { label: "Utilisateurs", value: stats?.users ?? 0, icon: Users, detail: `${stats?.active ?? 0} actifs` },
    { label: "Publications", value: stats?.posts ?? 0, icon: Send, detail: `${stats?.published ?? 0} publiées` },
    { label: "Générations IA", value: stats?.generations ?? 0, icon: Activity, detail: "activité totale" },
    { label: "Réseaux connectés", value: stats?.connections ?? 0, icon: Unplug, detail: `${stats?.admins ?? 0} administrateur(s)` },
  ];
  const pendingPayments = payments.filter((p) => p.status === "pending");
  const decidedPayments = payments.filter((p) => p.status !== "pending").slice(0, 10);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-r from-primary to-secondary text-white"><ShieldCheck /></div>
            <div><p className="font-bold text-lg">Centre de contrôle</p><p className="text-xs text-muted-foreground">Pro Social AI · Super administration</p></div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")}><BarChart3 className="mr-2 h-4 w-4" />Plateforme</Button>
            <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="mr-2 h-4 w-4" />Quitter</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-7 px-4 py-7">
        <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div><h1 className="text-3xl font-bold tracking-tight">Pilotage global</h1><p className="text-muted-foreground">Comptes, forfaits, accès et activité de toute la plateforme.</p></div>
          <div className="flex gap-2"><Button variant="outline" onClick={() => { void load(); void loadPayments(); }} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Actualiser</Button><Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Créer un compte</Button></div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(({ label, value, icon: Icon, detail }) => <Card key={label} className="p-5"><div className="mb-4 flex items-center justify-between"><p className="text-sm text-muted-foreground">{label}</p><Icon className="h-5 w-5 text-primary" /></div><p className="text-3xl font-bold">{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></Card>)}
        </section>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-1 border-b p-5">
            <h2 className="font-semibold text-xl flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              Paiements à vérifier
              {pendingPayments.length > 0 && <Badge variant="destructive">{pendingPayments.length}</Badge>}
            </h2>
            <p className="text-sm text-muted-foreground">
              Vérifiez chaque transaction dans votre application Mobile Money avant de valider : la validation active le forfait et prévient le client.
            </p>
          </div>
          {pendingPayments.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">Aucun paiement en attente.</p>
          ) : (
            <div className="divide-y">
              {pendingPayments.map((request) => {
                const isBusy = busy === request.id;
                return (
                  <div key={request.id} className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold break-all">{request.email || request.profile_id}{request.company_name ? ` · ${request.company_name}` : ""}</p>
                      <p className="mt-1 text-sm">
                        <strong>{fcfa(request.amount_fcfa)}</strong> · {planLabel(request.plan)} {request.billing_period === "annual" ? "annuel" : "mensuel"} · {methodLabel(request.payment_method)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Réf. <span className="font-mono text-foreground">{request.payment_reference}</span> · payé depuis {request.payer_phone} · déclaré le {new Date(request.created_at).toLocaleString("fr-FR")}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={isBusy} onClick={() => decide(request, true)}><CheckCircle2 className="mr-2 h-4 w-4" />Valider</Button>
                      <Button size="sm" variant="outline" disabled={isBusy} onClick={() => decide(request, false)}><XCircle className="mr-2 h-4 w-4" />Refuser</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {decidedPayments.length > 0 && (
            <details className="border-t">
              <summary className="cursor-pointer p-5 text-sm text-muted-foreground">Dernières décisions ({decidedPayments.length})</summary>
              <div className="divide-y border-t">
                {decidedPayments.map((request) => (
                  <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                    <span className="break-all">{request.email || request.profile_id} · {planLabel(request.plan)} · {fcfa(request.amount_fcfa)} · réf. <span className="font-mono">{request.payment_reference}</span></span>
                    <Badge variant={request.status === "approved" ? "default" : "secondary"}>{REQUEST_STATUS[request.status]}</Badge>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
            <div><h2 className="font-semibold text-xl">Gestion des comptes</h2><p className="text-sm text-muted-foreground">{users.length} compte(s) affiché(s)</p></div>
            <div className="relative w-full sm:max-w-sm"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Email, entreprise, secteur…" /></div>
          </div>
          {loading ? <div className="p-12 text-center text-muted-foreground animate-pulse">Chargement des comptes…</div> : (
            <div className="divide-y">
              {users.map((user) => {
                const isBusy = busy === user.id;
                const protectedOwner = Boolean(user.protectedOwner);
                const billing = billingSummary(user.profile);
                return <div key={user.id} className="p-5 hover:bg-muted/20">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><p className="font-semibold break-all">{user.email}</p>{user.role !== "user" && <Badge>{user.role === "super_admin" ? "Super administrateur" : "Administrateur"}</Badge>}<Badge variant={user.blocked ? "destructive" : "secondary"}>{user.blocked ? "Bloqué" : "Actif"}</Badge><Badge variant={billing.tone}>{billing.text}</Badge></div>
                      <p className="mt-1 text-sm text-muted-foreground">{user.profile?.company_name || "Entreprise non renseignée"} · {user.profile?.sector || "Profil à compléter"}</p>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>{user.posts.total} publication(s), {user.posts.published} publiée(s)</span><span>{user.generations} génération(s) IA</span><span>{user.connections} réseau(x)</span><span>Dernière connexion : {user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleDateString("fr-FR") : "jamais"}</span></div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select className="h-9 rounded-md border bg-background px-3 text-sm" title="Attribuer un forfait à la main (sans paiement déclaré)" value="" disabled={isBusy} onChange={(e) => e.target.value && window.confirm(`Attribuer le forfait ${planLabel(e.target.value)} à ${user.email} ? Il devient actif immédiatement.`) && action(user, { action: "set_plan", plan: e.target.value }, "Forfait attribué")}><option value="">Attribuer un forfait…</option><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select>
                      {user.profile?.subscription_status === "trialing" && <Button variant="outline" size="sm" title="Prolonger l'essai de 7 jours" disabled={isBusy} onClick={() => action(user, { action: "extend_trial", days: 7 }, "Essai prolongé de 7 jours")}><TimerReset className="mr-1 h-4 w-4" />+7 j</Button>}
                      <select className="h-9 rounded-md border bg-background px-3 text-sm" value={user.role} disabled={isBusy || protectedOwner} onChange={(e) => action(user, { action: "set_role", role: e.target.value }, "Rôle mis à jour")}><option value="user">Utilisateur</option><option value="admin">Administrateur</option><option value="super_admin">Super administrateur</option></select>
                      {!protectedOwner && <Button variant="outline" size="sm" disabled={isBusy} onClick={() => resetPassword(user)}><KeyRound className="h-4 w-4" /></Button>}
                      {!protectedOwner && <Button variant="outline" size="sm" disabled={isBusy} onClick={() => action(user, { action: "set_blocked", blocked: !user.blocked }, user.blocked ? "Compte réactivé" : "Compte bloqué")}>{user.blocked ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />}</Button>}
                      {!protectedOwner && <Button variant="destructive" size="sm" disabled={isBusy} onClick={() => window.confirm(`Supprimer définitivement ${user.email} ?`) && action(user, { action: "delete_user" }, "Compte supprimé")}><Trash2 className="h-4 w-4" /></Button>}
                    </div>
                  </div>
                </div>;
              })}
              {!users.length && <div className="p-12 text-center text-muted-foreground">Aucun compte ne correspond à la recherche.</div>}
            </div>
          )}
        </Card>
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Créer un compte</DialogTitle><DialogDescription>Le compte sera confirmé et immédiatement utilisable.</DialogDescription></DialogHeader><form onSubmit={createUser} className="space-y-4"><div><Label>Email</Label><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div><div><Label>Mot de passe initial</Label><Input type="text" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div><div><Label>Entreprise</Label><Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></div><div className="grid grid-cols-2 gap-3"><div><Label>Forfait</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}><option value="">Essai gratuit</option><option value="starter">Starter (offert)</option><option value="pro">Pro (offert)</option><option value="enterprise">Enterprise (offert)</option></select></div><div><Label>Rôle</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="user">Utilisateur</option><option value="admin">Administrateur</option><option value="super_admin">Super admin</option></select></div></div><Button className="w-full" type="submit" disabled={busy === "create"}>{busy === "create" ? "Création…" : "Créer et activer"}</Button></form></DialogContent></Dialog>
    </div>
  );
}
