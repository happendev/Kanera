type RegExpWithEscape = RegExpConstructor & {
  escape: (value: string) => string;
};

export function stripAttachmentReferences(
  body: string | null,
  url: string,
): { body: string | null; changed: boolean } {
  if (!body) return { body, changed: false };
  const escaped = (RegExp as RegExpWithEscape).escape(url);
  const patterns = [
    new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, "g"),
    new RegExp(`\\[[^\\]]*\\]\\(${escaped}\\)`, "g"),
  ];
  let next = body;
  for (const re of patterns) next = next.replace(re, "");
  next = next.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  return { body: next, changed: next !== body };
}
