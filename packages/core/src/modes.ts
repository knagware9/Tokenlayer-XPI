/**
 * Live vs test (EN-D2). A `tl_test_` key acts only on sandbox use cases and a
 * `tl_live_` key only on real ones.
 *
 * ISOLATION REUSES `useCaseKey`. Assets, credentials, verification requests,
 * proposals and events carry NO mode of their own — their mode is the mode of
 * the use case they belong to, and they are already scoped by it. A per-row
 * flag would create a second tenancy dimension parallel to `orgId`, and a
 * tenancy predicate has produced a finding on every sub-project of this
 * program so far.
 */
export type ResourceMode = "live" | "test";

/** The dedicated always-simulated chain. Never promoted to real by any env. */
export const SANDBOX_CHAIN_ID = "sandbox";

/**
 * May a principal act on a resource?
 *
 * Written as EQUALITY, not as a guard against one direction: a live key
 * reaching sandbox data and a test key reaching live data are both wrong, and
 * neither is the safe one to forget.
 *
 * `actor === null` is A HUMAN SESSION, which has no mode and may act on both —
 * an OrgAdmin has to be able to configure and inspect their own sandbox. That
 * is the single asymmetry in this design and the thing most likely to be got
 * wrong later, so it is explicit here rather than implied at a call site.
 */
export function modeAllows(actor: ResourceMode | null, resource: ResourceMode): boolean {
  return actor === null || actor === resource;
}

/** The chain rule, in both directions. */
export function sandboxChainsValid(sandbox: boolean, allowedChainIds: readonly string[]): boolean {
  if (allowedChainIds.length === 0) return false;
  return sandbox
    ? allowedChainIds.every((c) => c === SANDBOX_CHAIN_ID)
    : allowedChainIds.every((c) => c !== SANDBOX_CHAIN_ID);
}
