// Build the list of Graphiste GPT job-status URLs we are allowed to poll.
//
// SECURITY — this is the single chokepoint for a credential-exfiltration bug.
// Every status poll is sent with `Authorization: Bearer GRAPHISTE_GPT_API_KEY`,
// and the `statusUrl` we poll used to be taken verbatim from two places an
// ordinary user controls:
//
//   1. the `statusUrl` field of a generate-image request body;
//   2. `posts.image_status_url`, a column the browser could write on its own
//      row and that publish-post resumes from the cron path.
//
// Pointing either at `https://attacker.example/` made a service-role function
// hand the poster API key to an arbitrary host (and doubled as an SSRF probe
// into the private network). We now accept a caller-supplied status URL ONLY
// when it is https and resolves to the same origin as the configured Graphiste
// endpoint; anything else is dropped and we fall back to the job-id routes we
// build ourselves.

const GRAPHISTE_GPT_DEFAULT_URL =
  "https://bbfzfgcdioewzbmlgaqy.supabase.co/functions/v1/api-v1/v1/posters/generate";

export function getGraphisteEndpoint(): string {
  return Deno.env.get("GRAPHISTE_GPT_API_URL") || GRAPHISTE_GPT_DEFAULT_URL;
}

// Exported for tests: true when `statusUrl` is safe to poll with our API key.
export function isAllowedStatusUrl(statusUrl: string, endpoint: string): boolean {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return false;
  }
  let candidate: URL;
  try {
    // Relative status URLs resolve against the configured endpoint, so they are
    // same-origin by construction; absolute ones must match it explicitly.
    candidate = new URL(statusUrl, base);
  } catch {
    return false;
  }
  if (candidate.protocol !== "https:") return false;
  return candidate.origin === base.origin;
}

// Ordered list of URLs to poll for a poster job. Canonical job-id routes first
// (they are built from our own configured endpoint, so they are always safe),
// then the provider-supplied status URL when it passes the origin check.
export function posterStatusCandidates(
  statusUrl: string | null,
  jobId: string | null,
  endpoint: string = getGraphisteEndpoint(),
): string[] {
  const out: string[] = [];
  if (jobId) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      return [];
    }
    const base = `${u.origin}${u.pathname.replace(/\/generate\/?$/, "")}`;
    // Canonical API route first. Older Graphiste responses sometimes emitted an
    // internal http:// URL without /functions/v1; it must not delay polling.
    out.push(`${base}/${encodeURIComponent(jobId)}`);
    out.push(`${base}/status/${encodeURIComponent(jobId)}`);
    out.push(`${base}/jobs/${encodeURIComponent(jobId)}`);
    out.push(`${u.origin}/functions/v1/api-v1/v1/jobs/${encodeURIComponent(jobId)}`);
  }
  if (statusUrl && isAllowedStatusUrl(statusUrl, endpoint)) {
    out.push(new URL(statusUrl, endpoint).toString());
  } else if (statusUrl) {
    console.error("Refusing to poll off-origin Graphiste status URL");
  }
  return [...new Set(out)];
}
