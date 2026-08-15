/**
 * A single "leaving this screen destroys something you cannot get back" gate.
 *
 * The console renders ONE panel at a time (App.tsx picks a panel from the active
 * nav id), so a sidebar click unmounts whatever is currently on screen. For every
 * panel but one that is free. The Developers panel holds a one-time API key
 * secret in component state and nowhere else — no route returns it again — so for
 * that panel an unmount is a permanent discard, and a stray click must not be
 * able to cause it silently.
 *
 * Deliberately a module singleton rather than context: threading a provider
 * through the shell for a couple of call sites would be the larger change.
 *
 * A SET, NOT A SINGLE SLOT — and the difference is a real bug, not tidiness.
 * The Developers panel now hosts TWO surfaces that each hold a one-time secret
 * (the API key and a webhook signing secret), so both can have a live guard at
 * once. With a single slot the second registration silently replaced the first,
 * and releasing the second (acknowledging the webhook secret) left NO guard
 * registered while the API key secret was still unacknowledged — the exact
 * silent loss this module exists to prevent. Holding every live guard makes the
 * answer independent of the order they were registered or released in.
 */

const guards = new Set<() => boolean>();

/**
 * Register a confirmation to run before the shell navigates. Returns the
 * unregister function — call it from the effect cleanup. Unregistering removes
 * only THIS guard, so a late cleanup can never clear a newer one.
 */
export function setNavGuard(fn: () => boolean): () => void {
  guards.add(fn);
  return () => {
    guards.delete(fn);
  };
}

/**
 * True when navigation may proceed — every registered guard must consent. With
 * none registered, the normal case for every other panel, this is
 * unconditionally true.
 *
 * SHORT-CIRCUITS on the first refusal: a guard typically shows a `confirm()`
 * dialog, and once the operator has declined one there is nothing to gain by
 * asking about the rest. Iterates a copy, so a guard that unregisters itself
 * mid-loop cannot disturb the iteration.
 */
export function confirmNavigation(): boolean {
  for (const guard of [...guards]) {
    if (!guard()) return false;
  }
  return true;
}
