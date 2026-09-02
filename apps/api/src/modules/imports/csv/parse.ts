import { MAX_CSV_IMPORT_COLUMNS, MAX_CSV_IMPORT_ROWS } from "@kanera/shared/dto";
import Papa from "papaparse";
import { badRequest } from "../../../lib/errors.js";
import { parseCsvDate } from "./dates.js";
import { decodeCsvBuffer } from "./decode.js";

export interface CsvSource {
  rows: string[][];
  delimiter: string;
  encoding: string;
  raggedRows: number;
  columnCount: number;
}

export function parseCsv(buffer: Buffer): CsvSource {
  const decoded = decodeCsvBuffer(buffer);
  const result = Papa.parse<string[]>(decoded.text, {
    delimiter: "",
    delimitersToGuess: [",", ";", "\t", "|"],
    header: false,
    skipEmptyLines: "greedy",
  });
  if (result.errors.some((error) => error.type === "Quotes")) {
    throw badRequest(`could not parse CSV: ${result.errors[0]?.message ?? "invalid quoting"}`);
  }
  const originalRows = result.data
    .map((row) => row.map((cell) => String(cell ?? "")))
    .filter((row) => row.some((cell) => cell.trim() !== ""));
  if (originalRows.length === 0) throw badRequest("CSV did not contain any rows");
  if (originalRows.length > MAX_CSV_IMPORT_ROWS) throw badRequest(`CSV exceeds the ${MAX_CSV_IMPORT_ROWS.toLocaleString()} row limit`);
  const columnCount = Math.max(...originalRows.map((row) => row.length));
  if (columnCount > MAX_CSV_IMPORT_COLUMNS) throw badRequest(`CSV exceeds the ${MAX_CSV_IMPORT_COLUMNS} column limit`);
  const raggedRows = originalRows.filter((row) => row.length !== columnCount).length;
  const rows = originalRows.map((row) => [...row, ...Array.from({ length: columnCount - row.length }, () => "")]);
  return { rows, delimiter: result.meta.delimiter, encoding: decoded.encoding, raggedRows, columnCount };
}

// Header cells may legitimately repeat (Jira emits several `Labels`/`Comment` columns) and may be
// words that double as boolean values (`Done`, `Open`), so only numeric and date-like cells count
// as evidence that the first row is data.
export function detectHeaderRow(rows: string[][]): boolean {
  const first = rows[0];
  if (!first || first.length === 0 || first.some((cell) => cell.trim() === "")) return false;
  return first.every((cell) => {
    const value = cell.trim();
    return !Number.isFinite(Number(value)) && !parseCsvDate(value, "dmy");
  });
}
