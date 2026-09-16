/**
 * CSV text that opens cleanly in Excel: a byte-order mark, CRLF line ends,
 * quoted text, and a guard against formula injection.
 *
 * A cell that starts with =, +, - or @ (even after spaces or control
 * characters) would run as a formula when opened in a spreadsheet. We
 * prefix such text with an apostrophe, which Excel shows as plain text.
 * Numbers pass through untouched so they stay numbers.
 */

export type CsvValue = string | number | boolean | null | undefined;

const FORMULA = /^[\s\x00-\x1f]*[=+\-@]/;

/** One cell, quoted and neutralised as needed. `numeric` skips the formula guard. */
export function csvCell(value: unknown, numeric = false): string {
  if (value == null) return "";
  let text = String(value);
  if (!numeric && FORMULA.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** A whole file: header row, then rows. Finite numbers pass through as numbers. */
export function csvText(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) =>
    row
      .map((value) => csvCell(value, typeof value === "number" && Number.isFinite(value)))
      .join(","),
  );
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
