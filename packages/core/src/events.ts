/**
 * The closed v1 event catalog (EN-C). Shared by the API (emit + subscribe
 * validation) and the web console (the subscription checkboxes), so the
 * vocabulary lives in exactly one place — the same shape as API_SCOPES.
 *
 * DELIBERATELY EXCLUDED from v1: organization.*, member.*, apikey.* and
 * capability changes. Those are governance facts about an org rather than
 * integration events, and each needs its own tenancy argument before it is
 * shipped to a third party. Adding one later is a catalog entry plus an emit
 * site — a small, reviewable change.
 */
import { PolicyError } from "./errors.js";

export const EVENT_TYPES = [
  // Identity
  "credential.issued",
  "credential.accepted",
  "credential.rejected",
  "credential.revoked",
  "verification.requested",
  "verification.completed",
  // Tokenization
  "asset.issued",
  "asset.transferred",
  "asset.redeemed",
  // Governance
  "proposal.executed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The same closed set at runtime, built once: its input is a module constant. */
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && EVENT_TYPE_SET.has(v);
}

/** A subscription is `["*"]` or a set of known types. Never a partial wildcard. */
export type EventSubscription = EventType | "*";

export function validateEventTypes(input: unknown): EventSubscription[] {
  if (!Array.isArray(input)) throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes must be an array");
  if (input.length === 0) throw new PolicyError("INVALID_EVENT_TYPES", "subscribe to at least one event type");
  for (const t of input) {
    if (typeof t !== "string") throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes must be strings");
    if (t === "*") continue;
    if (!EVENT_TYPE_SET.has(t)) throw new PolicyError("UNKNOWN_EVENT_TYPE", `unknown event type '${t}'`);
  }
  if (new Set(input).size !== input.length) throw new PolicyError("INVALID_EVENT_TYPES", "eventTypes contain duplicates");
  return [...input] as EventSubscription[];
}
