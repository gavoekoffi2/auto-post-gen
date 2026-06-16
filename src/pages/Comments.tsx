import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  Check,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";

type CommentRow = Database["public"]["Tables"]["social_comments"]["Row"];

const STATUS_LABEL: Record<string, string> = {
  new: "Nouveau",
  replied: "Répondu",
  ignored: "Ignoré",
  hidden: "Masqué",
};

const Comments = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"all" | "new" | "replied">("new");

  const [autoReply, setAutoReply] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  const loadComments = async () => {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) return;
    // Scope by user_id explicitly (defense-in-depth on top of RLS).
    const { data, error } = await supabase
      .from("social_comments")
      .select("*")
      .eq("user_id", userData.user.id)
      .order("comment_created_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      toast.error("Erreur de chargement des commentaires");
      return;
    }
    setComments((data as CommentRow[]) || []);
  };

  const loadSettings = async () => {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) return;
    const { data } = await supabase
      .from("profiles")
      .select("auto_reply_enabled, auto_reply_instructions")
      .eq("id", userData.user.id)
      .maybeSingle();
    setAutoReply(!!data?.auto_reply_enabled);
    setInstructions(data?.auto_reply_instructions || "");
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadComments(), loadSettings()]);
      setLoading(false);
    })();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-comments", {});
      if (error) throw error;
      if (data?.notice) toast.info(data.notice);
      else {
        toast.success(
          `Synchronisé : ${data?.inserted ?? 0} nouveau(x) commentaire(s)` +
            (data?.replied ? `, ${data.replied} réponse(s) auto` : ""),
        );
      }
      await loadComments();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur de synchronisation");
    } finally {
      setSyncing(false);
    }
  };

  const setRowBusy = (id: string, v: boolean) =>
    setBusy((prev) => ({ ...prev, [id]: v }));

  const handleSuggest = async (c: CommentRow) => {
    setRowBusy(c.id, true);
    try {
      const { data, error } = await supabase.functions.invoke("comment-reply", {
        body: { mode: "draft", commentId: c.id },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setDrafts((prev) => ({ ...prev, [c.id]: data?.reply || "" }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur IA");
    } finally {
      setRowBusy(c.id, false);
    }
  };

  const handleSend = async (c: CommentRow) => {
    const reply = (drafts[c.id] || "").trim();
    if (!reply) {
      toast.error("Rédigez ou générez une réponse d'abord.");
      return;
    }
    setRowBusy(c.id, true);
    try {
      const { data, error } = await supabase.functions.invoke("comment-reply", {
        body: { mode: "send", commentId: c.id, reply },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success("Réponse envoyée");
      setComments((prev) =>
        prev.map((x) =>
          x.id === c.id ? { ...x, status: "replied", reply_text: reply } : x,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de l'envoi");
    } finally {
      setRowBusy(c.id, false);
    }
  };

  const handleIgnore = async (c: CommentRow) => {
    const { error } = await supabase
      .from("social_comments")
      .update({ status: "ignored" })
      .eq("id", c.id);
    if (error) {
      toast.error("Erreur");
      return;
    }
    setComments((prev) =>
      prev.map((x) => (x.id === c.id ? { ...x, status: "ignored" } : x)),
    );
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData?.user) throw new Error("Non authentifié");
      const { error } = await supabase
        .from("profiles")
        .update({
          auto_reply_enabled: autoReply,
          auto_reply_instructions: instructions || null,
        })
        .eq("id", userData.user.id);
      if (error) throw error;
      toast.success("Réglages enregistrés");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSavingSettings(false);
    }
  };

  const filtered = useMemo(() => {
    if (filter === "all") return comments;
    if (filter === "new") return comments.filter((c) => c.status === "new");
    return comments.filter((c) => c.status === "replied");
  }, [comments, filter]);

  const counts = useMemo(
    () => ({
      all: comments.length,
      new: comments.filter((c) => c.status === "new").length,
      replied: comments.filter((c) => c.status === "replied").length,
    }),
    [comments],
  );

  return (
    <div className="min-h-screen">
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="glass-card" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Tableau de bord
            </Button>
            <span className="font-bold text-xl flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-primary" />
              Commentaires
            </span>
          </div>
          <Button onClick={handleSync} disabled={syncing} size="sm" className="bg-gradient-to-r from-primary to-secondary">
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            Synchroniser
          </Button>
        </div>
      </header>

      <main className="container mx-auto max-w-5xl px-4 py-6 space-y-6">
        {/* Auto-reply settings */}
        <Card className="glass-card p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-secondary">
                <Bot className="w-5 h-5 text-white" />
              </span>
              <div>
                <p className="font-medium">Réponses automatiques par IA</p>
                <p className="text-xs text-muted-foreground max-w-lg mt-1">
                  Quand c'est activé, chaque nouveau commentaire synchronisé reçoit
                  automatiquement une réponse rédigée par l'IA dans le ton de votre marque.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">{autoReply ? "Activé" : "Désactivé"}</span>
              <Switch checked={autoReply} onCheckedChange={setAutoReply} />
            </div>
          </div>
          <Textarea
            className="mt-4"
            placeholder="Consignes optionnelles pour l'IA (ex: toujours proposer de contacter le support par MP, ne jamais donner de prix...)"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
          />
          <div className="mt-3 flex justify-end">
            <Button onClick={handleSaveSettings} disabled={savingSettings} size="sm" variant="outline" className="glass-card">
              <Check className="w-4 h-4 mr-2" />
              Enregistrer
            </Button>
          </div>
        </Card>

        {/* Filters */}
        <div className="flex gap-2">
          {(["new", "replied", "all"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              className={filter === f ? "" : "glass-card"}
              onClick={() => setFilter(f)}
            >
              {f === "new" ? "Nouveaux" : f === "replied" ? "Répondus" : "Tous"} ({counts[f]})
            </Button>
          ))}
        </div>

        {/* List */}
        {loading ? (
          <div className="text-muted-foreground animate-pulse">Chargement…</div>
        ) : filtered.length === 0 ? (
          <Card className="glass-card p-10 text-center">
            <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="font-medium">Aucun commentaire {filter === "new" ? "nouveau" : ""}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Cliquez sur « Synchroniser » pour récupérer les commentaires de vos publications.
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {filtered.map((c) => (
              <Card key={c.id} className="glass-card p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize">{c.platform}</Badge>
                    <span className="font-medium text-sm">
                      {c.author_name || c.author_handle || "Utilisateur"}
                    </span>
                    {c.comment_created_at && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(c.comment_created_at).toLocaleString("fr-FR")}
                      </span>
                    )}
                  </div>
                  <Badge
                    variant={c.status === "replied" ? "default" : c.status === "new" ? "outline" : "secondary"}
                  >
                    {STATUS_LABEL[c.status] || c.status}
                  </Badge>
                </div>

                <p className="mt-3 text-sm whitespace-pre-wrap">{c.message || "(sans texte)"}</p>

                {c.status === "replied" ? (
                  <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm">
                    <span className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                      <Send className="w-3 h-3" />
                      Votre réponse{c.replied_by === "auto" ? " (auto)" : ""}
                    </span>
                    {c.reply_text}
                  </div>
                ) : c.status === "ignored" ? null : (
                  <div className="mt-3 space-y-2">
                    <Textarea
                      placeholder="Votre réponse…"
                      value={drafts[c.id] ?? ""}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      rows={2}
                    />
                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="outline" className="glass-card" disabled={busy[c.id]} onClick={() => handleSuggest(c)}>
                        <Sparkles className="w-4 h-4 mr-1" />
                        Suggérer (IA)
                      </Button>
                      <Button size="sm" className="bg-gradient-to-r from-primary to-secondary" disabled={busy[c.id]} onClick={() => handleSend(c)}>
                        <Send className="w-4 h-4 mr-1" />
                        Envoyer
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy[c.id]} onClick={() => handleIgnore(c)}>
                        <X className="w-4 h-4 mr-1" />
                        Ignorer
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default Comments;
