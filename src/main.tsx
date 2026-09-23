import { createRoot } from "react-dom/client";
import "./index.css";

/**
 * Boot the app, and show something legible if it cannot boot at all.
 *
 * The React ErrorBoundary covers render errors, but it can only run once React
 * is mounted. A configuration error throws EARLIER than that: the Supabase
 * client validates VITE_SUPABASE_* at module scope, so a build made without
 * those variables fails while the import graph is still evaluating. The result
 * was a blank white page whose only explanation sat in the browser console —
 * the worst possible outcome for a misconfigured deploy, because nothing on
 * screen says what is wrong or who to tell.
 *
 * The import is dynamic so that this file's own module evaluation cannot be
 * what fails.
 */
async function boot() {
  const container = document.getElementById("root");
  if (!container) throw new Error('No #root element in the document');

  try {
    const { default: App } = await import("./App.tsx");
    createRoot(container).render(<App />);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Application failed to start:", error);
    container.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;
                  background:#f8fafc;text-align:center">
        <div style="max-width:480px">
          <div style="font-size:40px;line-height:1">⚠️</div>
          <h1 style="font-size:22px;margin:16px 0 8px">L'application n'a pas pu démarrer</h1>
          <p style="color:#475569;margin:0 0 16px">
            Il s'agit d'un problème de configuration du site, pas de votre navigateur.
            Si vous êtes un visiteur, réessayez plus tard.
          </p>
          <pre style="text-align:left;background:#e2e8f0;padding:12px;border-radius:8px;
                      font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0"></pre>
        </div>
      </div>`;
    const pre = container.querySelector("pre");
    if (pre) pre.textContent = detail; // textContent, never innerHTML
  }
}

void boot();
