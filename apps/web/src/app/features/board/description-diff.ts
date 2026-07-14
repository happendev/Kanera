import { marked } from "marked";

export type DescriptionDiffSide = "removed" | "added";

// A unified diff line. "context" is an unchanged line shown for orientation,
// "gap" is a separator standing in for a run of unchanged lines that were
// collapsed away (its single chunk carries the human label, e.g. "12 unchanged lines").
export type DescriptionDiffLineKind = "context" | "removed" | "added" | "gap";

export interface DescriptionDiffChunk {
  text: string;
  changed: boolean;
}

export interface DescriptionDiffUnifiedLine {
  kind: DescriptionDiffLineKind;
  chunks: DescriptionDiffChunk[];
  placeholder: boolean;
}

export interface DescriptionDiff {
  lines: DescriptionDiffUnifiedLine[];
  // True when the semantic description content changed (drives the actual diff body).
  hasChanges: boolean;
  // True when from/to differ but the semantic form is identical, meaning only
  // cosmetic markdown changed. See whitespaceNormalize.
  formattingOnly: boolean;
}

type LineOp =
  | { type: "equal"; value: string }
  | { type: "removed"; value: string }
  | { type: "added"; value: string };

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  title?: string | null;
  depth?: number;
  lang?: string;
  ordered?: boolean;
  start?: number | "";
  task?: boolean;
  checked?: boolean;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

// Number of unchanged lines kept on each side of a change for orientation.
const CONTEXT = 3;

export function descriptionDiff(fromValue: unknown, toValue: unknown): DescriptionDiff {
  const from = normalizeDescriptionValue(fromValue);
  const to = normalizeDescriptionValue(toValue);
  const ops = lineDiff(splitLines(from), splitLines(to));
  const hasChanges = ops.some((op) => op.type !== "equal");

  if (!hasChanges) {
    // No readable-text change. If the raw values still differ once whitespace is
    // normalized (but markdown syntax is kept), the edit was formatting/link/image only.
    const formattingOnly = whitespaceNormalize(fromValue) !== whitespaceNormalize(toValue);
    return { lines: [], hasChanges: false, formattingOnly };
  }

  return { lines: buildUnifiedLines(ops), hasChanges: true, formattingOnly: false };
}

export function hasDescriptionDiffPayload(payload: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "fromValue")
    && Object.prototype.hasOwnProperty.call(payload, "toValue");
}

// Canonicalizes Markdown into readable, semantic lines. Regex stripping used here
// previously erased autolinks, task state, link/image targets, list hierarchy, and
// literal punctuation in code. Token traversal lets cosmetic emphasis disappear
// while every content-bearing construct remains visible in the audit diff.
function normalizeDescriptionValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const markdown = value.replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(markdown, { gfm: true, breaks: true }) as MarkdownToken[];
  return renderBlocks(tokens).join("\n").trim();
}

function renderBlocks(tokens: MarkdownToken[] | undefined): string[] {
  const blocks: string[][] = [];
  for (const token of tokens ?? []) {
    if (token.type === "space") continue;
    const lines = renderBlock(token);
    if (lines.length) blocks.push(lines);
  }
  return blocks.flatMap((block, index) => index === 0 ? block : ["", ...block]);
}

function renderBlock(token: MarkdownToken): string[] {
  switch (token.type) {
    case "heading":
      return [`${"#".repeat(token.depth ?? 1)} ${renderInline(token.tokens, token.text)}`];
    case "paragraph":
    case "text":
      return renderInline(token.tokens, token.text).split("\n");
    case "list":
      return renderList(token, 0);
    case "blockquote":
      return renderBlocks(token.tokens).map((line) => line ? `> ${line}` : ">");
    case "code": {
      const fence = `\`\`\`${token.lang?.trim() ?? ""}`;
      return [fence, ...(token.text ?? "").split("\n"), "```"];
    }
    case "table":
      return renderTable(token);
    case "hr":
      return ["---"];
    default: {
      // Unknown and raw-HTML tokens must remain auditable. Angular renders these
      // lines as text, so retaining the source here cannot inject markup.
      const fallback = token.raw ?? token.text ?? "";
      return fallback.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").filter((line) => line.length > 0);
    }
  }
}

