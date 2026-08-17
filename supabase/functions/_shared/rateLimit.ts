// deno-lint-ignore-file no-explicit-any
//
// IP rate limiting for public (unauthenticated) edge functions. Backed by the
// hit_ip_rate_limit RPC (see migration). Fails OPEN on infrastructure error so
// a transient DB hiccup never takes down a public form.

// x-real-ip is set by the Supabase edge gateway and cannot be forged by the
// caller. x-forwarded-for is a client-supplied list the gateway appends to, so
// its FIRST entry is whatever the caller claimed — reading that first let
// anyone rotate the rate-limit bucket at will by varying the header. Prefer
// x-real-ip, and fall back to the LAST x-forwarded-for hop (the one the
// nearest trusted proxy wrote).
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return "unknown";
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
