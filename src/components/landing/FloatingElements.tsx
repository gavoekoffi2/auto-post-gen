import { Instagram, Facebook, Linkedin, Twitter, Youtube, MessageCircle } from "lucide-react";

export const FloatingElements = () => {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Gradient orbs */}
      <div className="absolute top-20 left-10 w-72 h-72 bg-primary/20 rounded-full blur-3xl animate-float-slow opacity-60" />
      <div className="absolute top-40 right-20 w-96 h-96 bg-accent/15 rounded-full blur-3xl animate-float opacity-50" />
      <div className="absolute bottom-20 left-1/4 w-80 h-80 bg-primary/10 rounded-full blur-3xl animate-float-rotate opacity-40" />
      
      {/* Floating social icons */}
      <div className="absolute top-32 right-[15%] animate-float-slow" style={{ animationDelay: '0s' }}>
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center shadow-xl shadow-pink-500/30 rotate-12">
          <Instagram className="w-7 h-7 text-white" />
        </div>
      </div>
      
      <div className="absolute top-48 left-[12%] animate-float" style={{ animationDelay: '0.5s' }}>
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shadow-xl shadow-blue-600/30 -rotate-6">
          <Facebook className="w-6 h-6 text-white" />
        </div>
      </div>
      
      <div className="absolute top-64 right-[25%] animate-float-rotate" style={{ animationDelay: '1s' }}>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-400 to-sky-500 flex items-center justify-center shadow-xl shadow-sky-500/30 rotate-6">
          <Twitter className="w-5 h-5 text-white" />
        </div>
      </div>
      
      <div className="absolute bottom-40 right-[10%] animate-float-slow" style={{ animationDelay: '1.5s' }}>
        <div className="w-13 h-13 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-xl shadow-blue-500/30 -rotate-12">
          <Linkedin className="w-6 h-6 text-white" />
        </div>
      </div>
      
      <div className="absolute bottom-60 left-[8%] animate-float" style={{ animationDelay: '2s' }}>
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center shadow-xl shadow-red-500/30 rotate-12">
          <Youtube className="w-6 h-6 text-white" />
        </div>
      </div>
      
      <div className="absolute top-80 left-[20%] animate-float-rotate" style={{ animationDelay: '2.5s' }}>
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-green-400 to-green-500 flex items-center justify-center shadow-xl shadow-green-500/30 -rotate-6">
          <MessageCircle className="w-5 h-5 text-white" />
        </div>
      </div>
      
      {/* Decorative shapes */}
      <div className="absolute top-1/4 right-[5%] w-4 h-4 bg-primary/40 rounded-full animate-bounce-subtle" style={{ animationDelay: '0.3s' }} />
      <div className="absolute top-1/3 left-[5%] w-3 h-3 bg-accent/50 rounded-full animate-bounce-subtle" style={{ animationDelay: '0.6s' }} />
      <div className="absolute bottom-1/4 right-[20%] w-5 h-5 bg-primary/30 rounded-full animate-bounce-subtle" style={{ animationDelay: '0.9s' }} />
      <div className="absolute bottom-1/3 left-[15%] w-4 h-4 bg-accent/40 rounded-full animate-bounce-subtle" style={{ animationDelay: '1.2s' }} />
      
      {/* Geometric decorations */}
      <svg className="absolute top-40 right-[30%] w-16 h-16 text-primary/10 animate-spin-slow" viewBox="0 0 100 100">
        <polygon points="50,5 95,27.5 95,72.5 50,95 5,72.5 5,27.5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      
      <svg className="absolute bottom-32 left-[30%] w-12 h-12 text-accent/15 animate-spin-slow" style={{ animationDirection: 'reverse' }} viewBox="0 0 100 100">
        <rect x="20" y="20" width="60" height="60" rx="10" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(45 50 50)" />
      </svg>
    </div>
  );
};
