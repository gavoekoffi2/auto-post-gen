// supabase.functions.invoke() rejects with a generic
// "Edge Function returned a non-2xx status code" message and hides the JSON
// body the function actually returned. Every user-facing error from an edge
// function must go through this helper, otherwise first users only ever see
// that meaningless sentence instead of the actionable reason (missing key,
// quota reached, network not connected…).
export async function functionErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  const functionError = error as { context?: Response; message?: string } | null;
  if (functionError?.context && typeof functionError.context.clone === "function") {
    try {
      const payload = await functionError.context.clone().json();
      if (typeof payload?.error === "string" && payload.error.trim()) {
        return payload.error.trim();
      }
    } catch {
      // Not JSON (HTML error page, empty body…) — keep the SDK message.
    }
  }
  const message = functionError?.message?.trim();
  return message || fallback;
}
