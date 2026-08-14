// XI Tokenize brand logo — a gradient "X" mark (green → teal → blue) with
// scattering "tokenized" pixels, plus the wordmark. Pure SVG/markup so it
// renders crisply at any size and needs no binary asset.

let gid = 0;

export function LogoMark({ size = 32, className }: { size?: number; className?: string }): JSX.Element {
  const id = `xi-grad-${(gid += 1)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} role="img" aria-label="XI Tokenize">
      <defs>
        <linearGradient id={id} x1="6" y1="42" x2="42" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0098DB" />
          <stop offset="0.5" stopColor="#1AC8A9" />
          <stop offset="1" stopColor="#3FA66B" />
        </linearGradient>
      </defs>
      {/* the two crossing ribbons forming the X */}
      <path d="M11 39 L31 13" stroke={`url(#${id})`} strokeWidth="7.5" strokeLinecap="round" />
      <path d="M11 13 L31 39" stroke={`url(#${id})`} strokeWidth="7.5" strokeLinecap="round" />
      {/* scattering tokenized pixels off the top-right */}
      <rect x="34" y="11" width="7" height="7" rx="1.6" fill="#1AC8A9" />
      <rect x="39.5" y="4.5" width="5" height="5" rx="1.2" fill="#3FA66B" />
      <rect x="33.5" y="3" width="3.5" height="3.5" rx="1" fill="#0098DB" opacity="0.85" />
    </svg>
  );
}

/** Mark + wordmark. Use onDark on dark (ink) surfaces. */
export function Logo({ onDark = false, size = 30 }: { onDark?: boolean; size?: number }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="font-extrabold tracking-tight leading-none" style={{ fontSize: size * 0.62 }}>
        <span className={onDark ? "text-white" : "text-ink"}>XI</span>
        <span className="text-xiblue">Tokenize</span>
      </span>
    </div>
  );
}
