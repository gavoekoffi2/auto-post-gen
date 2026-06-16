import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Mail, MessageSquare, Send } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const SUPPORT_EMAIL = "contact@prosocialai.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Contact() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    subject: "",
    message: "",
    company: "", // honeypot — must stay empty
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.email || !formData.message) {
      toast.error("Veuillez remplir tous les champs obligatoires");
      return;
    }
    if (!EMAIL_RE.test(formData.email)) {
      toast.error("Veuillez saisir une adresse email valide");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-contact", {
        body: formData,
      });
      // supabase.functions.invoke throws on non-2xx; data.error covers the
      // "configured but rejected" case.
      if (error || (data && data.error)) {
        const code = (data && data.code) || "";
        if (code === "not_configured") {
          toast.error(`Messagerie indisponible. Écrivez-nous à ${SUPPORT_EMAIL}.`);
        } else {
          toast.error((data && data.error) || "Échec de l'envoi. Réessayez plus tard.");
        }
        return;
      }

      toast.success("Message envoyé avec succès ! Nous vous répondrons rapidement.");
      setFormData({ name: "", email: "", subject: "", message: "", company: "" });
    } catch (_err) {
      toast.error(`Échec de l'envoi. Écrivez-nous directement à ${SUPPORT_EMAIL}.`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="glass-card border-b border-border/50 sticky top-0 z-40">
        <div className="container mx-auto max-w-7xl px-4 py-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Button>
            <h1 className="text-xl font-bold">Contact</h1>
          </div>
        </div>
      </header>

      <div className="container mx-auto max-w-4xl px-4 py-12">
        <div className="grid md:grid-cols-2 gap-8">
          {/* Contact Info */}
          <div className="space-y-6">
            <div>
              <h2 className="text-3xl font-bold mb-4">Contactez-nous</h2>
              <p className="text-muted-foreground">
                Vous avez des questions sur Pro Social AI ? Notre équipe est là pour vous aider.
              </p>
            </div>

            <Card className="glass-card p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-r from-primary to-secondary rounded-lg flex items-center justify-center">
                  <Mail className="w-6 h-6 text-primary-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold">Email</h3>
                  <p className="text-sm text-muted-foreground">contact@prosocialai.com</p>
                </div>
              </div>
            </Card>

            <Card className="glass-card p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-gradient-to-r from-secondary to-accent rounded-lg flex items-center justify-center">
                  <MessageSquare className="w-6 h-6 text-primary-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold">Support</h3>
                  <p className="text-sm text-muted-foreground">Réponse sous 24h</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Contact Form */}
          <Card className="glass-card p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Honeypot: hidden from humans, catches naive bots. */}
              <input
                type="text"
                name="company"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={formData.company}
                onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
              />
              <div>
                <Label htmlFor="name">Nom *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="glass-card mt-1"
                  placeholder="Votre nom"
                />
              </div>

              <div>
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="glass-card mt-1"
                  placeholder="votre@email.com"
                />
              </div>

              <div>
                <Label htmlFor="subject">Sujet</Label>
                <Input
                  id="subject"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="glass-card mt-1"
                  placeholder="Objet de votre message"
                />
              </div>

              <div>
                <Label htmlFor="message">Message *</Label>
                <Textarea
                  id="message"
                  value={formData.message}
                  onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                  className="glass-card mt-1 min-h-[120px]"
                  placeholder="Votre message..."
                />
              </div>

              <Button 
                type="submit" 
                className="w-full bg-gradient-to-r from-primary to-secondary"
                disabled={loading}
              >
                {loading ? (
                  "Envoi en cours..."
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Envoyer
                  </>
                )}
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
