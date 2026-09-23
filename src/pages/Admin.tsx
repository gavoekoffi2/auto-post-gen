import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Activity, AlertTriangle, BarChart3, Ban, CheckCircle2, HeartPulse, KeyRound, LogOut, Plus, RefreshCw, Search, Send, ShieldCheck, Trash2, Unplug, Users, XCircle } from "lucide-react";
import { usePageMeta } from "@/lib/usePageMeta";

type AdminUser = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  role: "user" | "admin" | "super_admin";
  blocked: boolean;
  /** Owner account: cannot be demoted, blocked or deleted (enforced server-side). */
  protectedOwner?: boolean;
  profile: { company_name?: string | null; sector?: string | null; plan?: string | null } | null;
  posts: { total: number; published: number };
  generations: number;
  connections: number;
};

type CheckStatus = "ok" | "warn" | "error" | "skipped";

type HealthCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
};

type Health = {
  status: CheckStatus;
  checkedAt: string;
  checks: HealthCheck[];
};

type Overview = {
  actor: AdminUser;
  stats: { users: number; active: number; blocked: number; admins: number; posts: number; published: number; generations: number; connections: number };
  /** The headline totals are exact; the per-account columns come from a capped sample. */
  perUserTruncated?: boolean;
  users: AdminUser[];
};

const defaultCreate = { email: "", password: "", companyName: "", plan: "enterprise", role: "user" };

const HEALTH_TONE: Record<CheckStatus, { icon: typeof CheckCircle2; text: string; badge: string; summary: string }> = {
  ok: { icon: CheckCircle2, text: "text-green-600", badge: "bg-green-500/15 text-green-600", summary: "Tout est opérationnel" },
  warn: { icon: AlertTriangle, text: "text-amber-600", badge: "bg-amber-500/15 text-amber-600", summary: "Points d'attention" },
  error: { icon: XCircle, text: "text-destructive", badge: "bg-destructive/15 text-destructive", summary: "Action requise" },
  skipped: { icon: AlertTriangle, text: "text-muted-foreground", badge: "bg-muted text-muted-foreground", summary: "Diagnostic partiel" },
};

