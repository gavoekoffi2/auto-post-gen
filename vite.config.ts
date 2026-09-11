import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    // In production nginx serves the SPA and proxies /api to the API
    // container, so every request the dashboard makes is same-origin. The dev
    // server has to reproduce that, or local development would need CORS and
    // cross-site cookies that the deployed app never uses — and the session
    // cookie, being SameSite, simply would not be sent.
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_API_ORIGIN ?? "http://127.0.0.1:8081",
        changeOrigin: false,
      },
    },
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
