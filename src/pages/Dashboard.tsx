import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, TrendingUp, CheckCircle, Clock, Edit2, Sparkles, Settings, Share2, Calendar as CalendarIcon, Trash2, User, BarChart3, Send, ImageIcon, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import SettingsDialog from "@/components/SettingsDialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SocialMediaConnect } from "@/components/SocialMediaConnect";

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
  image_url?: string;
  status: PostStatus;
};

type UserProfile = {
  id?: string;
  description?: string | null;
  platforms?: string[] | null;
  [key: string]: unknown;
};

export default function Dashboard() {
  const navigate = useNavigate();
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
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    checkAuthAndLoadData();
  }, []);

  const checkAuthAndLoadData = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }

      // Load user profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      
      setUserProfile(profile);

      // Load posts
      const { data: postsData, error } = await supabase
        .from('posts')
        .select('*')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      const transformedPosts: Post[] = (postsData || []).map((post) => {
        const status: PostStatus =
          post.status === "validated" ||
          post.status === "published" ||
          post.status === "failed"
            ? (post.status as PostStatus)
            : "pending";
        return {
          ...post,
          platform: post.platforms?.[0] || 'Instagram',
          date: post.scheduled_for ? new Date(post.scheduled_for).toISOString().split('T')[0] : '',
          time: post.scheduled_for
            ? new Date(post.scheduled_for).toTimeString().substring(0, 5)
            : '',
          status,
        };
      });

      setPosts(transformedPosts);
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Erreur lors du chargement des données');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Déconnexion réussie");
    navigate("/");
  };

  const handleValidate = async (postId: string) => {
    try {
      const { error } = await supabase
        .from('posts')
        .update({ status: 'validated' })
        .eq('id', postId);

      if (error) throw error;

      setPosts(posts.map(post =>
        post.id === postId ? { ...post, status: "validated" as const } : post
      ));
      toast.success("Post validé !");
    } catch (_error) {
      toast.error('Erreur lors de la validation');
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
      const { data, error } = await supabase.functions.invoke('publish-post', {
        body: { postId: post.id },
      });
      toast.dismiss(loadingToast);
      if (error) throw error;
      const results = (data?.results || []) as Array<{ status: string; platform: string; message?: string }>;
      const anyOk = results.some((r) => r.status === "ok");
      const allErrors = results.length > 0 && results.every((r) => r.status === "error");
      // Refresh from the DB so the displayed status matches whatever
      // publish-post settled on (published, failed or rolled back to
      // validated when nothing was attempted).
      const { data: refreshed } = await supabase
        .from("posts")
        .select("status")
        .eq("id", post.id)
        .maybeSingle();
      if (refreshed) {
        const status = (refreshed.status as PostStatus) || post.status;
        setPosts((prev) =>
          prev.map((p) => (p.id === post.id ? { ...p, status } : p)),
        );
      }
      if (anyOk) {
        toast.success("Post publié !");
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
      const { error } = await supabase
        .from('posts')
        .update({ status: 'validated', publish_error: null })
        .eq('id', post.id);
      if (error) throw error;
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
      const { error } = await supabase
        .from('posts')
        .update({
          title: editingPost.title,
          content: editingPost.content,
          platforms: editingPost.platforms || ['Instagram'],
          scheduled_for: editingPost.date && editingPost.time
            ? `${editingPost.date}T${editingPost.time}:00`
            : null,
        })
        .eq('id', editingPost.id);

      if (error) throw error;

      setPosts(posts.map(post =>
        post.id === editingPost.id ? editingPost : post
      ));
      setIsEditDialogOpen(false);
      setEditingPost(null);
      toast.success("Post modifié !");
    } catch (_error) {
      toast.error('Erreur lors de la modification');
    }
  };

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    const loadingToast = toast.loading("Génération du texte en cours...");
    try {
      const { data, error } = await supabase.functions.invoke('generate-content', {
        body: {
          prompt: "Génère un post engageant pour mes réseaux sociaux",
          userPreferences: userProfile,
        },
      });

      toast.dismiss(loadingToast);

      if (error) {
        console.error('Edge function error:', error);
        throw error;
      }
      if (!data || !data.content) {
        throw new Error('Aucun contenu reçu de la génération');
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      const defaultPlatforms =
        userProfile?.platforms && userProfile.platforms.length > 0
          ? userProfile.platforms
          : ['Instagram'];

      // 1. Save the post immediately with text only so the user sees
      //    the result without waiting for the slow image generation.
      const newPost = {
        user_id: session.user.id,
        title: "Nouveau contenu IA",
        content: data.content,
        image_url: null,
        status: 'pending' as const,
        platforms: defaultPlatforms,
      };

      const { data: savedPost, error: saveError } = await supabase
        .from('posts')
        .insert(newPost)
        .select()
        .single();

      if (saveError) throw saveError;

      const status: PostStatus =
        savedPost.status === "validated" ||
        savedPost.status === "published" ||
        savedPost.status === "failed"
          ? (savedPost.status as PostStatus)
          : "pending";

      const transformedPost: Post = {
        ...savedPost,
        platform: savedPost.platforms?.[0] || 'Instagram',
        date: savedPost.scheduled_for ? new Date(savedPost.scheduled_for).toISOString().split('T')[0] : '',
        time: savedPost.scheduled_for ? new Date(savedPost.scheduled_for).toTimeString().substring(0, 5) : '',
        status,
      };

      setPosts((prev) => [transformedPost, ...prev]);
      toast.success("Texte généré. L'image est en cours...");

      // 2. Kick off image generation asynchronously. Don't block the UI.
      //    Mark the post as generating-image so the card can show a
      //    spinner placeholder instead of nothing.
      setGeneratingImageIds((prev) => new Set(prev).add(savedPost.id));
      void (async () => {
        try {
          const { data: imgData, error: imgError } = await supabase.functions.invoke(
            'generate-image',
            {
              body: {
                postContent: data.content,
                peopleType: userProfile?.image_people_type || 'african',
                postId: savedPost.id,
              },
            },
          );
          if (imgError) throw imgError;
          if (imgData?.imageUrl) {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === savedPost.id ? { ...p, image_url: imgData.imageUrl } : p,
              ),
            );
            toast.success("Image ajoutée au post");
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
    const loadingToast = toast.loading("Génération d'image...");
    try {
      const { data, error } = await supabase.functions.invoke('generate-image', {
        body: {
          postContent: post.content,
          peopleType: userProfile?.image_people_type || 'african',
          postId: post.id,
        },
      });
      toast.dismiss(loadingToast);
      if (error) throw error;
      if (data?.imageUrl) {
        setPosts((prev) =>
          prev.map((p) => (p.id === post.id ? { ...p, image_url: data.imageUrl } : p)),
        );
        toast.success("Image générée");
      } else {
        toast.error("Image non générée");
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

  const handleProfile = () => {
    navigate('/profile');
  };

  const handleDelete = async (postId: string) => {
    if (deletingIds.has(postId)) return;
    setDeletingIds((prev) => new Set(prev).add(postId));
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId);

      if (error) throw error;

      setPosts(posts.filter(post => post.id !== postId));
      toast.success("Post supprimé !");
    } catch (_error) {
      toast.error('Erreur lors de la suppression');
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
              <Button onClick={handleProfile} variant="outline" size="sm" className="glass-card">
                <User className="w-4 h-4 mr-2" />
                Profil
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
                  {generating ? "Génération..." : "Générer votre premier post"}
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
                  {generating ? "Génération..." : "Générer"}
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
                          {userProfile?.description?.substring(0, 2).toUpperCase() || "AI"}
                        </span>
                      </div>
                      <div>
                        <p className="font-semibold text-sm">{userProfile?.description?.split('.')[0] || "Mon Entreprise"}</p>
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
        <DialogContent className="glass-card">
          <DialogHeader>
            <DialogTitle>Modifier le post</DialogTitle>
            <DialogDescription>
              Modifiez le contenu de votre publication avant de la valider.
            </DialogDescription>
          </DialogHeader>
          {editingPost && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="title">Titre</Label>
                <Input
                  id="title"
                  value={editingPost.title}
                  onChange={(e) => setEditingPost({ ...editingPost, title: e.target.value })}
                  className="glass-card"
                />
              </div>
              <div>
                <Label htmlFor="content">Contenu</Label>
                <Textarea
                  id="content"
                  value={editingPost.content || ""}
                  onChange={(e) => setEditingPost({ ...editingPost, content: e.target.value })}
                  className="glass-card min-h-[100px]"
                />
              </div>
              {editingPost.image_url && (
                <div>
                  <Label>Image générée</Label>
                  <img
                    src={editingPost.image_url}
                    alt="Post"
                    className="w-full rounded-lg mt-2"
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
                </div>
              )}
              <div>
                <Label className="mb-3 block">Plateformes de publication</Label>
                <div className="space-y-3">
                  {['Instagram', 'Facebook', 'Twitter', 'LinkedIn', 'TikTok'].map((platform) => (
                    <div key={platform} className="flex items-center space-x-2">
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
              <div className="flex gap-2">
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
            </div>
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