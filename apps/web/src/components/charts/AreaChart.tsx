/** A small dependency-free area/line chart for a time series of numeric points. */
export function AreaChart({
  points,
  height = 90,
  color = "#6366f1",
}: {
  points: { label: string; value: number }[];
  height?: number;
  color?: string;
}): JSX.Element {
  const w = 300;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const x = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * w);
  const y = (v: number): number => height - (v / max) * (height - 6) - 2;
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${w},${height}`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label="Activity over time">
      {n > 0 && <polygon points={area} fill={color} fillOpacity="0.1" />}
      {n > 0 && <polyline points={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
