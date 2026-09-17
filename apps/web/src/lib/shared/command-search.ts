/**
 * Pure ranking for the command palette (AppShell's CommandPalette). No
 * fuzzy-match library — ui.tsx's own header states this codebase is
 * "zero-dependency beyond Tailwind + hand-drawn SVG," so this is a simple,
 * fully-testable substring/prefix scorer instead.
 */
export interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  kind: "nav" | "use-case" | "credential-use-case" | "asset";
  onSelect: () => void;
}

const RESULT_CAP = 20;

/** Higher is better; null means "does not match". */
function scoreField(haystack: string | undefined, needle: string): number | null {
  if (!haystack) return null;
  const h = haystack.toLowerCase();
  if (h === needle) return 100;
  if (h.startsWith(needle)) return 80;
  if (h.includes(needle)) return 40;
  return null;
}

export function rankCommandResults(query: string, items: readonly CommandItem[]): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];

  const scored: { item: CommandItem; score: number }[] = [];
  for (const item of items) {
    const labelScore = scoreField(item.label, q);
    // A sublabel match ranks below any label match at the same tier, so
    // sort by (labelScore ?? 0) first, then total score as the tiebreak.
    const subScore = scoreField(item.sublabel, q);
    if (labelScore === null && subScore === null) continue;
    const total = (labelScore ?? 0) * 2 + (subScore ?? 0);
    scored.push({ item, score: total });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, RESULT_CAP).map((s) => s.item);
}
