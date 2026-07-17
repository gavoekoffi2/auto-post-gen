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
// Note: this does not fully defend against DNS rebinding / redirect-to-internal
// (Deno fetch doesn't expose per-hop hosts); it blocks the obvious direct
// attacks. Keep buckets/secrets out of reach as defence in depth.

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

export async function fetchImageBytes(
  rawUrl: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  assertSafeImageUrl(rawUrl);
  const resp = await fetch(rawUrl, { redirect: "follow" });
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
