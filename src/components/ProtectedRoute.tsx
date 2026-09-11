import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
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
  const [profileState, setProfileState] = useState<"unknown" | "complete" | "incomplete">(
    "unknown",
  );
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    if (sessionLoading || !user || !requiresProfile) return;

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
        setProfileState(
          err instanceof ApiError && err.isUnauthenticated ? "unknown" : "incomplete",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionLoading, user, requiresProfile]);

  const waitingOnProfile = requiresProfile && !!user && profileState === "unknown";

  if (sessionLoading || waitingOnProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Chargement...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (requiresProfile && profileState === "incomplete" && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
};
