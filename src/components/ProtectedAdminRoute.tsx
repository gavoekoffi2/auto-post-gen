import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

export function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "allowed" | "denied" | "signed-out">("loading");
  const location = useLocation();

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      if (!session) {
        setState("signed-out");
        return;
      }
      const { data, error } = await supabase.functions.invoke("admin-api", { body: { action: "me" } });
      if (!active) return;
      const role = data?.user?.role;
      setState(!error && (role === "admin" || role === "super_admin") ? "allowed" : "denied");
    })();
    return () => { active = false; };
  }, []);

  if (state === "loading") {
    return <div className="min-h-screen grid place-items-center text-muted-foreground animate-pulse">Ouverture du centre de contrôle…</div>;
  }
  if (state === "signed-out") return <Navigate to="/auth" state={{ from: location }} replace />;
  if (state === "denied") return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
