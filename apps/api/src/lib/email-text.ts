/**
 * The plain-text alternative for an HTML email. Spam filters score HTML-only mail lower, and some
 * readers (screen readers, text-only clients, watch notifications) show only this part.
 *
 * Templates are ours and use a small, regular set of tags, so a targeted conversion is enough: drop
 * the head and the hidden preheader, keep links as "label (url)", turn block ends into line breaks.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // The preheader and its spacer are hidden in HTML; in text they would read as a stray first line.
    .replace(/<div[^>]*display:none[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, inner: string) => {
      const label = collapse(stripTags(inner));
      const url = decodeEntities(href);
      if (url.startsWith("mailto:")) return label;
      return !label || label === url ? url : `${label} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|div|table|li)>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, " ");
  text = decodeEntities(stripTags(text));
  return text
    .split("\n")
    .map((line) => collapse(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function collapse(value: string): string {
  return value.replace(/[ \t\u00a0]+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", zwnj: "", copy: "©" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}
