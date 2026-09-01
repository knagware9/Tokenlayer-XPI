/**
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `scrubEvent` — the web app does
 * not depend on `@tokenlayer/core` (it ships as a standalone browser bundle;
 * see personas.ts and types.ts for the same pattern). Keep this in sync with
 * packages/core/src/shared/pii-scrub.ts if the deny-list changes.
 *
 * Redacts PII/KYC data from error-tracking events (Sentry) before they leave
 * the browser. Matched case-insensitively as a substring against object keys,
 * not by exact schema field name, so it also catches nested/renamed variants
 * (e.g. `buyerEmail`, `kycDetails`).
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "jwt",
  "email",
  "phone",
  "ssn",
  "aadhaar",
  "pan",
  "passport",
  "dob",
  "kyc",
  "address",
  "bankaccount",
  "walletkey",
  "privatekey",
  "mnemonic",
  "cardnumber",
  "cvv",
];

const REDACTED = "[Redacted]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrubValue(v, depth + 1);
  }
  return out;
}

export interface ScrubbableEvent {
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  request?: { data?: unknown; query_string?: unknown; cookies?: unknown; headers?: Record<string, unknown> };
  breadcrumbs?: { data?: Record<string, unknown> }[];
  user?: unknown;
}

/**
 * `beforeSend`-style scrub — belt-and-suspenders on top of `sendDefaultPii:
 * false` and never calling `setUser()`. Catches PII that landed in `extra`,
 * a captured request, or a breadcrumb (e.g. a fetch call carrying a KYC
 * payload).
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const scrubbed: ScrubbableEvent = { ...event };
  if (scrubbed.extra) scrubbed.extra = scrubValue(scrubbed.extra, 0) as Record<string, unknown>;
  if (scrubbed.contexts) scrubbed.contexts = scrubValue(scrubbed.contexts, 0) as Record<string, unknown>;
  if (scrubbed.request) {
    scrubbed.request = {
      ...scrubbed.request,
      data: scrubbed.request.data !== undefined ? scrubValue(scrubbed.request.data, 0) : undefined,
      cookies: undefined,
      headers: scrubbed.request.headers ? (scrubValue(scrubbed.request.headers, 0) as Record<string, unknown>) : undefined,
    };
  }
  if (scrubbed.breadcrumbs) {
    scrubbed.breadcrumbs = scrubbed.breadcrumbs.map((b) =>
      b.data ? { ...b, data: scrubValue(b.data, 0) as Record<string, unknown> } : b,
    );
  }
  scrubbed.user = undefined;
  return { ...event, ...scrubbed } as T;
}
