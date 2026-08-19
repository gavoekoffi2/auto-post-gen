import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Last line of defence for the browser.
//
// Without a boundary, any exception thrown while rendering unmounts the whole
// React tree and leaves the user on a blank white page with no way back — no
// message, no reload, nothing in the UI to act on. Two cases make this a
// when-not-if problem in production:
//
//   1. A stale lazy chunk. Every route here is code-split; after a redeploy the
//      hashed chunk filenames change, so a tab left open overnight throws on the
//      next navigation ("Failed to fetch dynamically imported module"). The user
//      just needs a reload — but only if something tells them so.
//   2. An unexpected shape in API data reaching a render path.
//
// The chunk case gets a reload button (which fetches the new bundle); anything
// else offers a reload plus a way back to the dashboard.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on console so it is visible in the browser's own tooling; there is
    // no third-party error reporter wired into this project.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private isStaleChunk(): boolean {
    const message = this.state.error?.message ?? "";
    return /dynamically imported module|Importing a module script failed|ChunkLoadError/i
      .test(message);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const staleChunk = this.isStaleChunk();

    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass-card max-w-md w-full rounded-2xl border border-border/60 p-8 text-center">
          <h1 className="text-xl font-bold mb-3">
            {staleChunk ? "Une nouvelle version est disponible" : "Une erreur est survenue"}
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            {staleChunk
              ? "L'application a été mise à jour pendant que cet onglet était ouvert. Rechargez la page pour continuer."
              : "L'affichage de cette page a échoué. Rechargez la page ; si le problème persiste, contactez-nous."}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-gradient-to-r from-primary to-secondary px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
            >
              Recharger la page
            </button>
            {!staleChunk && (
              <button
                type="button"
                // Full navigation rather than a router push: the router tree is
                // the thing that just failed.
                onClick={() => { window.location.href = "/dashboard"; }}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium hover:bg-muted"
              >
                Retour au tableau de bord
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
