// supabase.functions.invoke() returns `data: null` and a generic
// "Edge Function returned a non-2xx status code" error for any 4xx/5xx, so the
// server's own JSON body ({ error, code }) is only reachable through the raw
// Response kept on error.context. These helpers read it back.

export interface FunctionErrorPayload {
  error?: string;
  code?: string;
}

export async function functionErrorPayload(error: unknown): Promise<FunctionErrorPayload | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    const payload = await context.clone().json();
    return payload && typeof payload === "object" ? (payload as FunctionErrorPayload) : null;
  } catch {
    // Not a JSON body.
    return null;
  }
}

export async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const payload = await functionErrorPayload(error);
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  return (error as { message?: string } | null)?.message || fallback;
}
