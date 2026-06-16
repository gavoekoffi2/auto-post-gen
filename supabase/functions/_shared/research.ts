// deno-lint-ignore-file no-explicit-any
//
// Shared web-research module. Pulls FREE, no-API-key sources (Google News
// RSS, Wikipedia, DuckDuckGo) plus optional premium upgrades (Tavily,
// Brave) and turns them into LLM "inspiration" so generated posts are
// grounded in real, current, sector-specific facts instead of generic
// filler. Used by BOTH manual generation (generate-content) and the
// automatic weekly generator (auto-generate-weekly).
//
// Design goals:
//   - Fail-soft: every source swallows its own errors and returns [].
//   - Bounded: each fetch has a timeout and the whole pass has a deadline,
//     so research can never stall the calling function (important for the
//     cron batch).
//   - Targeted: queries are built from the company's own description, not
//     just the broad sector label.

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}

// Identify ourselves politely; several free services reject empty UAs.
const HTTP_UA = "ProSocialAI/1.0 (+https://prosocial.ai)";

// Per-request and per-pass time budgets (ms).
const FETCH_TIMEOUT_MS = 6000;
const DEFAULT_DEADLINE_MS = 10000;

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Strip HTML tags and decode common entities so RSS/HTML snippets are
// clean enough to feed into the LLM.
function htmlToText(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? htmlToText(m[1]) : "";
}

// --- FREE SOURCES (no API key needed) ----------------------------

// Google News RSS: officially provided by Google, no auth, fresh news
// filtered by language/region. Best free source for sector trends.
export async function googleNewsRssSearch(
  query: string,
  lang = "fr",
  region = "FR",
): Promise<WebResult[]> {
  try {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", lang);
    url.searchParams.set("gl", region);
    url.searchParams.set("ceid", `${region}:${lang}`);
    const resp = await fetchWithTimeout(url.toString(), {
      headers: { "User-Agent": HTTP_UA, Accept: "application/rss+xml" },
    });
    if (!resp.ok) {
      console.error("Google News RSS:", resp.status);
      return [];
    }
    const xml = await resp.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.slice(0, 5).map((block) => ({
      title: pickTag(block, "title"),
      snippet: pickTag(block, "description").slice(0, 400),
      url: pickTag(block, "link"),
      source: "google-news",
    }));
  } catch (err) {
    console.error("Google News RSS threw:", err);
    return [];
  }
}

// Wikipedia REST API: free, no key, reliable from any IP including
// datacenter IPs (unlike DuckDuckGo). Great foundational context.
export async function wikipediaSearch(query: string, lang = "fr"): Promise<WebResult[]> {
  try {
    const searchUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    searchUrl.searchParams.set("action", "opensearch");
    searchUrl.searchParams.set("search", query);
    searchUrl.searchParams.set("limit", "5");
    searchUrl.searchParams.set("format", "json");
    const searchResp = await fetchWithTimeout(searchUrl.toString(), {
      headers: { "User-Agent": HTTP_UA },
    });
    if (!searchResp.ok) {
      console.error("Wikipedia search:", searchResp.status);
      return [];
    }
    const data = await searchResp.json();
    // opensearch returns [query, [titles], [descriptions], [urls]]
    const titles: string[] = data[1] || [];
    const descriptions: string[] = data[2] || [];
    const urls: string[] = data[3] || [];

    // Fetch summaries in parallel for richer snippets.
    const summaries = await Promise.allSettled(
      titles.slice(0, 4).map(async (title) => {
        const sumUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
        const sumResp = await fetchWithTimeout(sumUrl, { headers: { "User-Agent": HTTP_UA } });
        if (!sumResp.ok) return "";
        const sumData = await sumResp.json();
        return sumData.extract || "";
      }),
    );

    const results: WebResult[] = [];
    for (let i = 0; i < titles.length && results.length < 4; i++) {
      const fromSummary = summaries[i]?.status === "fulfilled"
        ? (summaries[i] as PromiseFulfilledResult<string>).value
        : "";
      results.push({
        title: titles[i],
        snippet: (fromSummary || descriptions[i] || "").slice(0, 400),
        url: urls[i] || "",
        source: "wikipedia",
      });
    }
    return results;
  } catch (err) {
    console.error("Wikipedia threw:", err);
    return [];
  }
}

