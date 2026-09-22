import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { SUPPORT_EMAIL } from "@/lib/appConfig";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches any render error in the tree below it.
 *
 * Without one, React unmounts the whole application on the first uncaught
 * render error: the user gets a blank white page, no message, no way back, and
 * nothing is reported. That is the difference between "one screen misbehaved"
 * and "the product is broken" — and the most likely moment for it is exactly
 * when a first user hits data shaped in a way we did not anticipate.
 *
 * A chunk that fails to load is handled separately: after a deploy, a browser
 * holding the previous index.html asks for asset files that no longer exist.
 * Reloading fetches the current ones, so we say so rather than showing a
 * generic error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Goes to the browser console, which is where a support conversation
    // starts. Wire an error reporter here when you add one.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  private isStaleBundle(error: Error): boolean {
    const message = `${error.name}: ${error.message}`;
    return (
      /ChunkLoadError/i.test(message) ||
      /Loading chunk [\d]+ failed/i.test(message) ||
      /Failed to fetch dynamically imported module/i.test(message) ||
      /error loading dynamically imported module/i.test(message)
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = this.isStaleBundle(error);

    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center space-y-5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>

          <h1 className="text-2xl font-bold">
            {stale ? "Une nouvelle version est disponible" : "Une erreur est survenue"}
          </h1>

          <p className="text-muted-foreground">
            {stale
              ? "L'application a été mise à jour pendant votre visite. Rechargez la page pour continuer."
              : "Cette page n'a pas pu s'afficher. Vos données sont intactes — rien n'a été perdu."}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              className="bg-gradient-to-r from-primary to-secondary"
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Recharger la page
            </Button>
            {!stale && (
              <Button variant="outline" className="glass-card" onClick={() => { window.location.href = "/"; }}>
                Retour à l'accueil
              </Button>
            )}
          </div>

          {!stale && (
            <p className="text-xs text-muted-foreground">
              Si cela se reproduit, écrivez-nous à{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="underline hover:text-primary">
                {SUPPORT_EMAIL}
              </a>{" "}
              en précisant ce que vous faisiez.
            </p>
          )}

          <details className="text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Détail technique
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">
              {error.name}: {error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
