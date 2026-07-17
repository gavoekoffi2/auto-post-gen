// deno-lint-ignore-file no-explicit-any
//
// IP rate limiting for public (unauthenticated) edge functions. Backed by the
// hit_ip_rate_limit RPC (see migration). Fails OPEN on infrastructure error so
// a transient DB hiccup never takes down a public form.

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

export async function hitIpRateLimit(
  supabase: any,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("hit_ip_rate_limit", {
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error("hit_ip_rate_limit failed, allowing:", error.message);
      return true; // fail open
    }
    return data !== false;
  } catch (err) {
    console.error("hit_ip_rate_limit threw, allowing:", err instanceof Error ? err.message : String(err));
    return true; // fail open
  }
}
