import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, TrendingUp, CheckCircle, Clock, CreditCard, Edit2, Sparkles, Settings, Share2, Calendar as CalendarIcon, Trash2, User, BarChart3, Send, ImageIcon, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  ApiError,
  generations,
  posts as postsApi,
  profile as profileApi,
  social,
  type GenerationJob,
  type Post as ApiPost,
  type Profile as ApiProfile,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { getSocialImageSpec } from "@/lib/socialImageSpecs";
import { checkTextFits } from "@/lib/platformTextLimits";
import { useNavigate } from "react-router-dom";
import SettingsDialog from "@/components/SettingsDialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SocialMediaConnect } from "@/components/SocialMediaConnect";
import { SubscriptionBanner } from "@/components/SubscriptionBanner";
import { resolveEntitlement, type SubscriptionFields } from "@/lib/plans";

type PostStatus = "pending" | "validated" | "published" | "failed";

type Post = {
  id: string;
  user_id?: string;
  platform?: string;
  platforms?: string[];
  date?: string;
  time?: string;
  scheduled_for?: string;
  title: string;
  content: string;
  content_category?: string | null;
  image_url?: string;
  image_status?: string | null;
  image_job_id?: string | null;
  image_status_url?: string | null;
  status: PostStatus;
  publish_error?: string | null;
};

type UserProfile = SubscriptionFields & {
  id?: string;
  description?: string | null;
  company_name?: string | null;
  platforms?: string[] | null;
  [key: string]: unknown;
};

// publish-post stores the per-platform outcome as a JSON array in
// posts.publish_error. Turn it into a short, human-readable reason.
function formatPublishError(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const msgs = parsed
        .filter((r) => r && r.status && r.status !== "ok")
        .map((r) => `${r.platform}: ${r.message || r.status}`);
      return msgs.length ? msgs.join(" · ") : null;
    }
  } catch {
    // Not JSON (legacy plain string) — fall through.
  }
  return String(raw).slice(0, 200);
}

// `<input type="date">` + `<input type="time">` give local wall-clock values.
// Concatenating them into "2026-09-10T14:30:00" and sending that to a
// timestamptz column made Postgres read it as UTC, so every save shifted the
// post by the user's offset while the dashboard kept rendering it as local
// time. Build a real local Date and let toISOString() do the conversion.
function localDateTimeToIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map((n) => parseInt(n, 10));
  const [hour, minute] = time.split(":").map((n) => parseInt(n, 10));
  if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) return null;
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

const DAY_NAME_TO_INDEX: Record<string, number> = {
  Dimanche: 0, Lundi: 1, Mardi: 2, Mercredi: 3, Jeudi: 4, Vendredi: 5, Samedi: 6,
};

// A manually generated post used to be saved with scheduled_for = null, which
// left it out of the calendar, showed a blank date on its card, and made it
// invisible to the publish cron (the due query filters on scheduled_for), so
// validating it never published anything on its own. Give it the user's next
// preferred slot instead; they can still publish immediately with "Publier".
function nextPreferredSlot(profile: UserProfile | null): string {
  const days = Array.isArray(profile?.preferred_days) && profile.preferred_days.length
    ? (profile.preferred_days as string[])
    : ["Lundi", "Mercredi", "Vendredi"];
  const [rawHour, rawMinute] = String(profile?.preferred_time || "10:00")
    .split(":")
    .map((n) => parseInt(n, 10));
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 10;
  const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;

  const now = new Date();
  const wanted = new Set(
    days.map((d) => DAY_NAME_TO_INDEX[d]).filter((n): n is number => n !== undefined),
  );
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue;
    if (wanted.size === 0 || wanted.has(candidate.getDay())) return candidate.toISOString();
  }
  // No preferred day matched within a week (shouldn't happen): tomorrow.
  const fallback = new Date(now);
  fallback.setDate(now.getDate() + 1);
  fallback.setHours(hour, minute, 0, 0);
  return fallback.toISOString();
}

// Poster generation is asynchronous and resumable.
//
// A premium 2K poster can take minutes, so the API answers the initial request
// with `processing` and a job id instead of holding the connection open. The
// client then polls that job. Polling is a pure status read — it never starts,
// and never bills, a second generation — which is what makes it safe to resume
// a job after a reload, a client timeout, or a closed tab.
const POSTER_POLL_INTERVAL_MS = 5_000;
const POSTER_POLL_BUDGET_MS = 6 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls an already-started job until it resolves or the budget runs out. */
async function awaitPosterJob(
  jobId: string,
): Promise<{ imageUrl?: string; error?: string; stillProcessing?: boolean }> {
  const deadline = Date.now() + POSTER_POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    await sleep(POSTER_POLL_INTERVAL_MS);
    let job: GenerationJob;
    try {
      job = await generations.status(jobId);
    } catch (err) {
      // A transient read failure is not a failed job: keep polling. Only the
      // server saying "failed" is terminal.
      if (err instanceof ApiError && err.status >= 500) continue;
      throw err;
    }
    if (job.status === "completed" && job.url) return { imageUrl: job.url };
    if (job.status === "failed") {
      // The provider's real reason, surfaced as-is. There is no local
      // placeholder image: a failed generation is reported, never faked.
      return { error: job.error || "La génération de l'affiche a échoué." };
    }
  }
  return {
    stillProcessing: true,
    error:
      "La génération de l'affiche prend plus de temps que prévu. Elle se poursuit côté serveur : " +
      "rechargez la page dans quelques minutes pour la récupérer.",
  };
}

