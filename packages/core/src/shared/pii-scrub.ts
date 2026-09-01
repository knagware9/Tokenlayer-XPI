/**
 * Field-name deny-list used to redact PII/KYC data from error-tracking events
 * (Sentry) before they leave the process. Matched case-insensitively as a
 * substring against object keys, not by exact schema field name, so it also
 * catches nested/renamed variants (e.g. `buyerEmail`, `kycDetails`).
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

/**
 * Recursively redacts values whose key matches the deny-list. Depth is
 * bounded to guard against pathological/circular structures in error
 * payloads — this only ever runs on data about to leave the process, so a
 * missed nested field is worse than a truncated one.
 */
function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrubValue(v, depth + 1);
  }
  return out;
}

/**
 * Minimal shape covering the parts of a Sentry event that can carry
 * request/user data — deliberately untyped against `@sentry/*` so this stays
 * dependency-free and usable from both the API (Node) and the web app
 * (browser) without pulling either SDK's types into `@tokenlayer/core`.
 */
export interface ScrubbableEvent {
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  request?: { data?: unknown; query_string?: unknown; cookies?: unknown; headers?: Record<string, unknown> };
  breadcrumbs?: { data?: Record<string, unknown> }[];
  user?: unknown;
}

/**
 * `beforeSend`-style scrub: strips known PII/KYC fields before an error event
 * leaves this process for the error-tracking backend. Belt-and-suspenders on
 * top of `sendDefaultPii: false` and never calling `setUser()` — this is what
 * catches PII a caller logged into `extra`, or that landed in a captured
 * request or breadcrumb.
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
  scrubbed.user = undefined; // never forward user identity, even if something upstream set it
  return { ...event, ...scrubbed } as T;
}
