import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiresProfile?: boolean;
}

export const ProtectedRoute = ({ children, requiresProfile = true }: ProtectedRouteProps) => {
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [hasProfile, setHasProfile] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (cancelled) return;
        if (!session) {
          setIsAuthenticated(false);
          setLoading(false);
          return;
        }

        setIsAuthenticated(true);

        if (requiresProfile) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('sector, tone, content_types')
            .eq('id', session.user.id)
            .maybeSingle();

          if (cancelled) return;
          const isProfileComplete =
            !!profile &&
            !!profile.sector &&
            !!profile.tone &&
            Array.isArray(profile.content_types) &&
            profile.content_types.length > 0;
          setHasProfile(isProfileComplete);
        } else {
          setHasProfile(true);
        }
      } catch (error) {
        console.error('Auth check error:', error);
        if (!cancelled) setIsAuthenticated(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setIsAuthenticated(false);
        setHasProfile(false);
      } else if (event === 'SIGNED_IN' && session) {
        setIsAuthenticated(true);
        // Re-check profile only on an actual sign-in. We deliberately
        // ignore TOKEN_REFRESHED / USER_UPDATED (fired by autoRefresh and
        // password changes) to avoid redundant profile checks and the
        // redirect churn they cause.
        checkAuth();
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [requiresProfile]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Chargement...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (requiresProfile && !hasProfile && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
};
