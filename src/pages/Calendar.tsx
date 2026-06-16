import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar as CalendarIcon, ArrowLeft, Clock } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

type Post = {
  id: string;
  title: string;
  content: string;
  image_url?: string;
  scheduled_for?: string;
  platforms?: string[];
  status: string;
};

export default function CalendarPage() {
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [isScheduleDialogOpen, setIsScheduleDialogOpen] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPosts = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth');
        return;
      }

      const { data: postsData, error } = await supabase
        .from('posts')
        .select('*')
        .eq('user_id', session.user.id)
        .order('scheduled_for', { ascending: true });

      if (error) throw error;
      setPosts(postsData || []);
    } catch (error) {
      console.error('Error loading posts:', error);
      toast.error('Erreur lors du chargement des posts');
    } finally {
      setLoading(false);
    }
  };

  const handleSchedule = (post: Post) => {
    setSelectedPost(post);
    setIsScheduleDialogOpen(true);
    if (post.scheduled_for) {
      const date = new Date(post.scheduled_for);
      setScheduleTime(date.toTimeString().substring(0, 5));
      setSelectedDate(date);
    }
  };

  const handleSaveSchedule = async () => {
    if (!selectedPost || !selectedDate || !scheduleTime) {
      toast.error("Veuillez sélectionner une date et une heure");
      return;
    }

    try {
      const scheduledDateTime = new Date(selectedDate);
      const [hours, minutes] = scheduleTime.split(':');
      scheduledDateTime.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);

      if (scheduledDateTime.getTime() < Date.now()) {
        toast.error("L'heure de publication est déjà passée. Choisissez une date future.");
        return;
      }

      const { error } = await supabase
        .from('posts')
        .update({ scheduled_for: scheduledDateTime.toISOString() })
        .eq('id', selectedPost.id);

      if (error) throw error;

      toast.success("Post programmé avec succès !");
      setIsScheduleDialogOpen(false);
      loadPosts();
    } catch (error) {
      console.error('Error scheduling post:', error);
      toast.error('Erreur lors de la programmation');
    }
  };

  const getPostsForDate = (date: Date) => {
    return posts.filter(post => {
      if (!post.scheduled_for) return false;
      const postDate = new Date(post.scheduled_for);
      return postDate.toDateString() === date.toDateString();
    });
  };

  const postsForSelectedDate = selectedDate ? getPostsForDate(selectedDate) : [];
  const unscheduledPosts = posts.filter(post => !post.scheduled_for);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse">Chargement...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => navigate('/dashboard')}
                className="glass-card"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Retour
              </Button>
              <h1 className="text-2xl font-bold">Calendrier de publication</h1>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-7xl px-4 py-8">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Calendar */}
          <div className="lg:col-span-2">
            <Card className="glass-card p-6">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                locale={fr}
                className="rounded-md"
              />
            </Card>

            {selectedDate && (
              <div className="mt-6">
                <h2 className="text-xl font-bold mb-4">
                  Posts pour le {format(selectedDate, "d MMMM yyyy", { locale: fr })}
                </h2>
                {postsForSelectedDate.length === 0 ? (
                  <Card className="glass-card p-6 text-center">
                    <p className="text-muted-foreground">Aucun post programmé pour cette date</p>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {postsForSelectedDate.map((post) => (
                      <Card key={post.id} className="glass-card p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <p className="font-medium">{post.title}</p>
                            <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                              {post.content}
                            </p>
                            {post.scheduled_for && (
                              <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                                <Clock className="w-4 h-4" />
                                {format(new Date(post.scheduled_for), "HH:mm")}
                              </div>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSchedule(post)}
                            className="glass-card ml-4"
                          >
                            Modifier
                          </Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Unscheduled posts */}
          <div>
            <h2 className="text-xl font-bold mb-4">Posts non programmés</h2>
            {unscheduledPosts.length === 0 ? (
              <Card className="glass-card p-6 text-center">
                <p className="text-muted-foreground">Tous les posts sont programmés</p>
              </Card>
            ) : (
              <div className="space-y-4">
                {unscheduledPosts.map((post) => (
                  <Card key={post.id} className="glass-card p-4">
                    <p className="font-medium mb-2">{post.title}</p>
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                      {post.content}
                    </p>
                    <Button
                      size="sm"
                      onClick={() => handleSchedule(post)}
                      className="w-full bg-gradient-to-r from-primary to-secondary"
                    >
                      <CalendarIcon className="w-4 h-4 mr-2" />
                      Programmer
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Schedule Dialog */}
      <Dialog open={isScheduleDialogOpen} onOpenChange={setIsScheduleDialogOpen}>
        <DialogContent className="glass-card">
          <DialogHeader>
            <DialogTitle>Programmer la publication</DialogTitle>
            <DialogDescription>
              Choisissez la date et l'heure de publication
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Date</Label>
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                locale={fr}
                className="rounded-md border border-border"
              />
            </div>
            <div>
              <Label htmlFor="time">Heure</Label>
              <Input
                id="time"
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="glass-card"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="glass-card flex-1"
                onClick={() => setIsScheduleDialogOpen(false)}
              >
                Annuler
              </Button>
              <Button
                className="bg-gradient-to-r from-primary to-secondary flex-1"
                onClick={handleSaveSchedule}
              >
                Programmer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
