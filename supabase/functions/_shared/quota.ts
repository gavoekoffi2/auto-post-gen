// deno-lint-ignore-file no-explicit-any
//
// Per-user quota helper on top of the consume_generation_quota RPC (atomic:
// it takes an advisory lock, counts inside the window and inserts the usage row
// in one transaction, so parallel requests cannot all pass the same count).
//
// generate-content and generate-image each hand-rolled this call. The other
// authenticated endpoints had NO per-user limit at all, even though several of
// them spend money on every request (comment-reply drafts with the LLM,
// sync-comments drafts one reply per new comment) or are simply expensive to
// serve (admin-api's overview scans four tables).

export interface QuotaCheck {
  allowed: boolean;
  /** true when the RPC itself was unavailable and we degraded to allowing. */
  degraded: boolean;
}

export async function consumeQuota(
  supabase: any,
  userId: string,
  functionName: string,
  max: number,
  windowSeconds = 3600,
): Promise<QuotaCheck> {
  try {
    const { data, error } = await supabase.rpc("consume_generation_quota", {
      p_user: userId,
      p_function: functionName,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      // The RPC is missing (migration not yet applied) or the DB hiccuped.
      // Fail OPEN so a quota outage cannot take the product down, but say so
      // loudly — a permanently degraded quota is a billing risk.
      console.error(`consume_generation_quota(${functionName}) failed, allowing:`, error.message);
      return { allowed: true, degraded: true };
    }
    return { allowed: data !== false, degraded: false };
  } catch (err) {
    console.error(
      `consume_generation_quota(${functionName}) threw, allowing:`,
      err instanceof Error ? err.message : String(err),
    );
    return { allowed: true, degraded: true };
  }
}
