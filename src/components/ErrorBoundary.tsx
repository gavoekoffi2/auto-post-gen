import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes anywhere below it so a single bad component —
 * or a lazy chunk that fails to download after a redeploy — shows a readable
 * recovery screen instead of a blank white page with no way out.
 *
 * A chunk-load failure is treated specially: it almost always means the user
 * is holding a stale index.html whose hashed chunks no longer exist, and a
 * reload fixes it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private isStaleChunkError(error: Error): boolean {
    const message = `${error.name} ${error.message}`;
    return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
      message,
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const staleChunk = this.isStaleChunkError(error);

    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl border border-border/60 bg-card p-8 text-center shadow-lg">
          <h1 className="text-xl font-bold mb-3">
            {staleChunk
              ? "Une mise à jour est disponible"
              : "Une erreur inattendue est survenue"}
          </h1>
          <p className="text-muted-foreground mb-6 text-sm">
            {staleChunk
              ? "L'application a été mise à jour pendant votre visite. Rechargez la page pour continuer."
              : "Nous n'avons pas pu afficher cette page. Rechargez la page ; si le problème persiste, contactez-nous."}
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full rounded-lg bg-gradient-to-r from-primary to-secondary px-4 py-2 font-medium text-white hover:opacity-90 transition-opacity"
            >
              Recharger la page
            </button>
            <a
              href="/"
              className="w-full rounded-lg border border-border/60 px-4 py-2 text-sm hover:bg-muted/50 transition-colors"
            >
              Retour à l'accueil
            </a>
          </div>
          {import.meta.env.DEV && (
            <pre className="mt-6 max-h-48 overflow-auto rounded-lg bg-muted/50 p-3 text-left text-xs text-muted-foreground">
              {error.stack || error.message}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