// DuckDuckGo HTML — best-effort. DDG often blocks datacenter IPs (503),
// so we try it but never depend on it.
export async function duckduckgoHtmlSearch(query: string): Promise<WebResult[]> {
  try {
    const resp = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": HTTP_UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const results: WebResult[] = [];
    const blocks = html.match(/<div class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (const block of blocks.slice(0, 8)) {
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
      if (titleMatch) {
        results.push({
          title: htmlToText(titleMatch[1]),
          snippet: htmlToText(snippetMatch?.[1] || "").slice(0, 400),
          url: urlMatch?.[1] || "",
          source: "duckduckgo",
        });
      }
      if (results.length >= 4) break;
    }
    return results;
  } catch (_) {
    return [];
  }
}

// --- PREMIUM SOURCES (API key, better quality) -------------------

export async function tavilySearch(query: string): Promise<WebResult[]> {
  const apiKey = Deno.env.get("TAVILY_API_KEY");
  if (!apiKey) return [];
  try {
    const resp = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: false,
      }),
    });
    if (!resp.ok) {
      console.error("Tavily error:", resp.status);
      return [];
    }
    const data = await resp.json();
    return (data.results || []).slice(0, 5).map((r: any) => ({
      title: String(r.title || "").slice(0, 200),
      snippet: String(r.content || "").slice(0, 400),
      url: String(r.url || ""),
      source: "tavily",
    }));
  } catch (err) {
    console.error("Tavily threw:", err);
    return [];
  }
}

export async function braveSearch(query: string): Promise<WebResult[]> {
  const apiKey = Deno.env.get("BRAVE_SEARCH_API_KEY");
  if (!apiKey) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    const resp = await fetchWithTimeout(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    });
    if (!resp.ok) {
      console.error("Brave error:", resp.status);
      return [];
    }
    const data = await resp.json();
    const items = data?.web?.results || [];
    return items.slice(0, 5).map((r: any) => ({
      title: String(r.title || "").slice(0, 200),
      snippet: String(r.description || "").slice(0, 400),
      url: String(r.url || ""),
      source: "brave",
    }));
  } catch (err) {
    console.error("Brave threw:", err);
    return [];
  }
}

// Pull meaningful nouns out of a free-form description so queries focus on
// the actual activity (e.g. "boulangerie artisanale Paris bio") instead of
// the generic sector label.
const FR_STOPWORDS = new Set([
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "le", "la", "les", "un", "une", "des", "de", "du", "au", "aux",
  "et", "ou", "mais", "donc", "or", "ni", "car", "que", "qui", "quoi",
  "dont", "ce", "cet", "cette", "ces", "mon", "ma", "mes", "ton", "ta",
  "tes", "son", "sa", "ses", "notre", "votre", "leur", "leurs", "se",
  "pour", "par", "avec", "sans", "sur", "sous", "dans", "chez", "vers",
  "est", "sont", "suis", "es", "ai", "as", "ont", "avons", "avez",
  "été", "étant", "fait", "faire", "fais", "très", "plus", "moins",
  "aussi", "encore", "déjà", "ne", "pas", "non", "oui", "si", "alors",
  "comme", "mêmes", "the", "and", "for", "with",
]);

