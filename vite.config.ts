import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    // `host: true` listens on every available interface. The previous "::"
    // hard-coded IPv6, so `npm run dev` died with EAFNOSUPPORT on any machine
    // or container without it — a new contributor could not start the project
    // at all, and the error names a socket family rather than the cause.
    host: true,
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom") || id.includes("node_modules/react-router-dom")) {
            return "react";
          }
          if (id.includes("node_modules/@supabase/supabase-js")) {
            return "supabase";
          }
          if (id.includes("node_modules/recharts")) {
            return "charts";
          }
          if (id.includes("node_modules/@radix-ui/")) {
            return "radix";
          }
        },
      },
    },
  },
}));