export default function Admin() {
  usePageMeta("Centre de contrôle");

  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(defaultCreate);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const invoke = async (body: Record<string, unknown>) => {
    const { data: response, error } = await supabase.functions.invoke("admin-api", { body });
    if (error) throw error;
    if (response?.error) throw new Error(response.error);
    return response;
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

  // Live diagnosis of the whole platform: secrets, AI/publishing providers and
  // the scheduled pipeline. Separate from the overview because it makes
  // outbound calls to third parties and is therefore slower.
  const loadHealth = async () => {
    setHealthLoading(true);
    try {
      setHealth(await invoke({ action: "health" }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Diagnostic indisponible");
    } finally {
      setHealthLoading(false);
    }
  };

  // The admin API client is stable for the lifetime of this page; run the
  // initial overview exactly once and let explicit actions refresh it later.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); void loadHealth(); }, []);

  const users = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data?.users || [];
    return (data?.users || []).filter((user) =>
      [user.email, user.profile?.company_name, user.profile?.sector, user.profile?.plan, user.role]
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
    await supabase.auth.signOut();
    navigate("/auth");
  };

  const stats = data?.stats;
  const cards = [
    { label: "Utilisateurs", value: stats?.users ?? 0, icon: Users, detail: `${stats?.active ?? 0} actifs` },
    { label: "Publications", value: stats?.posts ?? 0, icon: Send, detail: `${stats?.published ?? 0} publiées` },
    { label: "Générations IA", value: stats?.generations ?? 0, icon: Activity, detail: "activité totale" },
    { label: "Réseaux connectés", value: stats?.connections ?? 0, icon: Unplug, detail: `${stats?.admins ?? 0} administrateur(s)` },
  ];

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
          <div className="flex gap-2"><Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Actualiser</Button><Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Créer un compte</Button></div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(({ label, value, icon: Icon, detail }) => <Card key={label} className="p-5"><div className="mb-4 flex items-center justify-between"><p className="text-sm text-muted-foreground">{label}</p><Icon className="h-5 w-5 text-primary" /></div><p className="text-3xl font-bold">{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></Card>)}
        </section>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${HEALTH_TONE[health?.status ?? "skipped"].badge}`}>
                <HeartPulse className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-semibold text-xl">État de la plateforme</h2>
                <p className="text-sm text-muted-foreground">
                  {healthLoading
                    ? "Diagnostic en cours…"
                    : health
                      ? `${HEALTH_TONE[health.status].summary} · vérifié à ${new Date(health.checkedAt).toLocaleTimeString("fr-FR")}`
                      : "Diagnostic non exécuté"}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadHealth} disabled={healthLoading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${healthLoading ? "animate-spin" : ""}`} />
              Relancer le diagnostic
            </Button>
          </div>

          {health && (
            <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
              {health.checks.map((check) => {
                const tone = HEALTH_TONE[check.status];
                const Icon = tone.icon;
                return (
                  <div key={check.id} className="bg-background p-4">
                    <div className="flex items-start gap-2">
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.text}`} />
                      <div className="min-w-0">
                        <p className="font-medium text-sm break-all">{check.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
                        {check.remedy && (
                          <p className={`mt-1.5 text-xs ${tone.text}`}>→ {check.remedy}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-xl">Gestion des comptes</h2>
              <p className="text-sm text-muted-foreground">{users.length} compte(s) affiché(s)</p>
              {data?.perUserTruncated && (
                <p className="mt-1 text-xs text-amber-600">
                  Les totaux en haut de page sont exacts ; les compteurs par compte
                  ci-dessous portent sur les 5 000 lignes les plus récentes.
                </p>
              )}
            </div>
            <div className="relative w-full sm:max-w-sm"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Email, entreprise, secteur…" /></div>
          </div>
          {loading ? <div className="p-12 text-center text-muted-foreground animate-pulse">Chargement des comptes…</div> : (
            <div className="divide-y">
              {users.map((user) => {
                const isBusy = busy === user.id;
                const protectedOwner = user.protectedOwner;
                return <div key={user.id} className="p-5 hover:bg-muted/20">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><p className="font-semibold break-all">{user.email}</p>{user.role !== "user" && <Badge>{user.role === "super_admin" ? "Super administrateur" : "Administrateur"}</Badge>}<Badge variant={user.blocked ? "destructive" : "secondary"}>{user.blocked ? "Bloqué" : "Actif"}</Badge></div>
                      <p className="mt-1 text-sm text-muted-foreground">{user.profile?.company_name || "Entreprise non renseignée"} · {user.profile?.sector || "Profil à compléter"}</p>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>{user.posts.total} publication(s), {user.posts.published} publiée(s)</span><span>{user.generations} génération(s) IA</span><span>{user.connections} réseau(x)</span><span>Dernière connexion : {user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleDateString("fr-FR") : "jamais"}</span></div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select className="h-9 rounded-md border bg-background px-3 text-sm" value={user.profile?.plan || "starter"} disabled={isBusy} onChange={(e) => action(user, { action: "set_plan", plan: e.target.value }, "Forfait mis à jour")}><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select>
                      <select className="h-9 rounded-md border bg-background px-3 text-sm" value={user.role} disabled={isBusy || protectedOwner} onChange={(e) => action(user, { action: "set_role", role: e.target.value }, "Rôle mis à jour")}><option value="user">Utilisateur</option><option value="admin">Administrateur</option><option value="super_admin">Super administrateur</option></select>
                      <Button variant="outline" size="sm" disabled={isBusy} onClick={() => resetPassword(user)}><KeyRound className="h-4 w-4" /></Button>
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><DialogHeader><DialogTitle>Créer un compte</DialogTitle><DialogDescription>Le compte sera confirmé et immédiatement utilisable.</DialogDescription></DialogHeader><form onSubmit={createUser} className="space-y-4"><div><Label>Email</Label><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div><div><Label>Mot de passe initial</Label><Input type="text" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div><div><Label>Entreprise</Label><Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></div><div className="grid grid-cols-2 gap-3"><div><Label>Forfait</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}><option value="starter">Starter</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></select></div><div><Label>Rôle</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="user">Utilisateur</option><option value="admin">Administrateur</option><option value="super_admin">Super admin</option></select></div></div><Button className="w-full" type="submit" disabled={busy === "create"}>{busy === "create" ? "Création…" : "Créer et activer"}</Button></form></DialogContent></Dialog>
    </div>
  );
}
