// deno-lint-ignore-file no-explicit-any
//
// SSRF-aware image fetch. Several functions re-host images from URLs that can be
// influenced by users (e.g. posts.image_url, custom image URLs, provider
// responses). Without guards, a user could point those at internal/metadata
// endpoints (169.254.169.254, localhost, private ranges) and have a
// service-role function fetch them from inside the infra, or push an unbounded
// body to exhaust memory.
//
// assertSafeImageUrl: rejects non-https and private/loopback/link-local hosts.
// fetchImageBytes: assert + fetch + content-type + size cap, returning bytes.
//
// Redirects are followed MANUALLY so every hop is re-validated. Letting fetch
// follow them itself checks only the first URL, so any allowed host could
// bounce us to http://169.254.169.254 (cloud metadata) or a loopback port and
// the guard above would never see it.
//
// Note: this still does not defend against DNS rebinding (Deno's fetch does not
// expose the resolved address), so keep buckets/secrets out of reach as
// defence in depth.

const PRIVATE_HOST = new RegExp(
  [
    "^localhost$",
    "^0\\.0\\.0\\.0$",
    "^127\\.", // loopback
    "^10\\.", // private A
    "^192\\.168\\.", // private C
    "^172\\.(1[6-9]|2\\d|3[01])\\.", // private B
    "^169\\.254\\.", // link-local (cloud metadata)
    "^::1$",
    "^fe80:", // IPv6 link-local
    "^f[cd]", // IPv6 unique-local
    "^metadata\\.", // GCP/other metadata hostnames
  ].join("|"),
  "i",
);

export function assertSafeImageUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Invalid image URL");
  }
  if (u.protocol !== "https:") {
    throw new Error("Only https image URLs are allowed");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    PRIVATE_HOST.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error("Image host is not allowed");
  }
  return u;
}

const MAX_REDIRECTS = 5;

// Follow redirects ourselves, re-running assertSafeImageUrl on every hop.
async function fetchFollowingSafeRedirects(rawUrl: string): Promise<Response> {
  let current = assertSafeImageUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await fetch(current.toString(), { redirect: "manual" });
    if (resp.status < 300 || resp.status > 399) return resp;
    const location = resp.headers.get("location");
    // Consume the body so the connection is not left dangling.
    await resp.body?.cancel();
    if (!location) throw new Error(`Redirect without Location: ${resp.status}`);
    // Resolve relative Locations against the current hop, then re-validate.
    current = assertSafeImageUrl(new URL(location, current).toString());
  }
  throw new Error("Too many redirects");
}

export async function fetchImageBytes(
  rawUrl: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const resp = await fetchFollowingSafeRedirects(rawUrl);
  if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`);
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/") || contentType.includes("svg")) {
    throw new Error(`Unexpected image content-type: ${contentType || "none"}`);
  }
  const declared = parseInt(resp.headers.get("content-length") || "0", 10);
  if (declared && declared > maxBytes) throw new Error("Image too large");
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error("Image too large");
  return { bytes: buf, contentType: contentType || "image/jpeg" };
}
