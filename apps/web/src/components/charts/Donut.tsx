/** A small dependency-free donut chart. Segments are drawn with stroke-dasharray. */
export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function Donut({ slices, size = 96 }: { slices: DonutSlice[]; size?: number }): JSX.Element {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 15.9155; // circumference ≈ 100, so dasharray values read as percentages
  let offset = 25; // start at 12 o'clock
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 42 42" role="img" aria-label="Distribution donut chart">
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--tw-donut-track, #e2e8f0)" strokeWidth="6" className="text-slate-200" />
        {total > 0 &&
          slices.map((s) => {
            const pct = (s.value / total) * 100;
            const dash = `${pct} ${100 - pct}`;
            const el = (
              <circle
                key={s.label}
                cx="21"
                cy="21"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="6"
                strokeDasharray={dash}
                strokeDashoffset={offset}
              />
            );
            offset -= pct;
            return el;
          })}
      </svg>
      <div className="text-[11px] leading-relaxed">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span style={{ color: s.color }}>●</span>
            <span className="text-slate-600">{s.label}</span>
            <span className="text-slate-400">· {total > 0 ? Math.round((s.value / total) * 100) : 0}%</span>
          </div>
        ))}
        {total === 0 && <div className="text-slate-400">No data</div>}
      </div>
    </div>
  );
}
