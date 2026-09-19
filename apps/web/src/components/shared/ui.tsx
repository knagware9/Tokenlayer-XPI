import { useState } from "react";

// ─── staggerClass ─────────────────────────────────────────────────────────────

/**
 * `animate-slide-up`, optionally with a numbered `stagger-N` delay class
 * (index.css defines stagger-1 through stagger-7 — anything outside that
 * range clamps to the nearest end rather than emitting a class that doesn't
 * exist). Extracted because the exact same string was being built
 * independently in Dashboard.tsx's Stat and IdentityDashboard.tsx's Tile.
 */
export function staggerClass(n?: number): string {
  if (!n || n <= 0) return "animate-slide-up";
  const clamped = Math.min(n, 7);
  return `animate-slide-up stagger-${clamped}`;
}

// Shared UI primitives for the TokenLayer console.
// Fonts: Inter (headings/body) · JetBrains Mono (data)
// All components are zero-dependency beyond Tailwind + hand-drawn SVG.
//
// Design rules this file follows (see docs/superpowers for the full spec):
//  - One bold element per screen; everything else (metadata, status,
//    timestamps) drops to `text-muted` at 0.75-0.8rem.
//  - Hairlines, not boxes: `border-border` + whitespace by default. A filled
//    `bg-elevated`/`bg-surface` card is reserved for something that is
//    genuinely a separate object — never nest one inside another.
//  - Every color reads the semantic tokens (`bg-surface`, `text-fg`,
//    `text-muted`, `border-border`, `bg-danger`/`warning`/`success`) so light
//    and dark both work and an org's `--brand-*` override still flows through
//    `--primary`. No hardcoded slate/white/emerald literals below.

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
  default:  "bg-surface rounded-2xl border border-border/80 shadow-card",
  elevated: "bg-surface rounded-2xl border border-border/60 shadow-md",
  bordered: "bg-surface rounded-2xl border-2 border-brand-400/25 shadow-card",
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
        <div className={`flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b ${isInk ? "border-white/10" : "border-border"}`}>
          <div className="min-w-0">
            {title && (
              <h3
                className={`text-sm font-semibold leading-6 font-display ${isInk ? "text-white" : "text-fg"}`}
              >
                {title}
              </h3>
            )}
            {description && (
              <p className={`text-xs mt-0.5 ${isInk ? "text-slate-400" : "text-muted"}`}>{description}</p>
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
    // `flex-wrap`, and NO `min-w-0` on the text column: a flex child that can
    // shrink to zero never triggers wrap (the algorithm always prefers
    // shrinking it over moving a sibling to a new line), which is exactly what
    // squeezed a real description into an unreadable one-word-per-line column
    // whenever `actions` carried two buttons instead of none. Letting the text
    // column keep its natural (word-boundary) min width means `actions` wraps
    // below it instead, once there truly isn't room for both on one line.
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 mb-5">
      <div>
        <div className="flex items-center gap-2.5">
          <h2 className="text-xl font-bold tracking-tight text-fg font-display">{title}</h2>
          {badge && (
            <span className="inline-flex items-center rounded-full bg-brand-50 border border-brand-200/60 text-brand-700 text-[11px] font-semibold px-2.5 py-0.5">
              {badge}
            </span>
          )}
        </div>
        {description && <p className="text-sm text-muted mt-0.5 leading-snug prose-measure">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ─── Pill ─────────────────────────────────────────────────────────────────────

type PillTone = "ok" | "warn" | "danger" | "info" | "muted" | "brand" | "violet" | "amber";

// `ok`/`warn`/`danger` read the semantic success/warning/danger tokens (the
// same raw value in both themes, so a 10%-opacity tint stays legible on a
// dark surface too). `info`/`muted`/`brand`/`violet`/`amber` are decorative
// hues, not status — they keep their own Tailwind scale.
const PILL_STYLES: Record<PillTone, string> = {
  ok:     "bg-success/10 text-success border border-success/25",
  warn:   "bg-warning/10 text-warning border border-warning/25",
  danger: "bg-danger/10  text-danger  border border-danger/25",
  info:   "bg-sky-500/10    text-sky-600    border border-sky-500/25",
  muted:  "bg-elevated   text-muted   border border-border",
  brand:  "bg-brand-50   text-brand-700 border border-brand-200/70",
  violet: "bg-violet-500/10 text-violet-600 border border-violet-500/25",
  amber:  "bg-warning/10 text-warning border border-warning/25",
};

const PILL_DOTS: Record<PillTone, string> = {
  ok:     "bg-success",
  warn:   "bg-warning",
  danger: "bg-danger",
  info:   "bg-sky-500",
  muted:  "bg-muted",
  brand:  "bg-brand-500",
  violet: "bg-violet-500",
  amber:  "bg-warning",
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
    <span className={`inline-flex items-center rounded-md bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted ${props.className ?? ""}`}>
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
  /** "primary" marks this as the screen's headline number — larger value
   *  text, bordered treatment. Defaults to "default" (today's exact look). */
  emphasis?: "primary" | "default";
}): JSX.Element {
  const { label, value, sub, icon, trend, emphasis = "default" } = props;
  const isPrimary = emphasis === "primary";
  return (
    <div
      className={`rounded-2xl p-4 flex items-start gap-3 group ${
        isPrimary
          ? "bg-surface border-2 border-brand-400/25 shadow-card"
          : "bg-surface border border-border/80 shadow-card"
      }`}
    >
      {icon && (
        <div className="shrink-0 w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center ring-1 ring-brand-100 group-hover:ring-brand-200 transition">
          <Icon name={icon} className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[0.75rem] font-medium text-muted mb-0.5">{label}</div>
        <div
          className={`font-bold text-fg leading-7 truncate font-display font-data animate-count-in ${
            isPrimary ? "text-3xl" : "text-xl"
          }`}
        >
          {value}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {sub && <div className="text-[0.75rem] text-muted truncate">{sub}</div>}
          {trend && (
            <span className={`text-[0.75rem] font-semibold ${
              trend.direction === "up"   ? "text-success" :
              trend.direction === "down" ? "text-danger" : "text-muted"
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
    default: "text-fg",
    emerald: "text-success",
    red:     "text-danger",
    amber:   "text-warning",
    violet:  "text-violet-600",
    brand:   "text-brand-600",
  };
  const tone = props.tone ?? "default";
  return (
    <div className={`flex flex-col gap-0.5 ${props.className ?? ""}`}>
      <div className={`text-2xl font-bold tabular-nums leading-none font-display animate-count-in ${TONE_CLASSES[tone]}`}>
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      <div className="text-[0.75rem] font-medium text-muted">{props.label}</div>
    </div>
  );
}

// ─── LiveDot ──────────────────────────────────────────────────────────────────

export function LiveDot(props: { tone?: "green" | "amber" | "red" | "brand" }): JSX.Element {
  const COLORS = {
    green: "bg-success",
    amber: "bg-warning",
    red:   "bg-danger",
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
      <div className="w-14 h-14 rounded-2xl bg-elevated text-muted flex items-center justify-center mb-4 ring-1 ring-border">
        <Icon name={icon ?? "spark"} className="w-7 h-7" />
      </div>
      <div className="text-sm font-semibold text-fg font-display">{title}</div>
      {hint && <p className="text-xs text-muted mt-1.5 max-w-xs leading-relaxed">{hint}</p>}
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
          className="h-3.5 rounded-lg bg-elevated"
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
      className="inline-flex items-center gap-1.5 rounded-md bg-elevated hover:bg-border/60 px-2 py-0.5 transition"
    >
      <span className="font-data text-[11px] text-muted tracking-tight">{short}</span>
      <Icon name={copied ? "check" : "doc"} className="w-3 h-3 text-muted shrink-0" />
    </button>
  );
}

// ─── Pager ────────────────────────────────────────────────────────────────────

/** Prev/Next pager for a client-side-filtered table. `total` is the row count AFTER filtering, before slicing to the page. */
export function Pager(props: { page: number; pageSize: number; total: number; onPage: (p: number) => void }): JSX.Element | null {
  const { page, pageSize, total, onPage } = props;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-border text-xs text-muted">
      <span>{from}–{to} of {total}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="rounded-lg border border-border px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-elevated">Prev</button>
        <span className="tabular-nums">Page {page} of {pageCount}</span>
        <button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}
          className="rounded-lg border border-border px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-elevated">Next</button>
      </div>
    </div>
  );
}

// ─── TableShell ───────────────────────────────────────────────────────────────

/**
 * Wraps an existing <table> (does not replace its markup) to apply
 * consistent header styling, tabular-nums on numeric cells, and
 * alternating-row hover — without every screen re-deriving the same
 * table CSS by hand. Adopted incrementally, screen by screen (tasks 7-9);
 * deliberately not a data-driven <Table rows columns> abstraction — that
 * would mean rewriting every table call site in one pass.
 *
 * Sticky header: the wrapper div bounds its own height
 * (`max-h-[420px] overflow-y-auto`, alongside `overflow-x-auto` for narrow
 * viewports) so it is the nearest scrolling ancestor for `[&_thead_th]:sticky`
 * and actually has something to stick against. The cap is generous enough
 * that every adopter's paginated tables (5-8 rows) never reach it — the box
 * just sizes to its content and no internal scrollbar appears, so this is a
 * no-op for them. Only a table with more rows than fit in 420px (e.g.
 * AssetDetail's unpaginated "Open asks" list) starts scrolling internally,
 * at which point its header visibly pins to the top of the table's own box
 * while the rest of the page scrolls normally around it. Verified live by
 * padding a table past the cap and scrolling: header stays pinned, and
 * `getComputedStyle().position === "sticky"` alone is not sufficient
 * evidence of this working (it also reported "sticky" back when nothing
 * visibly stuck).
 *
 * Per-cell padding has real CSS specificity: `[&_td]:px-3 [&_td]:py-2.5`
 * (an arbitrary-variant descendant selector, ~0,1,1) beats a plain utility
 * class like `py-6` placed directly on a `<td>` by a call site (~0,1,0),
 * regardless of class order. A call site that needs different cell padding
 * or alignment must use an `!`-important utility (e.g. `!py-6`) to win —
 * see IdentityDashboard.tsx's and AssetDetail.tsx's empty-state rows for
 * the pattern.
 */
export function TableShell(props: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`overflow-x-auto overflow-y-auto max-h-[420px] rounded-xl border border-border ${props.className ?? ""}`}>
      <table className="w-full text-xs [&_thead]:bg-elevated/95 [&_thead]:backdrop-blur-sm [&_thead]:text-[0.75rem] [&_thead]:text-muted [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:bg-elevated/95 [&_thead_th]:backdrop-blur-sm [&_th]:text-left [&_th]:font-semibold [&_th]:px-3 [&_th]:py-2.5 [&_tbody_tr]:border-t [&_tbody_tr]:border-border [&_tbody_tr:hover]:bg-elevated/70 [&_tbody_tr]:transition-colors [&_td]:px-3 [&_td]:py-2.5 [&_td.num]:text-right [&_td.num]:tabular-nums [&_td.num]:font-data">
        {props.children}
      </table>
    </div>
  );
}