function renderList(token: MarkdownToken, depth: number): string[] {
  const lines: string[] = [];
  const start = typeof token.start === "number" ? token.start : 1;
  for (const [index, item] of (token.items ?? []).entries()) {
    const marker = token.ordered ? `${start + index}.` : "-";
    const task = item.task ? `${item.checked ? "[x]" : "[ ]"} ` : "";
    const itemLines = renderListItem(item, depth);
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${marker} ${task}${itemLines[0] ?? ""}`.trimEnd());
    lines.push(...itemLines.slice(1));
  }
  return lines;
}

function renderListItem(item: MarkdownToken, depth: number): string[] {
  const lines: string[] = [];
  for (const child of item.tokens ?? []) {
    // GFM exposes the checkbox as its own child token as well as item.task;
    // the stable marker is emitted by renderList, so do not duplicate it here.
    if (child.type === "checkbox") continue;
    if (child.type === "list") {
      lines.push(...renderList(child, depth + 1));
      continue;
    }
    const rendered = child.type === "text"
      ? renderInline(child.tokens, child.text).split("\n")
      : renderBlock(child);
    const continuationIndent = "  ".repeat(depth + 1);
    lines.push(...rendered.map((line, index) => index === 0 && lines.length === 0 ? line : `${continuationIndent}${line}`));
  }
  return lines;
}

function renderTable(token: MarkdownToken): string[] {
  const header = (token.header ?? []).map(renderTableCell);
  const rows = (token.rows ?? []).map((row) => row.map(renderTableCell));
  if (!header.length) return rows.map(renderTableRow);
  return [renderTableRow(header), renderTableRow(header.map(() => "---")), ...rows.map(renderTableRow)];
}

function renderTableCell(token: MarkdownToken): string {
  return renderInline(token.tokens, token.text).replace(/\s+/g, " ").trim();
}

function renderTableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function renderInline(tokens: MarkdownToken[] | undefined, fallback = ""): string {
  if (!tokens?.length) return fallback;
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
      case "strong":
      case "em":
      case "del":
        return renderInline(token.tokens, token.text ?? "");
      case "codespan":
        return `\`${token.text ?? ""}\``;
      case "br":
        return "\n";
      case "link": {
        const label = renderInline(token.tokens, token.text ?? "").trim();
        const href = token.href ?? "";
        const target = label === href ? href : `${label || "Link"} <${href}>`;
        return token.title ? `${target} "${token.title}"` : target;
      }
      case "image": {
        const alt = token.text?.trim();
        const image = alt ? `Image: ${alt}` : "Image";
        const target = `${image} <${token.href ?? ""}>`;
        return token.title ? `${target} "${token.title}"` : target;
      }
      case "escape":
        return token.text ?? "";
      default:
        return token.raw ?? token.text ?? renderInline(token.tokens);
    }
  }).join("");
}

// Collapses whitespace and drops blank lines but KEEPS markdown syntax. Used only
// to tell "formatting changed" apart from "nothing meaningful changed": a blank-line
// edit normalizes identically here, while a heading/bold/link edit does not.
function whitespaceNormalize(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function splitLines(value: string): string[] {
  return value ? value.split("\n") : [];
}

// Walks the ordered op list into a unified line list: each change run emits its
// removed lines (word-diffed) then its added lines, and surrounding unchanged runs
// are trimmed to CONTEXT lines with the omitted middle collapsed into a gap line.
// hasChanges (the only caller's guard) ensures at least one change run, so the
// result is always non-empty. Empty→text / text→empty become all-added / all-removed.
function buildUnifiedLines(ops: LineOp[]): DescriptionDiffUnifiedLine[] {
  const lines: DescriptionDiffUnifiedLine[] = [];
  let i = 0;
  let seenChange = false;

  while (i < ops.length) {
    if (ops[i]!.type === "equal") {
      const start = i;
      while (i < ops.length && ops[i]!.type === "equal") i += 1;
      const equals = ops.slice(start, i).map((op) => op.value);
      const moreAfter = i < ops.length;
      pushEqualRun(lines, equals, seenChange, moreAfter);
      continue;
    }

    // Consecutive removed/added ops form one change run. Pair removed[k] with
    // added[k] for word-level highlighting (same index-based pairing as before).
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ops.length && ops[i]!.type !== "equal") {
      const op = ops[i]!;
      if (op.type === "removed") removed.push(op.value);
      else added.push(op.value);
      i += 1;
    }
    seenChange = true;

    for (let k = 0; k < removed.length; k += 1) {
      lines.push({ chunks: wordDiffChunks(removed[k], added[k], "removed"), placeholder: false, kind: "removed" });
    }
    for (let k = 0; k < added.length; k += 1) {
      lines.push({ chunks: wordDiffChunks(removed[k], added[k], "added"), placeholder: false, kind: "added" });
    }
  }

  return lines;
}

