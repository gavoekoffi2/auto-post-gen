import { CheckCircle2, Sparkles } from "lucide-react";

// This section used to present four invented customers — made-up names and
// roles, stock-photo faces, quoted engagement results — above a stat row of
// invented user, volume and satisfaction figures. The product is opening to
// its FIRST users, so none of that was true, and it is exactly the kind of
// claim a first customer checks. It is replaced by statements describing what
// the platform actually does today; put real testimonials back here once real
// customers have given them, with their consent.

const capabilities = [
  {
    title: "Des posts écrits pour votre métier",
    body:
      "Vous décrivez votre activité et vos cibles pendant l'onboarding. Chaque publication est ensuite rédigée en français à partir de ce profil, avec un angle imposé différent à chaque fois pour éviter les textes qui se ressemblent.",
  },
  {
    title: "Ancrés dans l'actualité de votre secteur",
    body:
      "Avant d'écrire, la plateforme interroge des sources web gratuites (Google News, Wikipédia, DuckDuckGo) et ne garde que ce qui concerne réellement votre activité. Aucun abonnement de recherche n'est nécessaire.",
  },
  {
    title: "Une affiche au bon format",
    body:
      "Chaque post reçoit un visuel généré au format natif du réseau visé — carré, portrait ou vertical — avec vos couleurs, votre logo et votre message permanent.",
  },
  {
    title: "Vous gardez la main",
    body:
      "Rien ne part sans votre validation. Vous relisez, modifiez, régénérez le texte ou l'affiche, choisissez la date, puis publiez — manuellement ou automatiquement à l'heure prévue.",
  },
];

const facts = [
  { value: "4", label: "Réseaux publiables aujourd'hui" },
  { value: "100%", label: "Contenu rédigé en français" },
  { value: "2K", label: "Résolution des affiches générées" },
  { value: "0", label: "Post publié sans votre validation" },
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
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Ce que fait la plateforme</span>
          </div>

          <h2 className="text-4xl sm:text-5xl font-bold mb-6">
            <span className="text-foreground">Concrètement, </span>
            <span className="gradient-text">voici ce que vous obtenez</span>
          </h2>

          <p className="text-lg text-muted-foreground">
            Pro Social AI ouvre à ses premiers utilisateurs. Plutôt que des
            témoignages, voici précisément ce que la plateforme fait aujourd'hui.
          </p>
        </div>

        {/* Capabilities grid */}
        <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          {capabilities.map((capability, index) => (
            <div
              key={capability.title}
              className="p-8 rounded-3xl glass-card-strong hover-lift opacity-0 animate-fade-in-up"
              style={{ animationDelay: `${index * 0.1}s`, animationFillMode: "forwards" }}
            >
              <CheckCircle2 className="w-10 h-10 text-primary/40 mb-4" />
              <h3 className="text-xl font-semibold text-foreground mb-3">
                {capability.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">{capability.body}</p>
            </div>
          ))}
        </div>

        {/* Product facts (verifiable, not usage claims) */}
        <div className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-8 max-w-4xl mx-auto">
          {facts.map((fact, index) => (
            <div
              key={fact.label}
              className="text-center p-6 rounded-2xl glass-card opacity-0 animate-fade-in-up"
              style={{ animationDelay: `${0.5 + index * 0.1}s`, animationFillMode: "forwards" }}
            >
              <div className="text-4xl font-bold gradient-text mb-2">{fact.value}</div>
              <p className="text-sm text-muted-foreground">{fact.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
