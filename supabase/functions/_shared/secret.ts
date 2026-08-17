// Constant-time comparison for shared secrets (CRON_SECRET and friends).
//
// `provided === expected` short-circuits on the first differing byte, so the
// time it takes to reject leaks how long a common prefix was. That is enough
// to recover a secret byte-by-byte from a public endpoint — and every
// cron-only function here is public (verify_jwt = false), with the secret as
// the ONLY thing standing between the internet and a service-role runtime.
//
// Pure (no Deno globals) so the test suite can import it directly from Node.

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Length is not secret (it is visible from the response timing of the loop
  // itself), but the CONTENT comparison must not short-circuit.
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

// True only when a shared secret is configured AND the caller presented it.
// Fails CLOSED: an unset/empty expected secret never authorises anything.
export function matchesSharedSecret(
  expected: string | undefined | null,
  provided: string | undefined | null,
): boolean {
  if (!expected || !provided) return false;
  return timingSafeEqual(expected, provided);
}
