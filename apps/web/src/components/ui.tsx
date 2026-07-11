// Shared UI primitives for the TokenLayer console — cards, pills, stats,
// empty states, skeletons and a small inline icon set. Zero dependencies;
// everything is Tailwind + hand-drawn SVG so screens stay consistent.

export type IconName =
  | "chain"
  | "shield"
  | "doc"
  | "users"
  | "spark"
  | "check"
  | "warn"
  | "code"
  | "globe"
  | "coins"
  | "arrow";

const ICON_PATHS: Record<IconName, JSX.Element> = {
  // two interlocking links
  chain: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M13 6.5 15.5 4a3.5 3.5 0 0 1 5 5L18 11.5a3.5 3.5 0 0 1-5 0" />
      <path d="M11 17.5 8.5 20a3.5 3.5 0 0 1-5-5L6 12.5a3.5 3.5 0 0 1 5 0" />
    </>
  ),
  // shield with a check
  shield: (
    <>
      <path d="M12 3.5 19.5 6.5v5c0 4.5-3 7.7-7.5 9-4.5-1.3-7.5-4.5-7.5-9v-5L12 3.5Z" />
      <path d="m9 11.8 2.2 2.2 3.8-4" />
    </>
  ),
  // document with folded corner + lines
  doc: (
    <>
      <path d="M6.5 3.5h7L18.5 8.5v12h-12v-17Z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9 13h6M9 16.5h4.5" />
    </>
  ),
  // two people
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 20c.6-3.4 2.7-5.3 5.5-5.3s4.9 1.9 5.5 5.3" />
      <path d="M15.5 5.8a3.2 3.2 0 0 1 0 5.4" />
      <path d="M17.5 14.9c1.8.7 2.7 2.4 3 5.1" />
    </>
  ),
  // four-point sparkle + small star
  spark: (
    <>
      <path d="M12 3.5c.7 3.9 2.4 5.6 6.5 6.5-4.1.9-5.8 2.6-6.5 6.5-.7-3.9-2.4-5.6-6.5-6.5 4.1-.9 5.8-2.6 6.5-6.5Z" />
      <path d="M18.5 15.5c.35 1.9 1.15 2.7 3 3-1.85.3-2.65 1.1-3 3-.35-1.9-1.15-2.7-3-3 1.85-.3 2.65-1.1 3-3Z" />
    </>
  ),
  // check in a circle
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>
  ),
  // warning triangle
  warn: (
    <>
      <path d="M12 4 21 19.5H3L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.2" />
    </>
  ),
  // angle brackets with slash
  code: (
    <>
      <path d="m8 8-4.5 4L8 16" />
      <path d="m16 8 4.5 4L16 16" />
      <path d="M13.5 5.5 10.5 18.5" />
    </>
  ),
  // globe with meridian + equator
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5S14.6 18.2 12 20.5c-2.6-2.3-3.9-5.1-3.9-8.5S9.4 5.8 12 3.5Z" />
    </>
  ),
  // stacked coins
  coins: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
      <path d="M5 11.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
    </>
  ),
  // arrow right
  arrow: (
    <>
      <path d="M4 12h15" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </>
  ),
};

export function Icon(props: { name: IconName; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      {ICON_PATHS[props.name]}
    </svg>
  );
}

export function Card(props: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const { title, description, actions, className, children } = props;
  const hasHeader = Boolean(title || description || actions);
  return (
    <div className={`bg-white rounded-2xl border border-slate-200/80 shadow-sm ${className ?? ""}`}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-slate-100">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-slate-900 leading-6">{title}</h3>}
            {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

export function SectionHeader(props: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  const { title, description, actions } = props;
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
        {description && <p className="text-sm text-slate-500 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

const PILL_TONES: Record<"ok" | "warn" | "danger" | "info" | "muted", string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  danger: "bg-red-100 text-red-700",
  info: "bg-sky-100 text-sky-700",
  muted: "bg-slate-100 text-slate-700",
};

export function Pill(props: {
  tone: "ok" | "warn" | "danger" | "info" | "muted";
  children: React.ReactNode;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${PILL_TONES[props.tone]}`}
    >
      {props.children}
    </span>
  );
}

export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
}): JSX.Element {
  const { label, value, sub, icon } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-start gap-3">
      {icon && (
        <div className="shrink-0 w-9 h-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
          <Icon name={icon} className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-xl font-bold text-slate-900 leading-7 truncate">{value}</div>
        {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

export function EmptyState(props: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): JSX.Element {
  const { icon, title, hint, action } = props;
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6">
      <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
        <Icon name={icon ?? "spark"} className="w-6 h-6" />
      </div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint && <p className="text-xs text-slate-500 mt-1 max-w-xs">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton(props: { lines?: number; className?: string }): JSX.Element {
  const lines = props.lines ?? 3;
  return (
    <div className={`animate-pulse space-y-2.5 ${props.className ?? ""}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3.5 rounded bg-slate-100"
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
        />
      ))}
    </div>
  );
}
