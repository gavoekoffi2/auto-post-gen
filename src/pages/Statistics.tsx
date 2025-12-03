import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, TrendingUp, Eye, Heart, MessageCircle, Share2, BarChart3, Calendar } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export default function Statistics() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalPosts: 0,
    publishedPosts: 0,
    pendingPosts: 0,
    validatedPosts: 0,
    postsThisWeek: 0,
    postsThisMonth: 0,
  });

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }

      const { data: posts, error } = await supabase
        .from('posts')
        .select('*')
        .eq('user_id', session.user.id);

      if (error) throw error;

      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const postsThisWeek = (posts || []).filter(p => 
        new Date(p.created_at || '') >= startOfWeek
      ).length;

      const postsThisMonth = (posts || []).filter(p => 
        new Date(p.created_at || '') >= startOfMonth
      ).length;

      setStats({
        totalPosts: posts?.length || 0,
        publishedPosts: posts?.filter(p => p.status === 'published').length || 0,
        pendingPosts: posts?.filter(p => p.status === 'pending').length || 0,
        validatedPosts: posts?.filter(p => p.status === 'validated').length || 0,
        postsThisWeek,
        postsThisMonth,
      });
    } catch (error: any) {
      toast.error('Erreur lors du chargement des statistiques');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse">Chargement...</div>
      </div>
    );
  }

  const statCards = [
    { label: "Total des posts", value: stats.totalPosts, icon: BarChart3, color: "primary" },
    { label: "Posts validés", value: stats.validatedPosts, icon: Heart, color: "secondary" },
    { label: "En attente", value: stats.pendingPosts, icon: Eye, color: "accent" },
    { label: "Publiés", value: stats.publishedPosts, icon: Share2, color: "primary" },
    { label: "Cette semaine", value: stats.postsThisWeek, icon: Calendar, color: "secondary" },
    { label: "Ce mois", value: stats.postsThisMonth, icon: TrendingUp, color: "accent" },
  ];

  return (
    <div className="min-h-screen">
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Button>
            <h1 className="text-xl font-bold">Statistiques</h1>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-7xl px-4 py-8">
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          {statCards.map((stat, index) => (
            <Card 
              key={stat.label} 
              className="glass-card p-6 animate-fade-in"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="flex items-center justify-between mb-4">
                <stat.icon className={`w-8 h-8 text-${stat.color}`} />
                <span className="text-3xl font-bold gradient-text">{stat.value}</span>
              </div>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </Card>
          ))}
        </div>

        <Card className="glass-card p-6">
          <h2 className="text-lg font-semibold mb-4">Aperçu de votre activité</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
              <span>Taux de validation</span>
              <span className="font-bold">
                {stats.totalPosts > 0 
                  ? Math.round((stats.validatedPosts / stats.totalPosts) * 100) 
                  : 0}%
              </span>
            </div>
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
              <span>Posts créés cette semaine</span>
              <span className="font-bold">{stats.postsThisWeek}</span>
            </div>
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
              <span>Posts créés ce mois</span>
              <span className="font-bold">{stats.postsThisMonth}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
