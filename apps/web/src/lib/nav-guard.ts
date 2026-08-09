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
 * Deliberately a module singleton rather than context: exactly one panel is
 * mounted at a time, so there is never more than one guard to hold, and threading
 * a provider through the shell for a single call site would be the larger change.
 */

let guard: (() => boolean) | null = null;

/**
 * Register a confirmation to run before the shell navigates. Returns the
 * unregister function — call it from the effect cleanup. The identity check on
 * unregister means a late cleanup can never clear a NEWER guard.
 */
export function setNavGuard(fn: () => boolean): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/**
 * True when navigation may proceed. With no guard registered — the normal case
 * for every other panel — this is unconditionally true.
 */
export function confirmNavigation(): boolean {
  return guard === null || guard();
}
