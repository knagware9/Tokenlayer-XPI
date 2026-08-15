/**
 * Fan-out tenancy (EN-C): which endpoints receive which events. Pure, so the
 * whole rule can be pinned by unit tests rather than inferred from route
 * behaviour — this predicate is the only thing standing between one org's events
 * and another org's endpoint.
 */
import type { EventRecord, WebhookEndpointRecord } from "../persistence/types/index.js";

/**
 * Does this endpoint receive this event?
 *
 * The org rule is deliberately a DISJUNCTION OF TWO SEPARATE RULES, not an
 * equality. `ep.orgId === ev.orgId` looks equivalent and is not: a platform-
 * scope event (orgId null) would then match every ORG-scoped endpoint whose
 * orgId happened to be null, because `null === null` is true. The two cases mean
 * genuinely different things — "this endpoint belongs to the platform, so it
 * sees everything" and "this endpoint belongs to org X, so it sees org X's
 * events and nothing else" — and collapsing them into one comparison only works
 * by accident of representation.
 *
 * That `null === null` shape is exactly the class of bug EN-B's final
 * whole-branch review found in the user-management predicate, where an unscoped
 * service user matched every PlatformAdmin and could delete them. Two different
 * rules, spelled out separately. The "null === null trap" test pins both halves:
 * platform-endpoint/platform-event true, org-endpoint/platform-event false.
 */
export function endpointMatches(ep: WebhookEndpointRecord, ev: EventRecord): boolean {
  // Lifecycle first — a disabled or soft-deleted endpoint is not a destination,
  // whatever it is subscribed to.
  if (ep.status !== "active" || ep.deletedAt !== null) return false;

  const orgOk = ep.orgId === null // platform-scope: sees everything
    || (ev.orgId !== null && ep.orgId === ev.orgId); // org-scope: only its own
  if (!orgOk) return false;

  // MODE IS EQUALITY, WHERE ORG (directly above) IS A DISJUNCTION — and the two
  // rules sitting side by side and behaving differently is precisely what a
  // later reader will get wrong, so: a platform-scope endpoint LEGITIMATELY
  // spans orgs, which is why that rule needed a second branch. NOTHING
  // legitimately spans modes. There is no "sees both environments" endpoint to
  // write a second branch for, and inventing one would rebuild the design this
  // feature rejected — "one endpoint, filter on a `mode` field" — where the
  // burden of remembering the check falls on every consumer and forgetting it
  // is silent. Isolation is structural instead: a sandbox issuance has NO ROUTE
  // to a production handler, so it cannot be processed as a real credential by
  // an integrator who never thought about modes at all.
  if (ep.mode !== ev.mode) return false;

  // A null filter means "no filter". Only a set filter narrows, and it narrows
  // to an exact match — a use-case-scoped endpoint must not receive an event
  // that carries no use case at all.
  if (ep.useCaseKey !== null && ep.useCaseKey !== ev.useCaseKey) return false;

  return ep.eventTypes.includes("*") || ep.eventTypes.includes(ev.type);
}