export function extractKeywords(text: string, max = 6): string[] {
  if (!text) return [];
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents for stopword match
    .replace(/[^a-z0-9àâäéèêëîïôöùûüç \-]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !FR_STOPWORDS.has(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
}

// Gather real-world inspiration for one business. Bounded by a deadline so
// it can't stall the caller. Results are deduped and capped.
export async function researchInspiration(
  sector: string,
  companyName: string,
  description: string,
  opts: { deadlineMs?: number } = {},
): Promise<WebResult[]> {
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const remaining = () => deadline - Date.now();
  const year = new Date().getFullYear();
  const keywords = extractKeywords(description, 6);
  const keywordPhrase = keywords.slice(0, 4).join(" ");

  // Queries ordered MOST specific → least specific.
  const queries: string[] = [];
  if (keywordPhrase) {
    queries.push(`${keywordPhrase} ${year}`);
    queries.push(`${keywordPhrase} conseils`);
    queries.push(`actualité ${keywordPhrase}`);
  }
  if (companyName && companyName !== "notre entreprise") {
    queries.push(`${companyName} ${sector}`);
  }
  queries.push(`tendances ${sector} ${year}`);
  queries.push(`actualité ${sector}`);

  const collected: WebResult[] = [];

  // 1. Google News — run the top queries concurrently (fresh, reliable).
  const newsBatches = await Promise.allSettled(
    queries.slice(0, 3).map((q) => googleNewsRssSearch(q)),
  );
  for (const b of newsBatches) {
    if (b.status === "fulfilled") collected.push(...b.value);
  }

  // 2. Wikipedia — foundational context (parallel), if budget remains.
  if (remaining() > 2000 && collected.length < 6) {
    const wikiQueries = keywords.length > 0 ? [keywords[0], sector] : [sector];
    const wikiBatches = await Promise.allSettled(
      wikiQueries.map((wq) => wikipediaSearch(wq)),
    );
    for (const b of wikiBatches) {
      if (b.status === "fulfilled") collected.push(...b.value);
    }
  }

  // 3. DuckDuckGo — best-effort extra.
  if (remaining() > 2000 && collected.length < 4) {
    collected.push(...(await duckduckgoHtmlSearch(queries[0])));
  }

  // 4. Premium upgrades (only if a key is set and budget remains).
  if (remaining() > 2000 && Deno.env.get("TAVILY_API_KEY")) {
    collected.push(...(await tavilySearch(queries[0])));
  }
  if (remaining() > 2000 && collected.length < 8 && Deno.env.get("BRAVE_SEARCH_API_KEY")) {
    collected.push(...(await braveSearch(queries[0])));
  }

  // Dedupe by url/title, drop empties, cap at 8.
  const seen = new Set<string>();
  const deduped: WebResult[] = [];
  for (const r of collected) {
    if (!r.title) continue;
    const key = (r.url || r.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

// Render the inspiration block injected into the LLM system prompt, with
// explicit filtering instructions so the model only uses what is truly
// relevant to this specific business.
export function buildInspirationBlock(webResults: WebResult[], focus: string): string {
  if (!webResults.length) {
    return `\n(Aucune matière web trouvée — génère depuis ton expertise du métier décrit ci-dessous.)\n`;
  }
  return `\nMATIÈRE BRUTE TROUVÉE EN LIGNE (à FILTRER selon la pertinence pour "${focus}"):
${webResults
    .slice(0, 6)
    .map((r, i) => `${i + 1}. [${r.source}] ${r.title}${r.snippet ? " — " + r.snippet : ""}`)
    .join("\n")}

INSTRUCTION DE FILTRAGE:
- N'utilise QUE les éléments qui ont un lien clair avec l'activité spécifique du client ci-dessus
- Ignore tout snippet qui ne concerne pas ce métier précis, MÊME s'il évoque le secteur en général
- Si aucun snippet n'est pertinent, IGNORE TOUTE CETTE LISTE et génère depuis ton expertise du métier
- Ne recopie JAMAIS un snippet mot pour mot, sers-t'en uniquement comme inspiration
- Quand tu utilises un fait/chiffre, intègre-le naturellement (pas de lien, pas de citation brute)
`;
}
