import { Star, Quote } from "lucide-react";

const testimonials = [
  {
    name: "Marie Dubois",
    role: "Fondatrice, BeautyTech",
    avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop&crop=face",
    content: "Pro Social AI a transformé ma façon de gérer mes réseaux. Je gagne plus de 15h par semaine que je peux consacrer à mon business. L'IA génère du contenu qui reflète parfaitement ma marque.",
    rating: 5
  },
  {
    name: "Thomas Martin",
    role: "CMO, GrowthStartup",
    avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=face",
    content: "L'automatisation est impressionnante. On valide par email et le contenu est publié automatiquement. Notre engagement a augmenté de 300% en 3 mois.",
    rating: 5
  },
  {
    name: "Sophie Chen",
    role: "Influenceuse lifestyle",
    avatar: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop&crop=face",
    content: "Je collabore avec plusieurs marques et Pro Social AI me permet de gérer tous mes comptes sans effort. Le gain de temps est incroyable !",
    rating: 5
  },
  {
    name: "Alexandre Petit",
    role: "CEO, AgenceDigitale",
    avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=face",
    content: "On utilise Pro Social AI pour tous nos clients. La qualité du contenu généré et l'automatisation nous ont permis de scaler notre activité x3.",
    rating: 5
  }
];

export const TestimonialsNew = () => {
  return (
    <section className="py-24 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 mesh-gradient opacity-30" />
      
      <div className="container mx-auto max-w-7xl px-4 relative z-10">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-6 rounded-full glass-card">
            <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
            <span className="text-sm font-medium">Témoignages clients</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Ce qu'ils disent </span>
            <span className="gradient-text">de nous</span>
          </h2>
          
          <p className="text-lg text-muted-foreground">
            Rejoignez des milliers de créateurs et entreprises qui ont transformé 
            leur présence sur les réseaux sociaux.
          </p>
        </div>
        
        {/* Testimonials grid */}
        <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          {testimonials.map((testimonial, index) => (
            <div
              key={index}
              className="p-8 rounded-3xl glass-card-strong hover-lift opacity-0 animate-fade-in-up"
              style={{ animationDelay: `${index * 0.1}s`, animationFillMode: 'forwards' }}
            >
              {/* Quote icon */}
              <Quote className="w-10 h-10 text-primary/20 mb-4" />
              
              {/* Rating */}
              <div className="flex gap-1 mb-4">
                {Array.from({ length: testimonial.rating }).map((_, i) => (
                  <Star key={i} className="w-5 h-5 text-amber-400 fill-amber-400" />
                ))}
              </div>
              
              {/* Content */}
              <p className="text-foreground text-lg leading-relaxed mb-6">
                "{testimonial.content}"
              </p>
              
              {/* Author */}
              <div className="flex items-center gap-4">
                <img
                  src={testimonial.avatar}
                  alt={testimonial.name}
                  className="w-14 h-14 rounded-full object-cover ring-2 ring-primary/20"
                />
                <div>
                  <h4 className="font-semibold text-foreground">{testimonial.name}</h4>
                  <p className="text-sm text-muted-foreground">{testimonial.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {/* Stats */}
        <div className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-8 max-w-4xl mx-auto">
          {[
            { value: "10K+", label: "Utilisateurs actifs" },
            { value: "500K+", label: "Posts publiés" },
            { value: "98%", label: "Satisfaction client" },
            { value: "24/7", label: "Support disponible" }
          ].map((stat, index) => (
            <div 
              key={index} 
              className="text-center p-6 rounded-2xl glass-card opacity-0 animate-fade-in-up"
              style={{ animationDelay: `${0.5 + index * 0.1}s`, animationFillMode: 'forwards' }}
            >
              <div className="text-4xl font-bold gradient-text mb-2">{stat.value}</div>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
