/**
 * THE ACTIVITY LOG'S PURE PARTS — the export and the cursor arithmetic.
 *
 * Both live here rather than in the component because both are things an
 * auditor relies on being exactly right, and neither needs a browser to check.
 */
import type { PlatformEvent } from "../../types.js";

/**
 * One CSV field, quoted when it has to be.
 *
 * A comma, a quote or a newline inside a value silently corrupts the ROW it
 * sits in and every column after it — and event payloads carry all three
 * routinely (a revocation reason is free text; `data` is JSON with commas in
 * it). An export that shifts a column is worse than no export: the numbers
 * still look like numbers, just against the wrong headings.
 *
 * RFC 4180: wrap in quotes, and double any quote inside.
 */
export function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Column order of the export — also the header row. */
export const ACTIVITY_COLUMNS = ["seq", "occurredAt", "type", "orgId", "useCaseKey", "subjectId", "id", "data"] as const;

/**
 * The events as a CSV document.
 *
 * `data` is exported as JSON in a single cell rather than flattened into
 * columns: its shape follows the event type, so flattening would produce a
 * different column set per row — which no spreadsheet and no auditor can read.
 */
export function activityCsv(events: PlatformEvent[]): string {
  const header = ACTIVITY_COLUMNS.join(",");
  const rows = events.map((e) => ACTIVITY_COLUMNS.map((c) => csvField(e[c])).join(","));
  return [header, ...rows].join("\n");
}

/**
 * The next cursor for a "load more" click.
 *
 * The API's contract: an EMPTY page returns your own cursor back unchanged, so
 * the loop never re-reads and never skips. That also means an empty page is how
 * you know you have reached the end — `nextAfter === after` — and the UI must
 * read it that way rather than polling forever on a quiet log.
 */
export function atEnd(after: number, nextAfter: number, received: number): boolean {
  return received === 0 || nextAfter === after;
}
