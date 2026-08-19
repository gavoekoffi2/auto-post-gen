// Neutralise text written by third parties before it reaches an LLM prompt.
//
// Two paths in this product feed attacker-authorable text to a model whose
// output is then published on the user's real social accounts:
//
//   1. Web-research titles/snippets (_shared/research.ts) — anyone who can rank
//      a page for a sector keyword can put text in front of the model.
//   2. Incoming social comments (_shared/engagement.ts) — any stranger who can
//      comment on a published post writes directly into the reply prompt, and
//      with auto-reply enabled the answer is posted with no human in the loop.
//
// We cannot make a model immune to persuasion, but we can remove the levers
// that make injection reliable: no line breaks (so the text cannot forge a new
// prompt section), no prompt-structure characters, no invisible/bidi
// characters used to smuggle payloads, no runs of instruction-like keywords,
// and a hard length cap. Callers must additionally fence the value and tell the
// model it is data.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore[a-z]*\s+(les\s+|the\s+|toutes?\s+|all\s+)?(instructions?|consignes?)(\s+(précédent\w*|previous|above|ci-dessus))?/gi,
  /(oublie|forget|disregard)\s+(tout|tous|all|everything|les\s+instructions?)/gi,
  /(system|assistant|user)\s*:/gi,
  /<\/?(system|instructions?|prompt)[^>]*>/gi,
  /(nouvelles?|new)\s+(instructions?|consignes?)/gi,
  /\b(tu\s+dois|you\s+must|act\s+as|agis\s+comme|réponds\s+uniquement|respond\s+only)\b/gi,
];

export function sanitizeUntrustedText(value: string, maxLength: number): string {
  let out = String(value ?? "")
    // Collapse every newline/tab: untrusted text must stay a single inert line
    // so it cannot forge headings or a new section of the prompt.
    .replace(/[\r\n\t]+/g, " ")
    // Strip characters used to fence or structure the prompt.
    .replace(/[`{}<>|]/g, " ")
    // Drop zero-width / bidi control characters used to hide payloads.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");
  for (const re of INJECTION_PATTERNS) out = out.replace(re, "[filtré]");
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// True when what is left is nothing but filtered payload — i.e. the input was
// an injection attempt and carries no usable content.
export function isOnlyFilteredNoise(sanitized: string): boolean {
  return sanitized.replace(/\[filtré\]/g, "").trim().length === 0;
}
