import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, TrendingUp, Eye, Heart, Share2, BarChart3, Calendar } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, Legend } from "recharts";

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
  const [weeklyData, setWeeklyData] = useState<{ name: string; posts: number }[]>([]);
  const [platformData, setPlatformData] = useState<{ name: string; value: number }[]>([]);

  const COLORS = ['hsl(263, 70%, 50%)', 'hsl(217, 91%, 60%)', 'hsl(280, 80%, 60%)', 'hsl(142, 76%, 36%)', 'hsl(0, 84%, 60%)'];

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Generate weekly data for chart (last 4 weeks)
      const weeklyStats = [];
      for (let i = 3; i >= 0; i--) {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - (now.getDay() + 7 * i));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);

        const count = (posts || []).filter(p => {
          const postDate = new Date(p.created_at || '');
          return postDate >= weekStart && postDate < weekEnd;
        }).length;

        weeklyStats.push({
          name: `Sem. ${4 - i}`,
          posts: count,
        });
      }
      setWeeklyData(weeklyStats);

      // Generate platform data
      const platformCounts: Record<string, number> = {};
      (posts || []).forEach(post => {
        (post.platforms || []).forEach((platform: string) => {
          platformCounts[platform] = (platformCounts[platform] || 0) + 1;
        });
      });

      setPlatformData(
        Object.entries(platformCounts).map(([name, value]) => ({ name, value }))
      );

    } catch (_error) {
      toast.error('Erreur lors du chargement des statistiques');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Chargement...</div>
      </div>
    );
  }

  const statCards = [
    { label: "Total des posts", value: stats.totalPosts, icon: BarChart3, color: "text-primary" },
    { label: "Posts validés", value: stats.validatedPosts, icon: Heart, color: "text-secondary" },
    { label: "En attente", value: stats.pendingPosts, icon: Eye, color: "text-accent" },
    { label: "Publiés", value: stats.publishedPosts, icon: Share2, color: "text-primary" },
    { label: "Cette semaine", value: stats.postsThisWeek, icon: Calendar, color: "text-secondary" },
    { label: "Ce mois", value: stats.postsThisMonth, icon: TrendingUp, color: "text-accent" },
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
        {/* Stats Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          {statCards.map((stat, index) => (
            <Card 
              key={stat.label} 
              className="glass-card p-6 animate-fade-in"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="flex items-center justify-between mb-4">
                <stat.icon className={`w-8 h-8 ${stat.color}`} />
                <span className="text-3xl font-bold gradient-text">{stat.value}</span>
              </div>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </Card>
          ))}
        </div>

        {/* Charts */}
        <div className="grid lg:grid-cols-2 gap-8 mb-8">
          {/* Weekly Posts Chart */}
          <Card className="glass-card p-6">
            <h2 className="text-lg font-semibold mb-4">Posts par semaine</h2>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={weeklyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" />
                <YAxis stroke="hsl(var(--muted-foreground))" />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                />
                <Bar 
                  dataKey="posts" 
                  fill="url(#colorGradient)" 
                  radius={[4, 4, 0, 0]}
                />
                <defs>
                  <linearGradient id="colorGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(263, 70%, 50%)" />
                    <stop offset="100%" stopColor="hsl(217, 91%, 60%)" />
                  </linearGradient>
                </defs>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Platform Distribution Chart */}
          <Card className="glass-card p-6">
            <h2 className="text-lg font-semibold mb-4">Répartition par plateforme</h2>
            {platformData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={platformData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {platformData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                Aucune donnée de plateforme disponible
              </div>
            )}
          </Card>
        </div>

        {/* Activity Overview */}
        <Card className="glass-card p-6">
          <h2 className="text-lg font-semibold mb-4">Aperçu de votre activité</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Taux de validation</span>
              <p className="text-2xl font-bold gradient-text mt-1">
                {stats.totalPosts > 0 
                  ? Math.round((stats.validatedPosts / stats.totalPosts) * 100) 
                  : 0}%
              </p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Posts créés cette semaine</span>
              <p className="text-2xl font-bold gradient-text mt-1">{stats.postsThisWeek}</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <span className="text-sm text-muted-foreground">Posts créés ce mois</span>
              <p className="text-2xl font-bold gradient-text mt-1">{stats.postsThisMonth}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
