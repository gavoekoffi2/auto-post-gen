import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { auth, type SessionUser } from "@/lib/api";

// The session used to be a token object the browser held in localStorage.
// It is now an HttpOnly cookie the browser cannot read, so "who am I" is a
// question only the server can answer: this context asks once on mount and
// shares the answer, instead of every route issuing its own /auth/me call.
//
// Nothing here is authority. A component may render an admin control because
// this context says the user is an admin, but the server re-checks the session
// on every request — the UI state is a convenience, never a permission.

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
  /** Re-reads the session from the server (after login, logout, role change). */
  refresh: () => Promise<SessionUser | null>;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signUp: (email: string, password: string, requestedPlan?: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const current = await auth.me();
    setUser(current);
    return current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await auth.me();
        if (!cancelled) setUser(current);
      } catch {
        // A network failure is not a signed-out state; treat it as unknown and
        // let the guarded routes surface the error on their own calls.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user: signedIn } = await auth.login(email, password);
    setUser(signedIn);
    return signedIn;
  }, []);

  const signUp = useCallback(async (email: string, password: string, requestedPlan?: string) => {
    const { user: created } = await auth.register(email, password, requestedPlan);
    setUser(created);
    return created;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // Clear locally even if the call failed: the cookie may already be gone,
      // and leaving a stale user on screen is worse than an extra login.
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionState>(
    () => ({ user, loading, refresh, signIn, signUp, signOut }),
    [user, loading, refresh, signIn, signUp, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside a SessionProvider");
  return ctx;
}
