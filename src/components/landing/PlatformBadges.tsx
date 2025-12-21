import { Instagram, Facebook, Linkedin, Twitter, Youtube, MessageCircle } from "lucide-react";

const platforms = [
  { name: "Instagram", icon: Instagram, gradient: "from-pink-500 via-rose-500 to-purple-500", delay: "0s" },
  { name: "Facebook", icon: Facebook, gradient: "from-blue-600 to-blue-700", delay: "0.1s" },
  { name: "LinkedIn", icon: Linkedin, gradient: "from-blue-500 to-blue-600", delay: "0.2s" },
  { name: "Twitter", icon: Twitter, gradient: "from-sky-400 to-sky-500", delay: "0.3s" },
  { name: "YouTube", icon: Youtube, gradient: "from-red-500 to-red-600", delay: "0.4s" },
  { name: "TikTok", icon: MessageCircle, gradient: "from-gray-900 via-pink-500 to-cyan-400", delay: "0.5s" },
];

export const PlatformBadges = () => {
  return (
    <div className="flex flex-wrap justify-center gap-3 mt-8">
      {platforms.map((platform, index) => (
        <div
          key={platform.name}
          className="flex items-center gap-2 px-4 py-2 rounded-full glass-card hover-lift cursor-default opacity-0 animate-fade-in"
          style={{ animationDelay: platform.delay, animationFillMode: 'forwards' }}
        >
          <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${platform.gradient} flex items-center justify-center`}>
            <platform.icon className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-medium text-foreground">{platform.name}</span>
        </div>
      ))}
    </div>
  );
};
