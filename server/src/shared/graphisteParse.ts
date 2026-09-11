// Parsers for Graphiste GPT's response envelopes.
//
// Pure and dependency-free, so they can be exercised directly. That matters:
// every one of these encodes a distinction that is invisible until it is
// wrong in production — a trace id mistaken for a job id, a placeholder
// mistaken for a finished render, a still-running job mistaken for a failure.

/**
 * Walks an envelope, applying `getter` at each level: the top level first,
 * then the common nested containers. The exact nesting varies between the
 * provider's accepted, status and completed responses.
 */
function extractFromNested(
  value: unknown,
  getter: (o: Record<string, unknown>) => unknown,
): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = getter(obj);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // Some responses carry a numeric job id; keep it rather than dropping the
  // job and leaving the user with a spinner nothing will ever resolve.
  if (typeof direct === "number" && Number.isFinite(direct)) return String(direct);
  for (const key of ["data", "result", "job", "request", "generation"]) {
    const nested = extractFromNested(obj[key], getter);
    if (nested) return nested;
  }
  return null;
}

/**
 * The canonical field is data.job_id.
 *
 * request_id is deliberately NOT accepted: it is an API trace id, and
 * GET /v1/posters/{request_id} 404s. Taking it for the job id is how every
 * resumed poll silently failed — and because it sits at the TOP level, a
 * getter that accepted it would win over the real id nested in `data`.
 */
export function extractJobId(value: unknown): string | null {
  return extractFromNested(value, (o) => o.job_id ?? o.jobId ?? o.task_id ?? o.taskId ?? o.id);
}

export function extractStatusUrl(value: unknown): string | null {
  return extractFromNested(value, (o) => o.status_url ?? o.statusUrl ?? o.poll_url ?? o.pollUrl);
}

/** Raster image URLs only — an SVG is never a finished poster here. */
export function extractImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (/^data:image\/svg/i.test(v)) return null;
    if (v.startsWith("data:image/")) return v;
    if (/^https?:\/\//i.test(v) && !/\.svg(\?|#|$)/i.test(v)) return v;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImageUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const field of [
      "image_url", "imageUrl", "poster_url", "posterUrl", "final_url", "finalUrl",
      "url", "public_url", "publicUrl", "data", "result", "output", "images",
    ]) {
      const found = extractImageUrl(obj[field]);
      if (found) return found;
    }
  }
  return null;
}

export function jobFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.success === false && obj.error) return true;
  const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  if (["failed", "error", "canceled", "cancelled"].includes(status)) return true;
  for (const key of ["data", "result", "job"]) {
    if (jobFailed(obj[key])) return true;
  }
  return false;
}