/** Starts a poster for a post, then waits for it. */
async function generatePosterImage(input: {
  postId: string;
  platforms: string[];
  contentCategory?: "value" | "research" | "promo";
}): Promise<{ imageUrl?: string; error?: string }> {
  let job: GenerationJob;
  try {
    job = await generations.image(input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Erreur de génération d'image" };
  }
  if (job.status === "completed" && job.url) return { imageUrl: job.url };
  if (job.status === "failed") {
    return { error: job.error || "La génération de l'affiche a échoué." };
  }
  return await awaitPosterJob(job.jobId);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { signOut } = useSession();
  const [posts, setPosts] = useState<Post[]>([]);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [previewPost, setPreviewPost] = useState<Post | null>(null);
  const [isPreviewDialogOpen, setIsPreviewDialogOpen] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isSocialMediaDialogOpen, setIsSocialMediaDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [generatingImageIds, setGeneratingImageIds] = useState<Set<string>>(new Set());
  const [regeneratingContentIds, setRegeneratingContentIds] = useState<Set<string>>(new Set());
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [hasConnection, setHasConnection] = useState<boolean | null>(null);

  useEffect(() => {
    checkAuthAndLoadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAuthAndLoadData = async () => {
    try {
      // Every request below is scoped by the server to the session's own
      // account: no user id is sent, so there is nothing here to tamper with.
      const [profile, accounts, postList] = await Promise.all([
        profileApi.get(),
        social.listAccounts().catch(() => ({ accounts: [], provisioned: false })),
        postsApi.list(),
      ]);

      setUserProfile(profile as unknown as UserProfile);
      setHasConnection(accounts.accounts.length > 0);

      const transformedPosts: Post[] = (postList.posts || []).map(toViewPost);

      setPosts(transformedPosts);

      // Resume any poster jobs that were still rendering when the page was last
      // closed (or whose generation outran the client's polling budget). The
      // edge function persists the job on the row, so we can pick the finished
      // poster back up here instead of losing it. Bounded to avoid a thundering
      // herd if many posts are mid-generation.
      const pendingImagePosts = transformedPosts
        .filter((p) => !p.image_url && p.image_status === "processing" && p.image_job_id)
        .slice(0, 4);
      for (const p of pendingImagePosts) {
        void resumePendingImage(p);
      }
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        navigate('/auth');
        return;
      }
      console.error('Error loading data:', error);
      const message = error instanceof Error ? error.message : 'Erreur lors du chargement des données';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  /** Maps an API post onto the shape this page renders. */
  const toViewPost = (post: ApiPost): Post => ({
    ...post,
    platform: post.platforms?.[0] || 'Instagram',
    date: post.scheduled_for ? new Date(post.scheduled_for).toISOString().split('T')[0] : '',
    time: post.scheduled_for ? new Date(post.scheduled_for).toTimeString().substring(0, 5) : '',
    status: (post.status === "validated" || post.status === "published" || post.status === "failed"
      ? post.status
      : "pending") as PostStatus,
    image_url: post.image_url ?? undefined,
  });

  // Re-poll a poster job that is already in flight (persisted on the post row)
  // and attach the finished image when it lands. Used on page load so slow
  // posters appear automatically alongside the text, without a manual retry.
  const resumePendingImage = async (post: Post) => {
    if (!post.image_job_id) return;
    if (generatingImageIds.has(post.id)) return;
    setGeneratingImageIds((prev) => new Set(prev).add(post.id));
    try {
      // Poll the EXISTING job rather than asking for a new poster: resuming
      // must never trigger (or bill) a second generation.
      const res = await awaitPosterJob(post.image_job_id);
      if (res.imageUrl) {
        const url = res.imageUrl;
        setPosts((prev) =>
          prev.map((p) => (p.id === post.id ? { ...p, image_url: url, image_status: "done" } : p)),
        );
      }
      // On error/timeout we leave the row as-is; the "Régénérer l'affiche"
      // button stays available and a later load will retry the same job.
    } catch (err) {
      console.error("Resume pending image failed:", err);
    } finally {
      setGeneratingImageIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  const handleSignOut = async () => {
    await signOut();
    toast.success("Déconnexion réussie");
    navigate("/");
  };

  const handleValidate = async (postId: string) => {
    try {
      // The server clears the retry counter and backoff window as part of
      // validating, so a post the user just approved starts clean. Doing it
      // server-side keeps the publish budget out of the browser's reach.
      await postsApi.validate(postId);

      setPosts((prev) => prev.map(post =>
        post.id === postId ? { ...post, status: "validated" as const, publish_error: null } : post
      ));
      toast.success("Post validé !");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur lors de la validation";
      toast.error(message);
    }
  };

  const handlePublish = async (post: Post) => {
    if (publishingId) return;
    if (post.status !== "validated") {
      toast.error("Validez le post avant de le publier");
      return;
    }
    setPublishingId(post.id);
    const loadingToast = toast.loading("Publication en cours...");
    try {
      // The API returns the per-platform outcome AND the post as it now
      // stands, so there is no second read to keep in sync with it.
      const { results, post: updated } = await postsApi.publish(post.id);
      toast.dismiss(loadingToast);
      const anyOk = results.some((r) => r.status === "ok");
      const anyPending = results.some((r) => r.status === "pending");
      const allErrors = results.length > 0 && results.every((r) => r.status === "error");
      setPosts((prev) =>
        prev.map((p) =>
          p.id === post.id
            ? { ...p, status: updated.status as PostStatus, publish_error: updated.publish_error }
            : p,
        ),
      );
      if (anyOk) {
        const urls = results.filter((r) => r.status === "ok" && r.externalUrl).map((r) => r.externalUrl);
        toast.success(urls.length ? `Post publié ! Lien: ${urls[0]}` : "Post publié !");
      } else if (anyPending) {
        const messages = results
          .filter((r) => r.status === "pending")
          .map((r) => `${r.platform}: ${r.message || "publication en attente côté Zernio/LinkedIn"}`)
          .join("\n");
        toast.warning(`Publication acceptée mais pas encore visible.\n${messages}`);
      } else if (allErrors) {
        const messages = results
          .map((r) => `${r.platform}: ${r.message || r.status}`)
          .join("\n");
        toast.error(`Échec de publication.\n${messages}`);
      } else {
        const notConnected = results
          .filter((r) => r.status === "not_connected")
          .map((r) => r.platform);
        toast.error(
          notConnected.length > 0
            ? `Réseaux non connectés: ${notConnected.join(", ")}. Connectez-les dans "Gérer les réseaux sociaux".`
            : "Aucune publication effectuée.",
        );
      }
    } catch (error: unknown) {
      toast.dismiss(loadingToast);
      const message = error instanceof Error ? error.message : "Erreur lors de la publication";
      toast.error(message);
    } finally {
      setPublishingId(null);
    }
  };

  const handleRetry = async (post: Post) => {
    // Flip back to 'validated' first so handlePublish's pre-check
    // accepts it, then publish.
    try {
      // Same server-side reset as validating: the retry budget is the
      // server's to grant, never a value the browser sets.
      await postsApi.validate(post.id);
      const revived: Post = { ...post, status: 'validated' };
      setPosts((prev) => prev.map((p) => (p.id === post.id ? revived : p)));
      await handlePublish(revived);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erreur lors du retry";
      toast.error(message);
    }
  };

  const handleEdit = (post: Post) => {
    setEditingPost({ ...post });
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingPost) return;
    try {
      await postsApi.update(editingPost.id, {
        title: editingPost.title,
        content: editingPost.content,
        platforms: editingPost.platforms || ['Instagram'],
        scheduled_for: localDateTimeToIso(editingPost.date || "", editingPost.time || ""),
      });

      setPosts((prev) => prev.map(post =>
        post.id === editingPost.id ? editingPost : post
      ));
      setIsEditDialogOpen(false);
      setEditingPost(null);
      toast.success("Post modifié !");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur lors de la modification";
      toast.error(message);
    }
  };

  // Mirrors the server gate so an expired account is sent to renew instead of
  // watching a generation fail. The server refuses regardless (402).
  const canGenerate = userProfile ? resolveEntitlement(userProfile).canGenerate : true;

  const handleGenerate = async () => {
    if (generating) return;
    if (!canGenerate) {
      navigate("/abonnement");
      return;
    }
    setGenerating(true);
    const loadingToast = toast.loading("Génération IA en cours...");
    try {
      const generationPlatforms =
        userProfile?.platforms && userProfile.platforms.length > 0
          ? userProfile.platforms
          : ['Instagram'];
      // The server reads the business profile from the session; the browser
      // only says which networks this post targets, because that is a property
      // of the post and not a claim about who the caller is.
      const data = await generations.text({
        prompt: "Génère un post engageant pour mes réseaux sociaux",
        platforms: generationPlatforms,
      });

      toast.dismiss(loadingToast);

      if (!data?.content) {
        throw new Error('Aucun contenu reçu de la génération');
      }

      const defaultPlatforms = generationPlatforms;

      // 1. Save the post immediately with text only so the user sees
      //    the result without waiting for the slow image generation.
      const savedPost = await postsApi.create({
        title: "Nouveau contenu IA",
        content: data.content,
        contentCategory: data.postType,
        platforms: defaultPlatforms,
        scheduledFor: nextPreferredSlot(userProfile),
      });

      const transformedPost: Post = toViewPost(savedPost);

      setPosts((prev) => [transformedPost, ...prev]);
      // generate-content answers with `fallback: true` when the AI provider was
      // unreachable and it returned one of its canned placeholder posts. That
      // used to be announced as a successful AI generation, so the user
      // published boilerplate believing it was written for their business.
      if (data.fallback) {
        toast.warning(
          "L'IA de rédaction est momentanément indisponible : ce texte est un modèle générique. " +
            "Modifiez-le ou cliquez sur « Régénérer le contenu » dans un instant.",
          { duration: 12000 },
        );
      } else {
        toast.success(
          data.usedWebInspiration
            ? "Post enrichi par recherche web généré. L'image est en cours..."
            : "Post généré. L'image est en cours...",
        );
      }

      // 2. Kick off image generation asynchronously. Don't block the UI.
      //    Mark the post as generating-image so the card can show a
      //    spinner placeholder instead of nothing.
      setGeneratingImageIds((prev) => new Set(prev).add(savedPost.id));
      void (async () => {
        try {
          const imageSpec = getSocialImageSpec(defaultPlatforms);
          const res = await generatePosterImage({
            postId: savedPost.id,
            platforms: defaultPlatforms,
            contentCategory: data.postType,
          });
          if (res.error) {
            // The provider's real reason, shown as-is: a poster that was not
            // produced is reported as such, never replaced by a placeholder.
            toast.error(res.error);
          } else if (res.imageUrl) {
            const url = res.imageUrl;
            setPosts((prev) =>
              prev.map((p) => (p.id === savedPost.id ? { ...p, image_url: url } : p)),
            );
            toast.success(`Affiche IA ajoutée (${imageSpec.label}, ${imageSpec.aspectRatio})`);
          }
        } catch (imgErr) {
          console.error('Image gen failed:', imgErr);
          toast.error(
            "Image non générée. Cliquez sur 'Régénérer image' sur le post pour réessayer.",
          );
        } finally {
          setGeneratingImageIds((prev) => {
            const next = new Set(prev);
            next.delete(savedPost.id);
            return next;
          });
        }
      })();
    } catch (error: unknown) {
      toast.dismiss(loadingToast);
      console.error('Generation error:', error);
      const message = error instanceof Error ? error.message : 'Erreur lors de la génération';
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerateImage = async (post: Post) => {
    if (generatingImageIds.has(post.id)) return;
    setGeneratingImageIds((prev) => new Set(prev).add(post.id));
    const loadingToast = toast.loading("Génération de l'affiche…");
    try {
      const regenPlatforms = post.platforms || (post.platform ? [post.platform] : []);
      const imageSpec = getSocialImageSpec(regenPlatforms);
      const res = await generatePosterImage({
        postId: post.id,
        platforms: regenPlatforms,
        contentCategory: (post.content_category as "value" | "research" | "promo") || "value",
      });
      toast.dismiss(loadingToast);
      if (res.error) {
        // The provider's real reason, shown as-is. Nothing local stands in for
        // a poster that was not produced.
        toast.error(res.error);
      } else if (res.imageUrl) {
        const url = res.imageUrl;
        setPosts((prev) =>
          prev.map((p) => (p.id === post.id ? { ...p, image_url: url } : p)),
        );
        setEditingPost((current) =>
          current?.id === post.id ? { ...current, image_url: url } : current,
        );
        toast.success(`Affiche IA générée (${imageSpec.label}, ${imageSpec.aspectRatio})`);
      } else {
        toast.error("Affiche non générée");
      }
    } catch (err) {
      toast.dismiss(loadingToast);
      const message = err instanceof Error ? err.message : "Erreur de génération d'image";
      toast.error(message);
    } finally {
      setGeneratingImageIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  const handleRegenerateContent = async (post: Post) => {
    if (regeneratingContentIds.has(post.id)) return;
    setRegeneratingContentIds((prev) => new Set(prev).add(post.id));
    const loadingToast = toast.loading("Régénération du contenu...");
    try {
      const data = await generations.text({
        prompt: `Régénère une nouvelle version professionnelle de ce post, claire, vendeuse et prête à publier. Garde le même objectif mais propose une formulation différente. Ancien post:\n${post.content}`,
        // This post's own targets, which can differ from the profile's:
        // regenerating a post addressed to X must respect X's 280 characters.
        platforms: post.platforms || (post.platform ? [post.platform] : []),
        postId: post.id,
      });
      if (!data?.content) throw new Error("Aucun contenu reçu");

      const category = data.postType || post.content_category || "value";
      const updatedPost: Post = {
        ...post,
        title: "Contenu régénéré",
        content: data.content,
        content_category: category,
        image_url: undefined,
        image_status: null,
        image_job_id: null,
        image_status_url: null,
      };

      // The server persists the new text, keeps content_category in step with
      // it, and drops the poster job that belonged to the OLD text — leaving
      // that job attached meant the next load resumed a render whose image no
      // longer matches what the post says.
      await postsApi.update(post.id, {
        title: updatedPost.title,
        content: updatedPost.content,
        image_url: null,
      });

      setPosts((prev) => prev.map((p) => (p.id === post.id ? updatedPost : p)));
      if (editingPost?.id === post.id) {
        setEditingPost(updatedPost);
      }
      toast.dismiss(loadingToast);
      if (data.fallback) {
        toast.warning(
          "L'IA de rédaction est momentanément indisponible : ce texte est un modèle générique. Réessayez dans un instant.",
          { duration: 12000 },
        );
      } else {
        toast.success("Contenu régénéré. Nouvelle affiche en cours...");
      }
      await handleRegenerateImage(updatedPost);
    } catch (err) {
      toast.dismiss(loadingToast);
      const message = err instanceof Error ? err.message : "Erreur de régénération du contenu";
      toast.error(message);
    } finally {
      setRegeneratingContentIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  const handlePreview = (post: Post) => {
    setPreviewPost(post);
    setIsPreviewDialogOpen(true);
  };

  const handleCalendar = () => {
    navigate('/calendar');
  };

  const handleStats = () => {
    navigate('/statistics');
  };

  const handleComments = () => {
    navigate('/comments');
  };

  const handleProfile = () => {
    navigate('/profile');
  };

  const handleDelete = async (postId: string) => {
    if (deletingIds.has(postId)) return;
    setDeletingIds((prev) => new Set(prev).add(postId));
    try {
      await postsApi.remove(postId);

      setPosts((prev) => prev.filter(post => post.id !== postId));
      toast.success("Post supprimé !");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur lors de la suppression";
      toast.error(message);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
    }
  };

  const handleSettings = () => {
    setIsSettingsDialogOpen(true);
  };

  const handleSocialMedia = () => {
    setIsSocialMediaDialogOpen(true);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse">Chargement...</div>
      </div>
    );
  }

  const stats = {
    scheduled: posts.length,
    validated: posts.filter(p => p.status === 'validated').length,
    pending: posts.filter(p => p.status === 'pending').length,
    published: posts.filter(p => p.status === 'published').length,
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 bg-gradient-to-r from-primary to-secondary rounded-xl flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <span className="font-bold text-xl">Pro Social AI</span>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button onClick={handleStats} variant="outline" size="sm" className="glass-card">
                <BarChart3 className="w-4 h-4 mr-2" />
                Stats
              </Button>
              <Button onClick={handleCalendar} variant="outline" size="sm" className="glass-card">
                <CalendarIcon className="w-4 h-4 mr-2" />
                Calendrier
              </Button>
              <Button onClick={handleComments} variant="outline" size="sm" className="glass-card">
                <MessageSquare className="w-4 h-4 mr-2" />
                Commentaires
              </Button>
              <Button onClick={handleProfile} variant="outline" size="sm" className="glass-card">
                <User className="w-4 h-4 mr-2" />
                Profil
              </Button>
              <Button onClick={() => navigate("/abonnement")} variant="outline" size="sm" className="glass-card">
                <CreditCard className="w-4 h-4 mr-2" />
                Abonnement
              </Button>
              <Button onClick={handleSettings} variant="outline" size="sm" className="glass-card">
                <Settings className="w-4 h-4 mr-2" />
                Paramètres
              </Button>
              <Button onClick={handleSignOut} variant="outline" size="sm" className="glass-card">
                Déconnexion
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-7xl px-4 py-8">
        <SubscriptionBanner profile={userProfile} />

        {/* First-run nudge: no social account connected yet. */}
        {hasConnection === false && (
          <Card className="glass-card p-4 mb-6 border-primary/40">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <Share2 className="w-5 h-5 text-primary shrink-0" />
                <p className="text-sm">
                  Connectez un réseau social pour pouvoir publier vos posts validés.
                </p>
              </div>
              <Button
                size="sm"
                className="bg-gradient-to-r from-primary to-secondary"
                onClick={handleSocialMedia}
              >
                <Share2 className="w-4 h-4 mr-2" />
                Connecter un réseau
              </Button>
            </div>
          </Card>
        )}

        {/* This card used to promise "génération enrichie par recherche web"
            (Google News, Wikipedia…). Web research is not implemented on the
            self-hosted API (usedWebInspiration is always false), so the claim
            is gone rather than shown to every user on every visit. */}

        {/* Stats */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <Card className="glass-card p-6 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <Calendar className="w-8 h-8 text-primary" />
              <span className="text-3xl font-bold gradient-text">{stats.scheduled}</span>
            </div>
            <p className="text-sm text-muted-foreground">Posts programmés</p>
          </Card>

          <Card className="glass-card p-6 animate-fade-in" style={{ animationDelay: "0.1s" }}>
            <div className="flex items-center justify-between mb-4">
              <CheckCircle className="w-8 h-8 text-secondary" />
              <span className="text-3xl font-bold gradient-text">{stats.validated}</span>
            </div>
            <p className="text-sm text-muted-foreground">Posts validés</p>
          </Card>

          <Card className="glass-card p-6 animate-fade-in" style={{ animationDelay: "0.2s" }}>
            <div className="flex items-center justify-between mb-4">
              <Clock className="w-8 h-8 text-accent" />
              <span className="text-3xl font-bold gradient-text">{stats.pending}</span>
            </div>
            <p className="text-sm text-muted-foreground">En attente</p>
          </Card>

          <Card className="glass-card p-6 animate-fade-in" style={{ animationDelay: "0.3s" }}>
            <div className="flex items-center justify-between mb-4">
              <TrendingUp className="w-8 h-8 text-primary" />
              <span className="text-3xl font-bold gradient-text">{stats.published}</span>
            </div>
            <p className="text-sm text-muted-foreground">Posts publiés</p>
          </Card>
        </div>

        {/* Upcoming posts */}
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <h2 className="text-2xl font-bold mb-6">Publications à venir</h2>
            {posts.length === 0 ? (
              <Card className="glass-card p-8 text-center">
                <p className="text-muted-foreground mb-4">Aucun post pour le moment</p>
                <Button onClick={handleGenerate} disabled={generating} className="bg-gradient-to-r from-primary to-secondary">
                  <Sparkles className="w-4 h-4 mr-2" />
                  {!canGenerate ? "Choisir un forfait" : generating ? "Génération..." : "Générer votre premier post"}
                </Button>
              </Card>
            ) : (
              <div className="space-y-4">
                {posts.map((post, index) => (
                  <Card key={post.id} className="glass-card p-6 hover:scale-[1.02] transition-all animate-fade-in" style={{ animationDelay: `${index * 0.1}s` }}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-r from-primary to-secondary rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-white">{(post.platform || 'IG').substring(0, 2)}</span>
                        </div>
                        <div>
                          <p className="font-medium">{post.title}</p>
                          <p className="text-xs text-muted-foreground">{post.platform || 'Instagram'}</p>
                        </div>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-xs ${
                        post.status === "published"
                          ? "bg-primary/20 text-primary"
                          : post.status === "validated"
                          ? "bg-secondary/20 text-secondary"
                          : post.status === "failed"
                          ? "bg-destructive/20 text-destructive"
                          : "bg-accent/20 text-accent"
                      }`}>
                        {post.status === "published"
                          ? "Publié"
                          : post.status === "validated"
                          ? "Validé"
                          : post.status === "failed"
                          ? "Échec"
                          : "En attente"}
                      </span>
                    </div>
                    {(post.date || post.time) && (
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                        {post.date && (
                          <div className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            {post.date}
                          </div>
                        )}
                        {post.time && (
                          <div className="flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            {post.time}
                          </div>
                        )}
                      </div>
                     )}
                     {post.image_url ? (
                       <div className="mb-4 rounded-lg overflow-hidden bg-muted">
                         <img
                           src={post.image_url}
                           alt="Post illustration"
                           className="w-full h-48 object-cover"
                           onError={(e) => {
                             const img = e.currentTarget;
                             img.style.display = "none";
                             const wrap = img.parentElement;
                             if (wrap) {
                               wrap.innerHTML =
                                 '<div class="flex items-center justify-center h-48 text-xs text-muted-foreground">Image indisponible</div>';
                             }
                           }}
                         />
                       </div>
                     ) : generatingImageIds.has(post.id) ? (
                       <div className="mb-4 rounded-lg overflow-hidden bg-muted h-48 flex items-center justify-center">
                         <div className="flex flex-col items-center gap-2 text-muted-foreground">
                           <Loader2 className="w-6 h-6 animate-spin" />
                           <span className="text-xs">Image en cours de génération...</span>
                         </div>
                       </div>
                     ) : (
                       <div className="mb-4 rounded-lg overflow-hidden bg-muted h-48 flex items-center justify-center">
                         <Button
                           variant="ghost"
                           size="sm"
                           className="flex flex-col items-center gap-2 h-auto py-3 text-muted-foreground"
                           onClick={() => handleRegenerateImage(post)}
                         >
                           <ImageIcon className="w-6 h-6" />
                           <span className="text-xs">Générer l'image</span>
                         </Button>
                       </div>
                     )}
                     {post.status !== "published" && formatPublishError(post.publish_error) && (
                       <p className="text-xs text-destructive mb-3 break-words">
                         Détail publication : {formatPublishError(post.publish_error)}
                       </p>
                     )}
                     {(() => {
                       // Warn on the card too, so an over-long post is visible
                       // without opening it — it cannot publish as it stands.
                       if (post.status === "published") return null;
                       const fit = checkTextFits(
                         post.content || "",
                         post.platforms || (post.platform ? [post.platform] : []),
                       );
                       if (fit.fits) return null;
                       return (
                         <p className="text-xs text-destructive mb-3 break-words">
                           Trop long pour {fit.limit.label} : {fit.length} caractères sur{" "}
                           {fit.limit.maxChars} autorisés. Modifiez le post pour le raccourcir.
                         </p>
                       );
                     })()}
                     <p className="text-sm text-muted-foreground mb-4 line-clamp-2">{post.content}</p>
                     <div className="flex gap-2 flex-wrap">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="glass-card flex-1"
                        onClick={() => handlePreview(post)}
                      >
                        Aperçu
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="glass-card flex-1"
                        onClick={() => handleEdit(post)}
                      >
                        <Edit2 className="w-4 h-4 mr-1" />
                        Modifier
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="glass-card flex-1"
                        onClick={() => handleRegenerateImage(post)}
                        disabled={generatingImageIds.has(post.id)}
                      >
                        {generatingImageIds.has(post.id) ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <ImageIcon className="w-4 h-4 mr-1" />
                        )}
                        Régénérer l’affiche
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="glass-card flex-1"
                        onClick={() => handleRegenerateContent(post)}
                        disabled={regeneratingContentIds.has(post.id)}
                      >
                        {regeneratingContentIds.has(post.id) ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-1" />
                        )}
                        Régénérer le contenu
                      </Button>
                      {post.status === "pending" && (
                        <Button
                          size="sm"
                          className="bg-gradient-to-r from-primary to-secondary flex-1"
                          onClick={() => handleValidate(post.id)}
                        >
                          <CheckCircle className="w-4 h-4 mr-1" />
                          Valider
                        </Button>
                      )}
                      {post.status === "validated" && (
                        <Button
                          size="sm"
                          className="bg-gradient-to-r from-primary to-secondary flex-1"
                          onClick={() => handlePublish(post)}
                          disabled={publishingId === post.id}
                        >
                          <Send className="w-4 h-4 mr-1" />
                          {publishingId === post.id ? "Publication..." : "Publier"}
                        </Button>
                      )}
                      {post.status === "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="glass-card flex-1"
                          onClick={() => handleRetry(post)}
                          disabled={publishingId === post.id}
                        >
                          <Send className="w-4 h-4 mr-1" />
                          {publishingId === post.id ? "Tentative..." : "Réessayer"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="glass-card text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(post.id)}
                        disabled={deletingIds.has(post.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="text-2xl font-bold mb-6">Actions rapides</h2>
            <div className="space-y-4">
              <Card className="glass-card p-6 hover:scale-[1.02] transition-all cursor-pointer">
                <h3 className="font-semibold mb-2">Générer du contenu</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Créer de nouveaux posts avec l'IA
                </p>
                <Button
                  className="w-full bg-gradient-to-r from-primary to-secondary"
                  onClick={handleGenerate}
                  disabled={generating}
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  {!canGenerate ? "Choisir un forfait" : generating ? "Génération..." : "Générer"}
                </Button>
              </Card>

              <Card className="glass-card p-6 hover:scale-[1.02] transition-all cursor-pointer">
                <h3 className="font-semibold mb-2">Calendrier</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Voir tous vos posts planifiés
                </p>
                <Button 
                  variant="outline" 
                  className="w-full glass-card"
                  onClick={handleCalendar}
                >
                  <Calendar className="w-4 h-4 mr-2" />
                  Ouvrir
                </Button>
              </Card>

              <Card className="glass-card p-6 hover:scale-[1.02] transition-all cursor-pointer">
                <h3 className="font-semibold mb-2">Réseaux sociaux</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Connecter vos comptes
                </p>
                <Button 
                  variant="outline" 
                  className="w-full glass-card"
                  onClick={handleSocialMedia}
                >
                  <Share2 className="w-4 h-4 mr-2" />
                  Gérer
                </Button>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={isPreviewDialogOpen} onOpenChange={setIsPreviewDialogOpen}>
        <DialogContent className="glass-card max-w-3xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Aperçu du post</DialogTitle>
            <DialogDescription>
              Voici à quoi ressemblera votre publication
            </DialogDescription>
          </DialogHeader>
          {previewPost && (
            <ScrollArea className="max-h-[70vh] pr-4">
              <div className="space-y-6">
                {/* Simulate social media post */}
                <div className="bg-card rounded-xl border border-border overflow-hidden">
                  {/* Post header */}
                  <div className="p-4 border-b border-border">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-r from-primary to-secondary rounded-full flex items-center justify-center">
                        <span className="text-sm font-bold text-white">
                          {(userProfile?.company_name || "AI").substring(0, 2).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-semibold text-sm">{userProfile?.company_name || "Mon Entreprise"}</p>
                        <p className="text-xs text-muted-foreground">Il y a quelques instants</p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Post content - text first */}
                  <div className="p-4">
                    <div className="prose prose-sm max-w-none">
                      <p className="whitespace-pre-wrap text-foreground leading-relaxed">{previewPost.content}</p>
                    </div>
                  </div>

                  {/* Post image */}
                  {previewPost.image_url && (
                    <div className="w-full">
                      <img
                        src={previewPost.image_url}
                        alt="Post illustration"
                        className="w-full h-auto object-cover"
                        onError={(e) => {
                          const img = e.currentTarget;
                          img.style.display = "none";
                          const wrap = img.parentElement;
                          if (wrap) {
                            wrap.innerHTML =
                              '<div class="py-12 text-center text-xs text-muted-foreground">Image indisponible</div>';
                          }
                        }}
                      />
                    </div>
                  )}

                  {/* Post footer - interaction buttons simulation */}
                  <div className="p-4 border-t border-border">
                    <p className="text-xs text-muted-foreground">
                      Plateformes: {previewPost.platforms?.join(', ') || 'Instagram'}
                    </p>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 pt-4">
                  <Button 
                    variant="outline" 
                    className="glass-card flex-1"
                    onClick={() => setIsPreviewDialogOpen(false)}
                  >
                    Fermer
                  </Button>
                  <Button 
                    className="bg-gradient-to-r from-primary to-secondary flex-1"
                    onClick={() => {
                      setIsPreviewDialogOpen(false);
                      handleEdit(previewPost);
                    }}
                  >
                    <Edit2 className="w-4 h-4 mr-2" />
                    Modifier
                  </Button>
                </div>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="glass-card max-w-5xl max-h-[92vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Modifier le post</DialogTitle>
            <DialogDescription>
              Relisez tout le texte, modifiez-le, puis régénérez le contenu ou l’affiche si nécessaire.
            </DialogDescription>
          </DialogHeader>
          {editingPost && (
            <ScrollArea className="max-h-[74vh] pr-4">
              <div className="grid lg:grid-cols-[1.3fr_0.9fr] gap-6 pb-2">
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="title">Titre</Label>
                    <Input
                      id="title"
                      value={editingPost.title}
                      onChange={(e) => setEditingPost({ ...editingPost, title: e.target.value })}
                      className="glass-card text-base"
                    />
                  </div>
                  <div>
                    <Label htmlFor="content">Contenu complet</Label>
                    <Textarea
                      id="content"
                      value={editingPost.content || ""}
                      onChange={(e) => setEditingPost({ ...editingPost, content: e.target.value })}
                      className="glass-card min-h-[320px] text-base leading-relaxed text-foreground placeholder:text-muted-foreground"
                    />
                    {(() => {
                      // A caption over the tightest selected network's limit can
                      // only be rejected or cut mid-sentence at publish time.
                      // Show it here, while the text can still be shortened.
                      const fit = checkTextFits(
                        editingPost.content || "",
                        editingPost.platforms || (editingPost.platform ? [editingPost.platform] : []),
                      );
                      return (
                        <p
                          className={`text-xs mt-2 ${fit.fits ? "text-muted-foreground" : "text-destructive font-medium"}`}
                        >
                          {fit.fits
                            ? `${fit.length} / ${fit.limit.maxChars} caractères (limite ${fit.limit.label}). Vous pouvez scroller et relire tout le texte avant validation.`
                            : `${fit.length} / ${fit.limit.maxChars} caractères — ${fit.overBy} de trop pour ${fit.limit.label}. Raccourcissez le texte, ou retirez ce réseau des cibles du post, sinon la publication échouera.`}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      className="glass-card"
                      onClick={() => handleRegenerateContent(editingPost)}
                      disabled={regeneratingContentIds.has(editingPost.id)}
                    >
                      {regeneratingContentIds.has(editingPost.id) ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4 mr-2" />
                      )}
                      Régénérer le contenu
                    </Button>
                    <Button
                      variant="outline"
                      className="glass-card"
                      onClick={() => handleRegenerateImage(editingPost)}
                      disabled={generatingImageIds.has(editingPost.id)}
                    >
                      {generatingImageIds.has(editingPost.id) ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <ImageIcon className="w-4 h-4 mr-2" />
                      )}
                      Régénérer l’affiche
                    </Button>
                  </div>
                  <div>
                    <Label className="mb-3 block">Plateformes de publication</Label>
                    <div className="grid sm:grid-cols-2 gap-3">
                      {['Instagram', 'Facebook', 'Twitter', 'LinkedIn', 'TikTok'].map((platform) => (
                        <div key={platform} className="flex items-center space-x-2 rounded-lg border border-border/50 p-3 bg-card/40">
                          <Checkbox
                            id={platform}
                            checked={editingPost.platforms?.includes(platform) || false}
                            onCheckedChange={(checked) => {
                              const currentPlatforms = editingPost.platforms || [];
                              const newPlatforms = checked
                                ? [...currentPlatforms, platform]
                                : currentPlatforms.filter(p => p !== platform);
                              setEditingPost({
                                ...editingPost,
                                platforms: newPlatforms,
                                platform: newPlatforms[0] || 'Instagram'
                              });
                            }}
                          />
                          <label htmlFor={platform} className="text-sm cursor-pointer">
                            {platform}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="date">Date</Label>
                      <Input
                        id="date"
                        type="date"
                        value={editingPost.date || ''}
                        onChange={(e) => setEditingPost({ ...editingPost, date: e.target.value })}
                        className="glass-card"
                      />
                    </div>
                    <div>
                      <Label htmlFor="time">Heure</Label>
                      <Input
                        id="time"
                        type="time"
                        value={editingPost.time || ''}
                        onChange={(e) => setEditingPost({ ...editingPost, time: e.target.value })}
                        className="glass-card"
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <Label>Aperçu affiche</Label>
                  {editingPost.image_url ? (
                    <img
                      src={editingPost.image_url}
                      alt="Post"
                      className="w-full rounded-xl border border-border/60 bg-muted object-cover max-h-[560px]"
                      onError={(e) => {
                        const img = e.currentTarget;
                        img.style.display = "none";
                        const wrap = img.parentElement;
                        if (wrap) {
                          wrap.insertAdjacentHTML(
                            "beforeend",
                            '<p class="text-xs text-muted-foreground mt-2">Image indisponible</p>',
                          );
                        }
                      }}
                    />
                  ) : (
                    <div className="rounded-xl border border-dashed border-border h-64 flex items-center justify-center text-sm text-muted-foreground bg-muted/40">
                      Aucune affiche pour le moment
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2 pt-4 sticky bottom-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
                <Button
                  variant="outline"
                  onClick={() => setIsEditDialogOpen(false)}
                  className="glass-card flex-1"
                >
                  Annuler
                </Button>
                <Button
                  onClick={handleSaveEdit}
                  className="bg-gradient-to-r from-primary to-secondary flex-1"
                >
                  Enregistrer
                </Button>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      {/* Settings Dialog */}
      <SettingsDialog
        isOpen={isSettingsDialogOpen}
        onOpenChange={setIsSettingsDialogOpen}
        userProfile={userProfile}
        onProfileUpdate={checkAuthAndLoadData}
      />

      <SocialMediaConnect
        isOpen={isSocialMediaDialogOpen}
        onOpenChange={setIsSocialMediaDialogOpen}
        userProfile={userProfile}
        onUpdate={checkAuthAndLoadData}
      />
    </div>
  );
}