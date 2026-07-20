import { KaneraApiError } from "./kanera-client.js";

const DEFAULT_INDEX_URL = "https://www.kanera.app/docs-search.json";
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_INDEX_BYTES = 2_000_000;
const MAX_INDEX_ENTRIES = 5_000;
const STOP_WORDS = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it", "of", "on", "the", "to", "what", "when", "with"]);

type DocsSearchEntry = {
  title: string;
  section: string | null;
  url: string;
  text: string;
};

type CachedIndex = {
  entries: DocsSearchEntry[];
  etag: string | null;
  expiresAt: number;
};

export type KaneraDocsSearchOptions = {
  indexUrl?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
};

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalized(value: string) {
  return words(value).join(" ");
}

function searchTerms(query: string) {
  const all = [...new Set(words(query))];
  const meaningful = all.filter((term) => !STOP_WORDS.has(term));
  return meaningful.length ? meaningful : all;
}

function hasPrefix(tokens: string[], term: string) {
  return term.length >= 3 && tokens.some((token) => token.startsWith(term) || term.startsWith(token));
}

function scoreEntry(entry: DocsSearchEntry, query: string, terms: string[]) {
  const title = normalized(entry.title);
  const section = normalized(entry.section ?? "");
  const text = normalized(entry.text);
  const titleWords = words(entry.title);
  const sectionWords = words(entry.section ?? "");
  const textWords = new Set(words(entry.text));
  const phrase = normalized(query);
  let score = 0;
  let matched = 0;

  if (phrase && title.includes(phrase)) score += 50;
  if (phrase && section.includes(phrase)) score += 40;
  if (phrase && text.includes(phrase)) score += 18;

  for (const term of terms) {
    let termMatched = false;
    if (titleWords.includes(term)) {
      score += 14;
      termMatched = true;
    } else if (hasPrefix(titleWords, term)) {
      score += 7;
      termMatched = true;
    }
    if (sectionWords.includes(term)) {
      score += 11;
      termMatched = true;
    } else if (hasPrefix(sectionWords, term)) {
      score += 5;
      termMatched = true;
    }
    if (textWords.has(term)) {
      score += 3;
      termMatched = true;
    } else if (term.length >= 3 && [...textWords].some((word) => word.startsWith(term) || term.startsWith(word))) {
      score += 1;
      termMatched = true;
    }
    if (termMatched) matched += 1;
  }

  if (!matched) return 0;
  return score + (matched / terms.length) * 20;
}

function excerpt(entry: DocsSearchEntry, query: string, terms: string[], maxLength = 360) {
  const lower = entry.text.toLowerCase();
  const phraseAt = lower.indexOf(query.toLowerCase());
  const termPositions = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0);
  const matchAt = phraseAt >= 0 ? phraseAt : termPositions.length ? Math.min(...termPositions) : 0;
  let start = Math.max(0, matchAt - Math.floor(maxLength / 3));
  let end = Math.min(entry.text.length, start + maxLength);

  if (start > 0) {
    const nextSpace = entry.text.indexOf(" ", start);
    if (nextSpace >= 0 && nextSpace < end) start = nextSpace + 1;
  }
  if (end < entry.text.length) {
    const previousSpace = entry.text.lastIndexOf(" ", end);
    if (previousSpace > start) end = previousSpace;
  }
  return `${start > 0 ? "…" : ""}${entry.text.slice(start, end)}${end < entry.text.length ? "…" : ""}`;
}

function parseIndex(payload: unknown): DocsSearchEntry[] {
  if (!payload || typeof payload !== "object") throw new Error("documentation index must be an object");
  const candidate = payload as { version?: unknown; entries?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.entries) || candidate.entries.length > MAX_INDEX_ENTRIES) {
    throw new Error("unsupported documentation index");
  }

  return candidate.entries.map((value) => {
    if (!value || typeof value !== "object") throw new Error("invalid documentation index entry");
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.title !== "string"
      || !(entry.section === null || typeof entry.section === "string")
      || typeof entry.url !== "string"
      || typeof entry.text !== "string"
      || entry.title.length > 200
      || (typeof entry.section === "string" && entry.section.length > 300)
      || entry.text.length > 50_000
    ) {
      throw new Error("invalid documentation index entry");
    }
    const url = new URL(entry.url);
    if (url.origin !== "https://www.kanera.app" || !url.pathname.startsWith("/docs")) {
      throw new Error("documentation index contains an unexpected URL");
    }
    return { title: entry.title, section: entry.section, url: url.toString(), text: entry.text };
  });
}

export class KaneraDocsSearch {
  private readonly indexUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache?: CachedIndex;
  private refreshing?: Promise<DocsSearchEntry[]>;

  constructor(options: KaneraDocsSearchOptions = {}) {
    this.indexUrl = options.indexUrl ?? DEFAULT_INDEX_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async search(query: string, limit: number) {
    const entries = await this.entries();
    const terms = searchTerms(query);
    const results = entries
      .map((entry, order) => ({ entry, order, score: scoreEntry(entry, query, terms) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, limit)
      .map(({ entry }) => ({
        title: entry.title,
        ...(entry.section ? { section: entry.section } : {}),
        url: entry.url,
        excerpt: excerpt(entry, query, terms),
      }));
    return { query, results };
  }

  private async entries() {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.entries;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async refresh() {
    try {
      const response = await this.fetchImpl(this.indexUrl, {
        headers: {
          accept: "application/json",
          ...(this.cache?.etag ? { "if-none-match": this.cache.etag } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 304 && this.cache) {
        this.cache.expiresAt = this.now() + this.cacheTtlMs;
        return this.cache.entries;
      }
      if (!response.ok) throw new Error(`documentation index returned ${response.status}`);
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > MAX_INDEX_BYTES) throw new Error("documentation index is too large");
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new Error("documentation index is too large");
      const entries = parseIndex(JSON.parse(body) as unknown);
      this.cache = {
        entries,
        etag: response.headers.get("etag"),
        expiresAt: this.now() + this.cacheTtlMs,
      };
      return entries;
    } catch {
      // Documentation is public reference data, so a stale successful snapshot is safer and more
      // useful than making product-help questions fail during a short site or network interruption.
      if (this.cache) {
        // Back off briefly as well, otherwise every MCP request would retry the unavailable site.
        this.cache.expiresAt = this.now() + Math.min(this.cacheTtlMs, 30_000);
        return this.cache.entries;
      }
      throw new KaneraApiError(503, "DOCS_UNAVAILABLE", "Kanera documentation is temporarily unavailable");
    }
  }
}

// The index contains only public documentation and is identical for every credential, so sharing
// this cache avoids downloading it again for each stateless HTTP MCP request without crossing tenants.
const clients = new Map<string, KaneraDocsSearch>();

export function docsSearchClient(indexUrl = DEFAULT_INDEX_URL) {
  let instance = clients.get(indexUrl);
  if (!instance) {
    instance = new KaneraDocsSearch({ indexUrl });
    clients.set(indexUrl, instance);
  }
  return instance;
}
