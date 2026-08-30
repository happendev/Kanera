export type OutputMode = "human" | "json" | "quiet";

export interface Envelope {
  ok: boolean;
  tool?: string;
  data?: unknown;
  summary?: string;
  error?: {
    status?: number;
    code?: string;
    message: string;
    hint?: string;
    exitCode: number;
    retryable?: boolean;
    retryAfter?: string;
  };
}

const MAX_CELL = 48;
const MAX_COLUMNS = 6;
/** Columns worth showing first when a record has more fields than a terminal row can hold. */
const PREFERRED_COLUMNS = ["key", "cardKey", "name", "title", "displayName", "listName", "boardName", "status", "id", "url"];
/** Presentation and internal fields that would crowd out the columns a reader actually scans. */
const HIDDEN_COLUMNS = new Set([
  "icon", "color", "accentColor", "workspaceIcon", "workspaceAccentColor", "logoUrl", "avatarUrl",
  "position", "searchVector", "coverAttachmentId",
]);

export function outputMode(flags: { json?: boolean; quiet?: boolean }): OutputMode {
  if (flags.quiet) return "quiet";
  if (flags.json) return "json";
  return "human";
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = isPrimitive(value) ? String(value) : Array.isArray(value) ? `[${value.length}]` : "{…}";
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) if (isPrimitive(value) && !HIDDEN_COLUMNS.has(key)) seen.add(key);
  }
  const preferred = PREFERRED_COLUMNS.filter((name) => seen.has(name));
  const rest = [...seen].filter((name) => !preferred.includes(name));
  return [...preferred, ...rest].slice(0, MAX_COLUMNS);
}

export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.";
  const columns = columnsFor(rows);
  if (columns.length === 0) return JSON.stringify(rows, null, 2);
  const header = columns.map((name) => name.toUpperCase());
  const body = rows.map((row) => columns.map((name) => cell(row[name])));
  const widths = header.map((name, index) => Math.max(name.length, ...body.map((row) => row[index]!.length)));
  const line = (cells: string[]) => cells.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "─".repeat(width))), ...body.map(line)].join("\n");
}

/** Pull the one array a list-shaped tool result is really about, so it can render as a table. */
function tabularRows(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
      ? data as Record<string, unknown>[]
      : null;
  }
  if (data === null || typeof data !== "object") return null;
  const entries = Object.entries(data as Record<string, unknown>);
  const arrays = entries.filter(([, value]) => Array.isArray(value));
  if (arrays.length !== 1) return null;
  const rows = arrays[0]![1] as unknown[];
  // An empty array only means "no results" when the payload is the list itself. A created entity
  // that happens to carry one empty collection (a comment with no attachments) must not render as
  // "No results." — that would report success as emptiness.
  if (rows.length === 0 && entries.length > 2) return null;
  return tabularRows(rows);
}

export function renderHuman(envelope: Envelope): string {
  if (!envelope.ok) {
    const error = envelope.error;
    const code = error?.code ? ` [${error.code}]` : "";
    const retry = error?.retryAfter ? `Retry after: ${error.retryAfter}` : undefined;
    return [`Error${code}: ${error?.message ?? "unknown failure"}`, error?.hint, retry].filter(Boolean).join("\n");
  }
  const rows = tabularRows(envelope.data);
  const parts: string[] = [];
  if (envelope.summary) parts.push(envelope.summary);
  parts.push(rows ? renderTable(rows) : JSON.stringify(envelope.data ?? { ok: true }, null, 2));
  // A paginated result is useless without its cursor, and the table drops non-primitive fields.
  const cursor = envelope.data && typeof envelope.data === "object"
    ? (envelope.data as Record<string, unknown>).nextCursor
    : undefined;
  if (rows && typeof cursor === "string") parts.push(`\nMore results: --cursor ${cursor}`);
  return parts.join("\n");
}

export function render(mode: OutputMode, envelope: Envelope): string {
  if (mode === "quiet") return JSON.stringify(envelope.ok ? envelope.data ?? null : envelope.error);
  if (mode === "json") return JSON.stringify(envelope, null, 2);
  return renderHuman(envelope);
}
