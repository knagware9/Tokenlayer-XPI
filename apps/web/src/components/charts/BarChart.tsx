/** A small dependency-free horizontal bar chart (label + value + proportional bar). */
export function BarChart({
  bars,
  color = "#6366f1",
  format = (v: number) => v.toLocaleString(),
}: {
  bars: { label: string; value: number }[];
  color?: string;
  format?: (v: number) => string;
}): JSX.Element {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="space-y-2">
      {bars.map((b) => (
        <div key={b.label} className="text-xs">
          <div className="flex justify-between mb-0.5">
            <span className="text-slate-600 truncate pr-2">{b.label}</span>
            <span className="text-slate-500 tabular-nums">{format(b.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${(b.value / max) * 100}%`, background: color }} />
          </div>
        </div>
      ))}
      {bars.length === 0 && <div className="text-xs text-slate-400">No data</div>}
    </div>
  );
}
