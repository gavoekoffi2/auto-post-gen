import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { admin } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * Gate for the admin control plane.
 *
 * The role is asked of the SERVER (`GET /api/admin/me`) rather than read from
 * anything the browser holds: the session cookie is opaque to the client, and
 * the admin routes re-authorise every request anyway. Rendering the page
 * without the role grants nothing — this only avoids showing a shell that
 * would fail on every call.
 */
export function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const [state, setState] = useState<"loading" | "allowed" | "denied">("loading");
  const location = useLocation();

  useEffect(() => {
    let active = true;
    if (loading) return;
    if (!user) {
      setState("denied");
      return;
    }
    (async () => {
      try {
        const { user: me } = await admin.me();
        if (!active) return;
        setState(me.role === "admin" || me.role === "super_admin" ? "allowed" : "denied");
      } catch {
        if (active) setState("denied");
      }
    })();
    return () => {
      active = false;
    };
  }, [loading, user]);

  if (loading || state === "loading") {
    return (
      <div className="min-h-screen grid place-items-center text-muted-foreground animate-pulse">
        Ouverture du centre de contrôle…
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" state={{ from: location }} replace />;
  if (state === "denied") return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
