import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Clapperboard, Loader2, RefreshCw, Sparkles, AlertCircle, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// Poll every 6s while a job is still rendering. MoneyPrinterTurbo renders take
// ~1-4 min depending on length; the backend downloads + stores the file when
// done and flips status to "done".
const POLL_INTERVAL_MS = 6000;

type VideoJob = {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  subject: string | null;
  aspect: string | null;
  progress: number;
  video_url: string | null;
  error_message: string | null;
  created_at: string | null;
};

const ASPECTS = [
  { value: "9:16", label: "9:16 — Vertical (TikTok, Shorts, Reels)" },
  { value: "16:9", label: "16:9 — Paysage (YouTube)" },
  { value: "1:1", label: "1:1 — Carré (feed)" },
];

// A short curated list of free Edge-TTS voices. Empty = microservice default.
const VOICES = [
  { value: "", label: "Voix par défaut (config du moteur)" },
  { value: "fr-FR-DeniseNeural-Female", label: "Français — Denise (femme)" },
  { value: "fr-FR-HenriNeural-Male", label: "Français — Henri (homme)" },
  { value: "en-US-JennyNeural-Female", label: "Anglais US — Jenny (femme)" },
  { value: "en-US-GuyNeural-Male", label: "Anglais US — Guy (homme)" },
];

const DURATIONS = [
  { value: "3", label: "Clips courts (~3 s)" },
  { value: "5", label: "Standard (~5 s)" },
  { value: "8", label: "Clips longs (~8 s)" },
];

// Networks to which Zernio can publish a vertical short video. Defaults are
// pre-selected; the user can toggle before creating the post.
const VIDEO_PLATFORMS = ["TikTok", "YouTube", "Instagram", "Facebook"];
const DEFAULT_VIDEO_PLATFORMS = ["TikTok", "YouTube"];

function statusBadge(status: VideoJob["status"]) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">En file</Badge>;
    case "processing":
      return <Badge className="bg-blue-500/15 text-blue-500 hover:bg-blue-500/15">En cours…</Badge>;
    case "done":
      return <Badge className="bg-green-500/15 text-green-600 hover:bg-green-500/15">Prête</Badge>;
    case "failed":
      return <Badge variant="destructive">Échec</Badge>;
  }
}

