import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, TrendingUp, CheckCircle, Clock, Edit2, Sparkles, Settings, Share2, Calendar as CalendarIcon, Trash2, User, BarChart3 } from "lucide-react";
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
  status: "pending" | "validated";
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
  const [userProfile, setUserProfile] = useState<any>(null);

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
      
      // Transform database posts to match component format
      const transformedPosts = (postsData || []).map(post => ({
        ...post,
        platform: post.platforms?.[0] || 'Instagram',
        date: post.scheduled_for ? new Date(post.scheduled_for).toISOString().split('T')[0] : '',
        time: post.scheduled_for ? new Date(post.scheduled_for).toTimeString().substring(0, 5) : '',
        status: (post.status === 'validated' ? 'validated' : 'pending') as 'pending' | 'validated',
      }));
      
      setPosts(transformedPosts);
    } catch (error: any) {
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
    } catch (error: any) {
      toast.error('Erreur lors de la validation');
    }
  };

  const handleEdit = (post: Post) => {
    setEditingPost({ ...post });
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (editingPost) {
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
      } catch (error: any) {
        toast.error('Erreur lors de la modification');
      }
    }
  };

  const handleGenerate = async () => {
    try {
      const loadingToast = toast.loading("Génération de contenu et d'image en cours...");
      
      const { data, error } = await supabase.functions.invoke('generate-content', {
        body: { 
          prompt: "Génère un post engageant pour mes réseaux sociaux",
          userPreferences: userProfile 
        }
      });

      toast.dismiss(loadingToast);

      if (error) {
        console.error('Edge function error:', error);
        throw error;
      }

      if (!data) {
        throw new Error('Aucune donnée reçue de la génération');
      }

      console.log('Generated content:', { content: data.content?.substring(0, 100), hasImage: !!data.imageUrl });

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Non authentifié");

      // Use user's preferred platforms or default to Instagram
      const defaultPlatforms = userProfile?.platforms && userProfile.platforms.length > 0 
        ? userProfile.platforms 
        : ['Instagram'];

      // Save to database
      const newPost = {
        user_id: session.user.id,
        title: "Nouveau contenu IA",
        content: data.content || "Contenu généré",
        image_url: data.imageUrl || null,
        status: 'pending',
        platforms: defaultPlatforms,
      };

      console.log('Saving post to DB:', newPost);

      const { data: savedPost, error: saveError } = await supabase
        .from('posts')
        .insert(newPost)
        .select()
        .single();

      if (saveError) {
        console.error('Save error:', saveError);
        throw saveError;
      }

      console.log('Post saved successfully:', savedPost.id);

      // Transform to match component format
      const transformedPost = {
        ...savedPost,
        platform: savedPost.platforms?.[0] || 'Instagram',
        date: savedPost.scheduled_for ? new Date(savedPost.scheduled_for).toISOString().split('T')[0] : '',
        time: savedPost.scheduled_for ? new Date(savedPost.scheduled_for).toTimeString().substring(0, 5) : '',
        status: (savedPost.status === 'validated' ? 'validated' : 'pending') as 'pending' | 'validated',
      };

      setPosts([transformedPost, ...posts]);
      toast.success("Contenu et image générés avec succès !");
    } catch (error: any) {
      console.error('Generation error:', error);
      toast.error(error.message || 'Erreur lors de la génération');
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
    try {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId);

      if (error) throw error;

      setPosts(posts.filter(post => post.id !== postId));
      toast.success("Post supprimé !");
    } catch (error: any) {
      toast.error('Erreur lors de la suppression');
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
              <span className="font-bold text-xl">ContentAI</span>
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
              <span className="text-3xl font-bold gradient-text">+24%</span>
            </div>
            <p className="text-sm text-muted-foreground">Engagement</p>
          </Card>
        </div>

        {/* Upcoming posts */}
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <h2 className="text-2xl font-bold mb-6">Publications à venir</h2>
            {posts.length === 0 ? (
              <Card className="glass-card p-8 text-center">
                <p className="text-muted-foreground mb-4">Aucun post pour le moment</p>
                <Button onClick={handleGenerate} className="bg-gradient-to-r from-primary to-secondary">
                  <Sparkles className="w-4 h-4 mr-2" />
                  Générer votre premier post
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
                        post.status === "validated" 
                          ? "bg-secondary/20 text-secondary" 
                          : "bg-accent/20 text-accent"
                      }`}>
                        {post.status === "validated" ? "Validé" : "En attente"}
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
                     {post.image_url && (
                       <div className="mb-4 rounded-lg overflow-hidden">
                         <img src={post.image_url} alt="Post illustration" className="w-full h-48 object-cover" />
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
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="glass-card text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(post.id)}
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
                >
                  <Sparkles className="w-4 h-4 mr-2" />
                  Générer
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
                  <img src={editingPost.image_url} alt="Post" className="w-full rounded-lg mt-2" />
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