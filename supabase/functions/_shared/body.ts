// Bounded request-body reading.
//
// Checking only `content-length` is not enforcement: the header is optional
// (and client-supplied), so a chunked request with no content-length sailed
// past the guard and the whole body was buffered by req.json() anyway. These
// helpers stream the body and abort as soon as the cap is exceeded, so an
// oversized payload is rejected instead of being held in memory.

export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Payload exceeds ${maxBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = parseInt(req.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// Reads and parses a JSON body under a hard size cap. Throws
// PayloadTooLargeError when the cap is exceeded; returns null for an
// empty or malformed body so callers can answer 400 themselves.
export async function readJsonBody<T = unknown>(
  req: Request,
  maxBytes: number,
): Promise<T | null> {
  const text = await readBodyText(req, maxBytes);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