export default function Videos() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<VideoJob[]>([]);

  const [subject, setSubject] = useState("");
  const [script, setScript] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [voice, setVoice] = useState("");
  const [duration, setDuration] = useState("5");
  // Per-job platform selection for publishing (keyed by job id).
  const [platformsByJob, setPlatformsByJob] = useState<Record<string, string[]>>({});
  const [creatingPostFor, setCreatingPostFor] = useState<string | null>(null);

  // Track which job ids are being polled so we don't start duplicate loops.
  const pollingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume polling for any job that is still active after a reload.
  useEffect(() => {
    for (const job of jobs) {
      if ((job.status === "processing" || job.status === "pending") && !pollingRef.current.has(job.id)) {
        void pollJob(job.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  const loadJobs = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/auth");
        return;
      }
      const { data, error } = await supabase
        .from("video_jobs")
        .select("id, status, subject, aspect, progress, video_url, error_message, created_at")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      setJobs((data || []) as VideoJob[]);
    } catch (err) {
      console.error("load video jobs failed", err);
      toast.error("Impossible de charger les vidéos.");
    } finally {
      setLoading(false);
    }
  };

  const upsertJob = (job: Partial<VideoJob> & { id: string }) => {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [{ ...(job as VideoJob) }, ...prev];
      const next = [...prev];
      next[idx] = { ...next[idx], ...job };
      return next;
    });
  };

  const pollJob = async (jobId: string) => {
    if (pollingRef.current.has(jobId)) return;
    pollingRef.current.add(jobId);
    try {
      // Loop until the job reaches a terminal state.
      // A generous cap prevents an infinite loop if the backend stalls.
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const { data, error } = await supabase.functions.invoke("video-status", { body: { jobId } });
        if (error) {
          // Transient — keep trying.
          continue;
        }
        const status = data?.status as VideoJob["status"] | undefined;
        if (!status) continue;
        upsertJob({
          id: jobId,
          status,
          progress: typeof data.progress === "number" ? data.progress : undefined,
          video_url: data.video_url ?? undefined,
          error_message: data.error ?? undefined,
        } as Partial<VideoJob> & { id: string });

        if (status === "done") {
          toast.success("Vidéo générée 🎬");
          break;
        }
        if (status === "failed") {
          toast.error(data.error || "La génération vidéo a échoué.");
          break;
        }
      }
    } finally {
      pollingRef.current.delete(jobId);
    }
  };

  const handleGenerate = async () => {
    if (!subject.trim() && !script.trim()) {
      toast.error("Renseigne au moins un sujet ou un script.");
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-video", {
        body: {
          subject: subject.trim(),
          script: script.trim(),
          aspect,
          voiceName: voice || undefined,
          duration: Number(duration),
        },
      });
      if (error) throw error;
      if (data?.error) {
        toast.error(data.error);
        return;
      }
      if (!data?.jobId) {
        toast.error("Réponse inattendue du serveur.");
        return;
      }
      toast.success("Génération lancée. La vidéo apparaîtra ici une fois prête.");
      upsertJob({
        id: data.jobId,
        status: "processing",
        subject: subject.trim() || script.trim().slice(0, 80),
        aspect,
        progress: 1,
        video_url: null,
        error_message: null,
        created_at: new Date().toISOString(),
      });
      setSubject("");
      setScript("");
      void pollJob(data.jobId);
    } catch (err) {
      console.error("generate-video failed", err);
      const message = err instanceof Error ? err.message : "Erreur lors du lancement de la génération.";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const refreshOne = async (jobId: string) => {
    const { data, error } = await supabase.functions.invoke("video-status", { body: { jobId } });
    if (error) {
      toast.error("Rafraîchissement impossible.");
      return;
    }
    upsertJob({
      id: jobId,
      status: data.status,
      progress: data.progress,
      video_url: data.video_url ?? undefined,
      error_message: data.error ?? undefined,
    } as Partial<VideoJob> & { id: string });
    if ((data.status === "processing" || data.status === "pending")) void pollJob(jobId);
  };

  const platformsFor = (jobId: string) => platformsByJob[jobId] ?? DEFAULT_VIDEO_PLATFORMS;

  const togglePlatform = (jobId: string, platform: string) => {
    setPlatformsByJob((prev) => {
      const current = prev[jobId] ?? DEFAULT_VIDEO_PLATFORMS;
      const next = current.includes(platform)
        ? current.filter((p) => p !== platform)
        : [...current, platform];
      return { ...prev, [jobId]: next };
    });
  };

  // Turn a finished video into a normal post so it flows through the SAME
  // validate → publish → status pipeline as image/text posts. publish-post
  // sends posts.video_url to Zernio as a video (TikTok / YouTube Shorts / …).
  const createPostFromVideo = async (job: VideoJob) => {
    const platforms = platformsFor(job.id);
    if (platforms.length === 0) {
      toast.error("Choisis au moins un réseau.");
      return;
    }
    if (!job.video_url) return;
    setCreatingPostFor(job.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate("/auth");
        return;
      }
      const { error } = await supabase.from("posts").insert({
        user_id: session.user.id,
        title: `Vidéo : ${(job.subject || "Sans titre").slice(0, 80)}`,
        content: job.subject || "",
        video_url: job.video_url,
        image_url: null,
        status: "pending",
        platforms,
      });
      if (error) throw error;
      toast.success("Post vidéo créé. Valide-le puis publie-le depuis le tableau de bord.");
      navigate("/dashboard");
    } catch (err) {
      console.error("create post from video failed", err);
      toast.error("Impossible de créer le post à publier.");
    } finally {
      setCreatingPostFor(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/40 backdrop-blur">
        <div className="container mx-auto flex items-center gap-3 px-4 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")} aria-label="Retour">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <Clapperboard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Génération de vidéos</h1>
            <p className="text-xs text-muted-foreground">Script IA → voix → sous-titres → montage (MoneyPrinterTurbo)</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto grid gap-6 px-4 py-6 lg:grid-cols-[380px_1fr]">
        {/* Generation form */}
        <Card className="h-fit space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-medium">Nouvelle vidéo</h2>
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Sujet</Label>
            <Input
              id="subject"
              placeholder="Ex. 3 astuces pour booster sa visibilité sur Instagram"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={500}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="script">Script (optionnel)</Label>
            <Textarea
              id="script"
              placeholder="Laisse vide pour que l'IA écrive le script à partir du sujet, ou colle ton propre script."
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={5}
              maxLength={4000}
            />
          </div>

          <div className="space-y-2">
            <Label>Format</Label>
            <Select value={aspect} onValueChange={setAspect}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASPECTS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Voix</Label>
              <Select value={voice} onValueChange={setVoice}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VOICES.map((v) => (
                    <SelectItem key={v.value || "default"} value={v.value}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Rythme des clips</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button className="w-full" onClick={handleGenerate} disabled={submitting}>
            {submitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Lancement…</>
            ) : (
              <><Clapperboard className="mr-2 h-4 w-4" /> Générer la vidéo</>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            Le rendu prend généralement 1 à 4 minutes. Tu peux quitter cette page : la vidéo
            se retrouvera ici une fois prête (garde l'onglet ouvert pour le suivi en direct).
          </p>
        </Card>

        {/* Jobs list */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Mes vidéos</h2>
            <Button variant="ghost" size="sm" onClick={() => loadJobs()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Actualiser
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Chargement…
            </div>
          ) : jobs.length === 0 ? (
            <Card className="p-8 text-center text-muted-foreground">
              Aucune vidéo pour l'instant. Lance ta première génération à gauche.
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {jobs.map((job) => (
                <Card key={job.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-medium">{job.subject || "Vidéo"}</p>
                    {statusBadge(job.status)}
                  </div>
                  <p className="text-xs text-muted-foreground">Format {job.aspect || "9:16"}</p>

                  {job.status === "done" && job.video_url ? (
                    <video
                      src={job.video_url}
                      controls
                      className="w-full rounded-md bg-black"
                      style={{ aspectRatio: (job.aspect || "9:16").replace(":", " / ") }}
                    />
                  ) : job.status === "failed" ? (
                    <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{job.error_message || "La génération a échoué."}</span>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Progress value={Math.max(job.progress || 0, 5)} />
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {job.status === "pending" ? "En file d'attente…" : `Rendu en cours… ${job.progress || 0}%`}
                      </p>
                    </div>
                  )}

                  {job.status === "done" && job.video_url && (
                    <div className="space-y-2 rounded-md border border-border/50 p-3">
                      <p className="text-xs font-medium text-muted-foreground">Publier sur :</p>
                      <div className="flex flex-wrap gap-1.5">
                        {VIDEO_PLATFORMS.map((p) => {
                          const active = platformsFor(job.id).includes(p);
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => togglePlatform(job.id, p)}
                              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                                active
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-border/60 text-muted-foreground hover:bg-muted"
                              }`}
                            >
                              {p === "YouTube" ? "YouTube Shorts" : p}
                            </button>
                          );
                        })}
                      </div>
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={creatingPostFor === job.id}
                        onClick={() => createPostFromVideo(job)}
                      >
                        {creatingPostFor === job.id ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Création…</>
                        ) : (
                          <><Share2 className="mr-2 h-4 w-4" /> Créer le post à publier</>
                        )}
                      </Button>
                    </div>
                  )}

                  <div className="mt-auto flex items-center gap-2">
                    {job.status === "done" && job.video_url && (
                      <Button asChild variant="outline" size="sm">
                        <a href={job.video_url} target="_blank" rel="noreferrer" download>Télécharger</a>
                      </Button>
                    )}
                    {(job.status === "processing" || job.status === "pending" || job.status === "failed") && (
                      <Button variant="ghost" size="sm" onClick={() => refreshOne(job.id)}>
                        <RefreshCw className="mr-2 h-4 w-4" /> Vérifier
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
