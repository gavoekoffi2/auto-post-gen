import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Shown instead of the default panel, e.g. for a smaller embedded area. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors below it.
 *
 * Without a boundary React unmounts the entire tree on any thrown render
 * error, leaving a blank white page — no message, no navigation, and no way
 * back except a manual reload. That is the worst possible failure mode for an
 * app users leave open on a dashboard.
 *
 * Reset clears the error and re-renders; "Reload" is the escape hatch when the
 * failure is in state the boundary cannot repair.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep this in the browser console: it is the only trace a user can send
    // back, since there is no error-reporting backend wired up.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="glass-card max-w-lg w-full rounded-2xl border border-border/60 p-8 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/15">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h1 className="mb-2 text-2xl font-bold">Une erreur inattendue est survenue</h1>
          <p className="mb-6 text-muted-foreground">
            L'affichage de cette page a échoué. Vos données ne sont pas perdues&nbsp;: vous
            pouvez réessayer, ou recharger l'application.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button onClick={this.reset} className="bg-gradient-to-r from-primary to-secondary">
              <RefreshCw className="mr-2 h-4 w-4" />
              Réessayer
            </Button>
            <Button variant="outline" onClick={() => window.location.assign("/dashboard")}>
              Retour au tableau de bord
            </Button>
          </div>
          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Détail technique
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs">
              {error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
