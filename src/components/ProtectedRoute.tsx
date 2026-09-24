import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ApiError, profile as profileApi } from "@/lib/api";
import { useSession } from "@/lib/session";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiresProfile?: boolean;
}

/**
 * Gate for signed-in routes. Identity comes from the session cookie via
 * SessionProvider; this component only decides what to render.
 *
 * It is a convenience, not a security boundary: every API call re-checks the
 * session server-side, so bypassing this in the browser grants nothing.
 */
export const ProtectedRoute = ({ children, requiresProfile = true }: ProtectedRouteProps) => {
  const { user, loading: sessionLoading } = useSession();
  const [profileState, setProfileState] = useState<
    "unknown" | "complete" | "incomplete" | "signed_out" | "unavailable"
  >("unknown");
  const [attempt, setAttempt] = useState(0);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    if (sessionLoading || !user || !requiresProfile) return;

    setProfileState("unknown");
    (async () => {
      try {
        const profile = await profileApi.get();
        if (cancelled) return;
        const complete =
          !!profile.sector &&
          !!profile.tone &&
          Array.isArray(profile.content_types) &&
          profile.content_types.length > 0;
        setProfileState(complete ? "complete" : "incomplete");
      } catch (err) {
        if (cancelled) return;
        // A 401 here means the cookie expired between the session read and
        // this call; send them to /auth rather than to onboarding.
        // A failed read says nothing about the profile. Treating it as
        // "incomplete" sent a fully set-up account to the onboarding — where
        // saving overwrites the profile — whenever the API blinked (a 502
        // during a redeploy). And an expired session left a spinner forever.
        setProfileState(
          err instanceof ApiError && err.isUnauthenticated ? "signed_out" : "unavailable",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionLoading, user, requiresProfile, attempt]);

  const waitingOnProfile = requiresProfile && !!user && profileState === "unknown";

  if (sessionLoading || waitingOnProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Chargement...</div>
      </div>
    );
  }

  if (!user || profileState === "signed_out") {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (requiresProfile && profileState === "unavailable") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            Impossible de joindre le serveur pour le moment. Vérifiez votre connexion, puis réessayez.
          </p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Réessayer</Button>
        </div>
      </div>
    );
  }

  if (requiresProfile && profileState === "incomplete" && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
};
