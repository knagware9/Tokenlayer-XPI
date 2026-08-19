import { useState } from "react";

// Shared UI primitives for the TokenLayer console.
// Fonts: Bricolage Grotesque (headings) · Manrope (body) · JetBrains Mono (data)
// All components are zero-dependency beyond Tailwind + hand-drawn SVG.

// ─── Icons ────────────────────────────────────────────────────────────────────

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
  | "arrow"
  | "fingerprint"
  | "token"
  | "building"
  | "clock"
  | "trending"
  | "activity"
  | "lock"
  | "key"
  | "eye"
  | "filter"
  | "download"
  | "plus"
  | "chart"
  | "hash"
  | "qr"
  | "layers"
  | "inbox"
  | "send"
  | "refresh";

const ICON_PATHS: Record<IconName, JSX.Element> = {
  chain: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M13 6.5 15.5 4a3.5 3.5 0 0 1 5 5L18 11.5a3.5 3.5 0 0 1-5 0" />
      <path d="M11 17.5 8.5 20a3.5 3.5 0 0 1-5-5L6 12.5a3.5 3.5 0 0 1 5 0" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19.5 6.5v5c0 4.5-3 7.7-7.5 9-4.5-1.3-7.5-4.5-7.5-9v-5L12 3.5Z" />
      <path d="m9 11.8 2.2 2.2 3.8-4" />
    </>
  ),
  doc: (
    <>
      <path d="M6.5 3.5h7L18.5 8.5v12h-12v-17Z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9 13h6M9 16.5h4.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 20c.6-3.4 2.7-5.3 5.5-5.3s4.9 1.9 5.5 5.3" />
      <path d="M15.5 5.8a3.2 3.2 0 0 1 0 5.4" />
      <path d="M17.5 14.9c1.8.7 2.7 2.4 3 5.1" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3.5c.7 3.9 2.4 5.6 6.5 6.5-4.1.9-5.8 2.6-6.5 6.5-.7-3.9-2.4-5.6-6.5-6.5 4.1-.9 5.8-2.6 6.5-6.5Z" />
      <path d="M18.5 15.5c.35 1.9 1.15 2.7 3 3-1.85.3-2.65 1.1-3 3-.35-1.9-1.15-2.7-3-3 1.85-.3 2.65-1.1 3-3Z" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </>
  ),
  warn: (
    <>
      <path d="M12 4 21 19.5H3L12 4Z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.2" />
    </>
  ),
  code: (
    <>
      <path d="m8 8-4.5 4L8 16" />
      <path d="m16 8 4.5 4L16 16" />
      <path d="M13.5 5.5 10.5 18.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5S14.6 18.2 12 20.5c-2.6-2.3-3.9-5.1-3.9-8.5S9.4 5.8 12 3.5Z" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
      <path d="M5 11.5v5c0 1.66 3.13 3 7 3s7-1.34 7-3v-5" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h15" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </>
  ),
  fingerprint: (
    <>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.33.5 3.5 2 5.5" />
      <path d="M12 6a6 6 0 0 0-6 6c0 2.5.8 5 2 7" />
      <path d="M12 3a9 9 0 0 0-9 9c0 3.5 1.2 6.5 3 9" />
      <path d="M12 3a9 9 0 0 1 9 9c0 2-.3 3.8-.8 5.5" />
      <path d="M12 6a6 6 0 0 1 6 6c0 1.5-.3 2.8-.8 4" />
      <path d="M14 20.5c.4-1.3.6-2.7.6-4a2.6 2.6 0 0 0-.6-1.5" />
    </>
  ),
  token: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v10M9 9.5h4.5a2.5 2.5 0 0 1 0 5H9" />
      <path d="M9 12h5" />
    </>
  ),
  building: (
    <>
      <path d="M4.5 20.5V6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v14" />
      <path d="M2 20.5h20" />
      <path d="M9 20.5v-5h6v5" />
      <path d="M9 8.5h1.5M13.5 8.5H15M9 12h1.5M13.5 12H15" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 3" />
    </>
  ),
  trending: (
    <>
      <path d="M3.5 16.5 9 11l4 4 7.5-7.5" />
      <path d="M14.5 7.5H21v6.5" />
    </>
  ),
  activity: (
    <>
      <path d="M2 12h4l3-7.5 4 15 3-10 2 2.5h4" />
    </>
  ),
  lock: (
    <>
      <rect x="6" y="11" width="12" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="13.5" r="4" />
      <path d="m12 10.5 9-9" />
      <path d="M18 4.5 20 6.5" />
      <path d="M16 6.5 18 8.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12S5.5 5 12 5s10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  filter: (
    <>
      <path d="M3 6h18M7 12h10M11 18h2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13M7.5 11.5 12 16l4.5-4.5" />
      <path d="M3 18.5h18" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  chart: (
    <>
      <path d="M3.5 17.5 8.5 11l4 4.5 4.5-7 4 5" />
      <path d="M3 20.5h18" />
    </>
  ),
  hash: (
    <>
      <path d="M5.5 9.5h13M5.5 14.5h13M9.5 4.5 8 19.5M16 4.5l-1.5 15" />
    </>
  ),
  qr: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
      <path d="M13.5 13.5h3v3h-3v3h3M17.5 16.5h3v4h-3" />
      <rect x="5.5" y="5.5" width="3" height="3" fill="currentColor" stroke="none" />
      <rect x="15.5" y="5.5" width="3" height="3" fill="currentColor" stroke="none" />
      <rect x="5.5" y="15.5" width="3" height="3" fill="currentColor" stroke="none" />
    </>
  ),
  layers: (
    <>
      <path d="M12 2.5 21.5 7 12 11.5 2.5 7Z" />
      <path d="M2.5 12 12 16.5 21.5 12" />
      <path d="M2.5 17 12 21.5 21.5 17" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 14.5h4l2.5 3h4l2.5-3h4" />
      <path d="M3.5 14.5V6a1.5 1.5 0 0 1 1.5-1.5h14A1.5 1.5 0 0 1 20.5 6v8.5" />
      <path d="M9 9.5h6M9 12.5h4" />
    </>
  ),
  send: (
    <>
      <path d="M21.5 2.5 2.5 9.5l7.5 3 3 7.5 8.5-19Z" />
      <path d="M10 12.5 21.5 2.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 7A9 9 0 0 0 5.5 5.5L3.5 7.5" />
      <path d="M3.5 3.5v4h4" />
      <path d="M3.5 17a9 9 0 0 0 15 1.5l2-2" />
      <path d="M20.5 20.5v-4h-4" />
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
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      {ICON_PATHS[props.name]}
    </svg>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

type CardVariant = "default" | "elevated" | "bordered" | "ink";

const CARD_SURFACE: Record<CardVariant, string> = {
  default:  "bg-white rounded-2xl border border-slate-200/80 shadow-sm",
  elevated: "bg-white rounded-2xl border border-slate-100 shadow-md",
  bordered: "bg-white rounded-2xl border-2 border-brand-400/25 shadow-sm",
  ink:      "bg-ink rounded-2xl border border-ink-700 shadow-md text-slate-100",
};

export function Card(props: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  variant?: CardVariant;
  children: React.ReactNode;
}): JSX.Element {
  const { title, description, actions, className, variant = "default", children } = props;
  const hasHeader = Boolean(title || description || actions);
  const isInk = variant === "ink";
  return (
    <div className={`${CARD_SURFACE[variant]} ${className ?? ""}`}>
      {hasHeader && (
        <div className={`flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b ${isInk ? "border-white/10" : "border-slate-100"}`}>
          <div className="min-w-0">
            {title && (
              <h3
                className={`text-sm font-semibold leading-6 font-display ${isInk ? "text-white" : "text-slate-900"}`}
              >
                {title}
              </h3>
            )}
            {description && (
              <p className={`text-xs mt-0.5 ${isInk ? "text-slate-400" : "text-slate-500"}`}>{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────────

export function SectionHeader(props: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  badge?: string;
}): JSX.Element {
  const { title, description, actions, badge } = props;
  return (
    <div className="flex items-end justify-between gap-4 mb-5">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 font-display">{title}</h2>
          {badge && (
            <span className="inline-flex items-center rounded-full bg-brand-50 border border-brand-200/60 text-brand-700 text-[11px] font-semibold px-2.5 py-0.5">
              {badge}
            </span>
          )}
        </div>
        {description && <p className="text-sm text-slate-500 mt-0.5 leading-snug">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ─── Pill ─────────────────────────────────────────────────────────────────────

type PillTone = "ok" | "warn" | "danger" | "info" | "muted" | "brand" | "violet" | "amber";

const PILL_STYLES: Record<PillTone, string> = {
  ok:     "bg-emerald-50 text-emerald-700 border border-emerald-200/70",
  warn:   "bg-amber-50  text-amber-700  border border-amber-200/70",
  danger: "bg-red-50    text-red-700    border border-red-200/70",
  info:   "bg-sky-50    text-sky-700    border border-sky-200/70",
  muted:  "bg-slate-100 text-slate-600  border border-slate-200/70",
  brand:  "bg-brand-50  text-brand-700  border border-brand-200/70",
  violet: "bg-violet-50 text-violet-700 border border-violet-200/70",
  amber:  "bg-amber-50  text-amber-700  border border-amber-200/70",
};

const PILL_DOTS: Record<PillTone, string> = {
  ok:     "bg-emerald-500",
  warn:   "bg-amber-500",
  danger: "bg-red-500",
  info:   "bg-sky-500",
  muted:  "bg-slate-400",
  brand:  "bg-brand-500",
  violet: "bg-violet-500",
  amber:  "bg-amber-500",
};

export function Pill(props: {
  tone: PillTone;
  children: React.ReactNode;
  dot?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${PILL_STYLES[props.tone]}`}
    >
      {props.dot && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PILL_DOTS[props.tone]}`} aria-hidden="true" />
      )}
      {props.children}
    </span>
  );
}

// ─── Tag ──────────────────────────────────────────────────────────────────────

export function Tag(props: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ${props.className ?? ""}`}>
      {props.children}
    </span>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
  trend?: { direction: "up" | "down" | "flat"; label: string };
}): JSX.Element {
  const { label, value, sub, icon, trend } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-start gap-3 group">
      {icon && (
        <div className="shrink-0 w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center ring-1 ring-brand-100 group-hover:ring-brand-200 transition">
          <Icon name={icon} className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{label}</div>
        <div className="text-xl font-bold text-slate-900 leading-7 truncate font-display font-data">{value}</div>
        <div className="flex items-center gap-2 mt-0.5">
          {sub && <div className="text-xs text-slate-400 truncate">{sub}</div>}
          {trend && (
            <span className={`text-[10px] font-semibold ${
              trend.direction === "up"   ? "text-emerald-600" :
              trend.direction === "down" ? "text-red-500" : "text-slate-400"
            }`}>
              {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"} {trend.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MetricBlock ──────────────────────────────────────────────────────────────

export function MetricBlock(props: {
  label: string;
  value: string | number;
  tone?: "default" | "emerald" | "red" | "amber" | "violet" | "brand";
  className?: string;
}): JSX.Element {
  const TONE_CLASSES: Record<string, string> = {
    default: "text-slate-900",
    emerald: "text-emerald-600",
    red:     "text-red-600",
    amber:   "text-amber-600",
    violet:  "text-violet-600",
    brand:   "text-brand-600",
  };
  const tone = props.tone ?? "default";
  return (
    <div className={`flex flex-col gap-0.5 ${props.className ?? ""}`}>
      <div className={`text-2xl font-bold tabular-nums leading-none font-display ${TONE_CLASSES[tone]}`}>
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{props.label}</div>
    </div>
  );
}

// ─── LiveDot ──────────────────────────────────────────────────────────────────

export function LiveDot(props: { tone?: "green" | "amber" | "red" | "brand" }): JSX.Element {
  const COLORS = {
    green: "bg-emerald-500",
    amber: "bg-amber-400",
    red:   "bg-red-500",
    brand: "bg-brand-500",
  };
  const color = COLORS[props.tone ?? "green"];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden="true">
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color} opacity-60`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${color}`} />
    </span>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

export function EmptyState(props: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): JSX.Element {
  const { icon, title, hint, action } = props;
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-4 ring-1 ring-slate-200">
        <Icon name={icon ?? "spark"} className="w-7 h-7" />
      </div>
      <div className="text-sm font-semibold text-slate-700 font-display">{title}</div>
      {hint && <p className="text-xs text-slate-500 mt-1.5 max-w-xs leading-relaxed">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ─── CopyBlock ────────────────────────────────────────────────────────────────

export function CopyBlock(props: { code: string; language?: string; className?: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.code);
      setState("ok");
      window.setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("fail");
    }
  }

  return (
    <div className={`relative group ${props.className ?? ""}`}>
      <pre className="overflow-x-auto rounded-xl bg-slate-900 text-slate-100 font-mono text-xs p-4 pr-20 leading-5">
        <code className="font-data">{props.code}</code>
      </pre>
      {props.language && (
        <span className="absolute left-3 -top-2.5 rounded-md bg-slate-700 text-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide border border-slate-600">
          {props.language}
        </span>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-2.5 right-2.5 rounded-lg border border-slate-600 bg-slate-800/90 text-slate-200 px-2.5 py-1 text-[11px] font-semibold hover:bg-slate-700 transition"
      >
        {state === "ok" ? "Copied ✓" : state === "fail" ? "Failed" : "Copy"}
      </button>
      {state === "fail" && (
        <p className="text-[11px] text-red-400 mt-1.5">
          Clipboard unavailable — select the block and copy manually.
        </p>
      )}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

export function Skeleton(props: { lines?: number; className?: string }): JSX.Element {
  const lines = props.lines ?? 3;
  return (
    <div className={`animate-pulse space-y-3 ${props.className ?? ""}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3.5 rounded-lg bg-slate-100"
          style={{ width: i === lines - 1 ? "55%" : i % 2 === 0 ? "100%" : "85%" }}
        />
      ))}
    </div>
  );
}

// ─── DataBadge — truncated hash/address with copy ────────────────────────────

export function DataBadge(props: { value: string; chars?: number }): JSX.Element {
  const chars = props.chars ?? 8;
  const short = props.value.length > chars * 2 + 3
    ? `${props.value.slice(0, chars)}…${props.value.slice(-4)}`
    : props.value;
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* ignore */ }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={props.value}
      className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 hover:bg-slate-200 px-2 py-0.5 transition"
    >
      <span className="font-data text-[11px] text-slate-600 tracking-tight">{short}</span>
      <Icon name={copied ? "check" : "doc"} className="w-3 h-3 text-slate-400 shrink-0" />
    </button>
  );
}
