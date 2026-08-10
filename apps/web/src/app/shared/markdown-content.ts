/**
 * Whitespace, plus the characters that render as nothing but survive `trim()`: zero-width
 * space/joiners and the word joiner. `\s` already covers the non-breaking and ideographic spaces.
 */
const INVISIBLE_CHARS = "\\s\u200b-\u200d\u2060\ufeff";

/**
 * Everything the rich-text editor can emit for a document the user perceives as empty.
 *
 * The description editor serialises through tiptap-markdown, so "nothing" is rarely the empty
 * string: a hard break becomes a trailing backslash, a paragraph break becomes newlines, and
 * pasted content leaves entity-encoded spaces behind. Matching only `trim()` therefore reports
 * content for a document that draws nothing on screen.
 */
const BLANK_MARKDOWN_RE = new RegExp(
  [
    "<br\\s*/?>", // HTML break, from pasted content
    "&nbsp;",
    "&#(?:32|160);",
    "&#x0*(?:20|a0);",
    "\\\\(?=\\r?\\n|$)", // tiptap-markdown serialises a hard break as a line-ending backslash
    `[${INVISIBLE_CHARS}]`,
  ].join("|"),
  "gi",
);

/**
 * Whether markdown holds anything a reader would see.
 *
 * Used wherever "did the user actually write something" gates behaviour — offering an unsaved
 * draft, persisting one, or posting a comment. A document of only blank lines is not work worth
 * recovering, and offering to restore it makes the draft banner feel broken.
 */
export function hasMarkdownContent(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  return markdown.replace(BLANK_MARKDOWN_RE, "") !== "";
}