// Emits an unchanged run as context lines. Leading context (before the first change)
// keeps only its last CONTEXT lines; trailing context (after the last change) keeps
// only its first CONTEXT; an interior run keeps CONTEXT on each side. Anything omitted
// becomes a single gap line carrying the count.
function pushEqualRun(
  lines: DescriptionDiffUnifiedLine[],
  values: string[],
  seenChange: boolean,
  moreAfter: boolean,
): void {
  const leadKeep = seenChange ? CONTEXT : 0;
  const trailKeep = moreAfter ? CONTEXT : 0;

  if (values.length <= leadKeep + trailKeep) {
    for (const value of values) lines.push(contextLine(value));
    return;
  }

  for (let k = 0; k < leadKeep; k += 1) lines.push(contextLine(values[k]!));
  const omitted = values.length - leadKeep - trailKeep;
  if (omitted > 0) lines.push(gapLine(omitted));
  for (let k = values.length - trailKeep; k < values.length; k += 1) lines.push(contextLine(values[k]!));
}

function contextLine(value: string): DescriptionDiffUnifiedLine {
  return { kind: "context", chunks: [{ text: value, changed: false }], placeholder: false };
}

function gapLine(count: number): DescriptionDiffUnifiedLine {
  const label = count === 1 ? "1 unchanged line" : `${count} unchanged lines`;
  return { kind: "gap", chunks: [{ text: label, changed: false }], placeholder: false };
}

function lineDiff(fromLines: string[], toLines: string[]): LineOp[] {
  const table = lcsTable(fromLines, toLines);
  const ops: LineOp[] = [];
  let i = fromLines.length;
  let j = toLines.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && fromLines[i - 1] === toLines[j - 1]) {
      ops.push({ type: "equal", value: fromLines[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) {
      ops.push({ type: "added", value: toLines[j - 1]! });
      j -= 1;
    } else {
      ops.push({ type: "removed", value: fromLines[i - 1]! });
      i -= 1;
    }
  }
  return ops.reverse();
}

function wordDiffChunks(fromLine: string | undefined, toLine: string | undefined, side: DescriptionDiffSide): DescriptionDiffChunk[] {
  const text = side === "removed" ? fromLine ?? "" : toLine ?? "";
  const other = side === "removed" ? toLine : fromLine;
  if (other === undefined) return [{ text, changed: true }];

  const tokens = tokenizeWords(text);
  const otherTokens = tokenizeWords(other);
  const table = lcsTable(tokens, otherTokens);
  const commonIndexes = new Set<number>();
  let i = tokens.length;
  let j = otherTokens.length;
  while (i > 0 && j > 0) {
    if (tokens[i - 1] === otherTokens[j - 1]) {
      commonIndexes.add(i - 1);
      i -= 1;
      j -= 1;
    } else if (table[i]![j - 1]! >= table[i - 1]![j]!) {
      j -= 1;
    } else {
      i -= 1;
    }
  }

  return mergeChunks(tokens.map((token, index) => ({ text: token, changed: !commonIndexes.has(index) })));
}

function tokenizeWords(value: string): string[] {
  return value.match(/\s+|[^\s]+/g) ?? [];
}

function mergeChunks(chunks: DescriptionDiffChunk[]): DescriptionDiffChunk[] {
  const merged: DescriptionDiffChunk[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.changed === chunk.changed) last.text += chunk.text;
    else merged.push({ ...chunk });
  }
  return merged;
}

function lcsTable<T>(a: readonly T[], b: readonly T[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i]![j] = a[i - 1] === b[j - 1]
        ? table[i - 1]![j - 1]! + 1
        : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table;
}
