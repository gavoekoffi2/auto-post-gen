// Pure, dependency-free parsers for Graphiste GPT API responses.
// No Deno globals here, so this module is unit-testable from Node (the test
// suite imports it directly via type-stripping).
//
// Canonical v1.1 response envelope (POST /v1/posters/generate and
// GET /v1/posters/{job_id}), per the published OpenAPI spec:
//
//   { success: true,
//     data: { job_id, status, image_url, status_url, ... },
//     warnings: [...],
//     request_id: "<trace id>" }       ← TOP-LEVEL trace id, NOT the job id
//
// The job id lives at data.job_id. The top-level request_id is only an API
// request trace identifier — feeding it to GET /v1/posters/{id} 404s. Earlier
// versions of the extractor accepted request_id as a job-id candidate, so it
// would grab the trace id (checked before recursing into `data`) and persist a
// useless id; resuming that job later always failed. The getters below never
// treat request_id as a job id.

// Walk a response object, applying `getter` at each level. The top level is
// tried first, then the common nested containers. Used to pull a single scalar
// (job id, status url) out of an envelope whose exact nesting varies.
export function extractFromNested(
  value: unknown,
  getter: (o: Record<string, unknown>) => unknown,
): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = getter(obj);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // Some APIs return a numeric job id; keep it rather than dropping the job.
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  for (const key of ["data", "result", "job", "request", "generation"]) {
    const nested = extractFromNested(obj[key], getter);
    if (nested) return nested;
  }
  return null;
}

// The canonical field is data.job_id. We accept a few well-known aliases for
// resilience, but deliberately NOT request_id / requestId (that is the trace
// id, never a pollable job id for this API).
export function extractJobId(value: unknown): string | null {
  return extractFromNested(value, (o) =>
    o.job_id || o.jobId || o.task_id || o.taskId || o.id);
}

export function extractStatusUrl(value: unknown): string | null {
  return extractFromNested(value, (o) =>
    o.statusUrl || o.status_url || o.pollUrl || o.poll_url || o.checkUrl || o.check_url);
}

// A job is terminal-failed when its status says so. "processing" is NOT failed.
export function jobFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // Graphiste error envelopes (including JOB_TIMEOUT) are terminal even when
  // they do not carry a nested `status` field.
  if (obj.success === false && obj.error) return true;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (["failed", "error", "canceled", "cancelled"].includes(status)) return true;
  for (const key of ["data", "result", "job"]) {
    if (jobFailed(obj[key])) return true;
  }
  return false;
}
