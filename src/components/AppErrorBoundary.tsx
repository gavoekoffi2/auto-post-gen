import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Without a boundary, any render error — or a lazily loaded page whose chunk
// no longer exists after a redeploy — unmounts the whole tree and leaves a
// blank page with no way out. This catches it, explains it in French, and
// recovers on its own from the most common case (a stale chunk).

const RELOAD_FLAG = "psa:chunk-reload";

/** A lazy import failed: the browser still runs the previous build's index. */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed/i.test(
    message,
  );
}

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
    return Date.now() - at < 60_000;
  } catch {
    // Storage blocked: never auto-reload, a loop would be worse than a button.
    return true;
  }
}

function markReload(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    /* ignored: reloadedRecently() already refused */
  }
}

type Props = { children: ReactNode; resetKey?: string };
type State = { error: unknown | null };

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Unhandled render error", error, info.componentStack);
    // A stale chunk is fixed by fetching the new index.html — once. If it
    // fails again within a minute, the fallback below is shown instead.
    if (isChunkLoadError(error) && !reloadedRecently()) {
      markReload();
      window.location.reload();
    }
  }

  componentDidUpdate(previous: Props) {
    // Navigating elsewhere gives the new page a fresh chance.
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isChunkLoadError(this.state.error);
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" />
          <h1 className="text-xl font-semibold">
            {stale ? "Une nouvelle version est disponible" : "Cette page a rencontré un problème"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {stale
              ? "L'application a été mise à jour pendant votre visite. Rechargez la page pour continuer."
              : "Une erreur inattendue a empêché l'affichage. Rechargez la page ; si le problème persiste, contactez-nous."}
          </p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Recharger la page
            </Button>
            <Button variant="outline" onClick={() => window.location.assign("/")}>
              Accueil
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

/** The boundary, reset whenever the route changes. Must sit inside the router. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}
