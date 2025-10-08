import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar, TrendingUp, Clock, CheckCircle, Sparkles, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Post = {
  id: string;
  platform: string;
  date: string;
  time: string;
  title: string;
  content?: string;
  status: "pending" | "validated";
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [posts, setPosts] = useState<Post[]>([
    {
      id: "1",
      platform: "Instagram",
      date: "2025-10-10",
      time: "14:00",
      title: "5 conseils pour améliorer votre productivité",
      content: "Découvrez nos meilleurs conseils pour booster votre productivité au quotidien ! #productivité #motivation",
      status: "pending"
    },
    {
      id: "2",
      platform: "LinkedIn",
      date: "2025-10-11",
      time: "09:00",
      title: "Comment l'IA transforme le marketing digital",
      content: "L'intelligence artificielle révolutionne le marketing digital. Voici comment en tirer parti pour votre entreprise.",
      status: "validated"
    },
    {
      id: "3",
      platform: "TikTok",
      date: "2025-10-12",
      time: "18:00",
      title: "Démonstration rapide de notre produit",
      content: "Une démo express de notre nouveau produit ! 🚀 #innovation #tech",
      status: "pending"
    }
  ]);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    toast.success("Déconnexion réussie");
    navigate("/");
  };

  const handleValidate = (postId: string) => {
    setPosts(prev => prev.map(post => 
      post.id === postId ? { ...post, status: "validated" as const } : post
    ));
    toast.success("Post validé avec succès !");
  };

  const handleEdit = (post: Post) => {
    setEditingPost({ ...post });
    setIsEditDialogOpen(true);
  };

  const handleSaveEdit = () => {
    if (editingPost) {
      setPosts(prev => prev.map(post => 
        post.id === editingPost.id ? editingPost : post
      ));
      setIsEditDialogOpen(false);
      toast.success("Post modifié avec succès !");
    }
  };

  const handleGenerate = () => {
    const newPost: Post = {
      id: Date.now().toString(),
      platform: "Instagram",
      date: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
      time: "15:00",
      title: "Nouveau contenu généré par l'IA",
      content: "Contenu généré automatiquement par notre IA. Personnalisez-le selon vos besoins !",
      status: "pending"
    };
    setPosts(prev => [...prev, newPost]);
    toast.success("Nouveau contenu généré !");
  };

  const handleCalendar = () => {
    toast.info("Calendrier - Fonctionnalité à venir");
  };

  const handleStats = () => {
    toast.info("Statistiques - Fonctionnalité à venir");
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
            <Button onClick={handleSignOut} variant="outline" className="glass-card">
              Déconnexion
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-7xl px-4 py-8">
        {/* Stats */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <Card className="glass-card p-6 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <Calendar className="w-8 h-8 text-primary" />
              <span className="text-3xl font-bold gradient-text">12</span>
            </div>
            <p className="text-sm text-muted-foreground">Posts programmés</p>
          </Card>

          <Card className="glass-card p-6 animate-fade-in" style={{ animationDelay: "0.1s" }}>
            <div className="flex items-center justify-between mb-4">
              <CheckCircle className="w-8 h-8 text-secondary" />
              <span className="text-3xl font-bold gradient-text">8</span>
            </div>
            <p className="text-sm text-muted-foreground">Posts validés</p>
          </Card>

          <Card className="glass-card p-6 animate-fade-in" style={{ animationDelay: "0.2s" }}>
            <div className="flex items-center justify-between mb-4">
              <Clock className="w-8 h-8 text-accent" />
              <span className="text-3xl font-bold gradient-text">4</span>
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
            <div className="space-y-4">
              {posts.map((post, index) => (
                <Card key={post.id} className="glass-card p-6 hover:scale-[1.02] transition-all animate-fade-in" style={{ animationDelay: `${index * 0.1}s` }}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-r from-primary to-secondary rounded-lg flex items-center justify-center">
                        <span className="text-xs font-bold text-white">{post.platform.substring(0, 2)}</span>
                      </div>
                      <div>
                        <p className="font-medium">{post.title}</p>
                        <p className="text-xs text-muted-foreground">{post.platform}</p>
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
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-4 h-4" />
                      {post.date}
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      {post.time}
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="glass-card flex-1"
                      onClick={() => handleEdit(post)}
                    >
                      <Pencil className="w-4 h-4 mr-1" />
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
                  </div>
                </Card>
              ))}
            </div>
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
                <h3 className="font-semibold mb-2">Statistiques</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Analyser vos performances
                </p>
                <Button 
                  variant="outline" 
                  className="w-full glass-card"
                  onClick={handleStats}
                >
                  <TrendingUp className="w-4 h-4 mr-2" />
                  Voir
                </Button>
              </Card>
            </div>
          </div>
        </div>
      </div>

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
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="date">Date</Label>
                  <Input
                    id="date"
                    type="date"
                    value={editingPost.date}
                    onChange={(e) => setEditingPost({ ...editingPost, date: e.target.value })}
                    className="glass-card"
                  />
                </div>
                <div>
                  <Label htmlFor="time">Heure</Label>
                  <Input
                    id="time"
                    type="time"
                    value={editingPost.time}
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
    </div>
  );
}
