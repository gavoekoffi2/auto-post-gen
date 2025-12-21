import { BarChart3, Calendar, MessageSquare, TrendingUp, Users, Zap } from "lucide-react";

export const DashboardPreview = () => {
  return (
    <div className="relative w-full max-w-5xl mx-auto">
      {/* Glow effect behind dashboard */}
      <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 via-accent/20 to-primary/20 rounded-3xl blur-3xl opacity-60 animate-pulse-glow" />
      
      {/* Main dashboard card */}
      <div className="relative glass-card-strong rounded-3xl overflow-hidden shadow-3d">
        {/* Browser-like header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-muted/30">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <div className="w-3 h-3 rounded-full bg-green-400" />
          </div>
          <div className="flex-1 flex justify-center">
            <div className="px-4 py-1 rounded-full bg-muted/50 text-xs text-muted-foreground">
              app.autopublish.ai/dashboard
            </div>
          </div>
        </div>
        
        {/* Dashboard content */}
        <div className="p-6 grid grid-cols-12 gap-4">
          {/* Sidebar preview */}
          <div className="col-span-2 space-y-3">
            <div className="w-full h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            {[Calendar, MessageSquare, BarChart3, Users].map((Icon, i) => (
              <div key={i} className="w-full h-10 rounded-lg bg-muted/50 flex items-center justify-center hover:bg-muted/70 transition-colors">
                <Icon className="w-5 h-5 text-muted-foreground" />
              </div>
            ))}
          </div>
          
          {/* Main content area */}
          <div className="col-span-10 space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: "Publications", value: "127", trend: "+12%", color: "primary" },
                { label: "Engagement", value: "24.5K", trend: "+8%", color: "accent" },
                { label: "Followers", value: "15.2K", trend: "+23%", color: "primary" },
                { label: "Portée", value: "89K", trend: "+18%", color: "accent" }
              ].map((stat, i) => (
                <div key={i} className="p-4 rounded-xl bg-muted/30 border border-border/30 hover-lift">
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <div className="flex items-end justify-between mt-1">
                    <span className="text-2xl font-bold text-foreground">{stat.value}</span>
                    <span className="text-xs text-green-500 flex items-center gap-0.5">
                      <TrendingUp className="w-3 h-3" />
                      {stat.trend}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            
            {/* Chart area */}
            <div className="p-4 rounded-xl bg-muted/20 border border-border/30">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-sm">Performance cette semaine</h3>
                <div className="flex gap-2">
                  {["7j", "30j", "90j"].map((period, i) => (
                    <button
                      key={i}
                      className={`px-3 py-1 rounded-full text-xs transition-colors ${
                        i === 0 ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>
              
              {/* Fake chart */}
              <div className="flex items-end gap-2 h-32">
                {[40, 65, 45, 80, 55, 90, 75].map((height, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div 
                      className="w-full rounded-t-lg bg-gradient-to-t from-primary to-primary-light transition-all duration-500 hover:opacity-80"
                      style={{ height: `${height}%` }}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"][i]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            
            {/* Posts preview */}
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3].map((_, i) => (
                <div key={i} className="p-3 rounded-xl bg-muted/20 border border-border/30 space-y-2 hover-lift">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg ${
                      i === 0 ? "bg-pink-500/20" : i === 1 ? "bg-blue-500/20" : "bg-sky-500/20"
                    } flex items-center justify-center`}>
                      <MessageSquare className={`w-4 h-4 ${
                        i === 0 ? "text-pink-500" : i === 1 ? "text-blue-500" : "text-sky-500"
                      }`} />
                    </div>
                    <div className="flex-1">
                      <div className="h-2 w-20 bg-muted/50 rounded" />
                      <div className="h-1.5 w-12 bg-muted/30 rounded mt-1" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-2 w-full bg-muted/40 rounded" />
                    <div className="h-2 w-4/5 bg-muted/30 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      
      {/* Floating notification cards */}
      <div className="absolute -right-4 top-20 animate-float" style={{ animationDelay: '0.5s' }}>
        <div className="glass-card px-4 py-3 rounded-xl shadow-xl flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <p className="text-xs font-medium">Engagement +45%</p>
            <p className="text-[10px] text-muted-foreground">Cette semaine</p>
          </div>
        </div>
      </div>
      
      <div className="absolute -left-4 bottom-32 animate-float-slow" style={{ animationDelay: '1s' }}>
        <div className="glass-card px-4 py-3 rounded-xl shadow-xl flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-medium">3 posts publiés</p>
            <p className="text-[10px] text-muted-foreground">Automatiquement</p>
          </div>
        </div>
      </div>
    </div>
  );
};
