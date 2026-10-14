/**
 * Replaces stored media URLs in copied Markdown with the URLs of the copied files, using a map of
 * source URL to copy URL. Copies (duplicated cards and notes, mirrored cards) own separate files,
 * so their inline images must point at those: otherwise they show the source's files and break
 * once the source attachment is deleted. URLs not in the map (external images, other cards'
 * files) are left alone.
 */
export function rewriteCopiedMediaUrls(markdown: string, urls: ReadonlyMap<string, string>): string;
export function rewriteCopiedMediaUrls(markdown: string | null, urls: ReadonlyMap<string, string>): string | null;
export function rewriteCopiedMediaUrls(markdown: string | null, urls: ReadonlyMap<string, string>): string | null {
  if (!markdown || urls.size === 0) return markdown;
  // Longest first, so a URL that prefixes another can never claim the longer one's match.
  const pattern = [...urls.keys()]
    .sort((a, b) => b.length - a.length)
    .map((url) => (RegExp as RegExpConstructor & { escape: (value: string) => string }).escape(url))
    .join("|");
  return markdown.replace(new RegExp(pattern, "g"), (url) => urls.get(url) ?? url);
}

interface CardAttachmentUrls {
  url: string;
  thumbnailUrl: string | null;
  coverImageUrl: string | null;
}

/** Source-to-copy URL map for card attachments, covering their thumbnail and cover derivatives. */
export function cardAttachmentUrlMap(pairs: Iterable<{ src: CardAttachmentUrls; copy: CardAttachmentUrls }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const { src, copy } of pairs) {
    map.set(src.url, copy.url);
    if (src.thumbnailUrl && copy.thumbnailUrl) map.set(src.thumbnailUrl, copy.thumbnailUrl);
    if (src.coverImageUrl && copy.coverImageUrl) map.set(src.coverImageUrl, copy.coverImageUrl);
  }
  return map;
}
