/** Simple CSV: first line headers, comma-split, trimmed cells (matches the connector). */
export function parseCsv(text: string): Record<string, string>[] {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!headerLine || lines.length === 0) return [];
  const headers = headerLine.split(",").map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}
