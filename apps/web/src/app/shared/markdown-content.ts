/**
 * Whitespace, plus the characters that render as nothing but survive `trim()`: zero-width
 * space/joiners and the word joiner. `\s` already covers the non-breaking and ideographic spaces.
 */
const INVISIBLE_CHARS = "\\s\u200b-\u200d\u2060\ufeff";

const EMPTY_TASK_ITEM_RE = /^[ \t]{0,3}[-+*][ \t]+\[[ xX]\][ \t\u200b-\u200d\u2060\ufeff]*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Removes task-list rows that have no visible label.
 *
 * GFM only recognises a checkbox marker when text follows it. An empty Tiptap task therefore falls
 * back to an ordinary list item whose visible text is `[ ]`. Keep fenced code untouched: an empty
 * marker there is an example, not editor structure.
 */
export function stripEmptyTaskItems(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const parts = markdown.split(/(\r\n|\r|\n)/);
  const output: string[] = [];

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const lineEnding = parts[index + 1] ?? "";
    const fenceMatch = FENCE_RE.exec(line);

    if (fenceMatch) {
      const run = fenceMatch[1]!;
      const rest = fenceMatch[2]!;
      if (!fence) {
        fence = { marker: run.startsWith("`") ? "`" : "~", length: run.length };
      } else if (run.startsWith(fence.marker) && run.length >= fence.length && rest.trim() === "") {
        fence = null;
      }
    }

    if (!fence && !fenceMatch && EMPTY_TASK_ITEM_RE.test(line)) continue;
    output.push(line, lineEnding);
  }

  return output.join("");
}

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
  return stripEmptyTaskItems(markdown).replace(BLANK_MARKDOWN_RE, "") !== "";
}
