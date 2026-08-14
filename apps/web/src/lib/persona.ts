/**
 * THE APP THIS BUNDLE IS.
 *
 * One codebase, six deployable apps. `VITE_APP_PERSONA` is baked in at build
 * time (Vite replaces it statically), so the wallet image and the issuer console
 * image are different artifacts built from the same source, and neither carries
 * a switch that could turn it into the other at runtime.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 *
 * This narrows the SHELL: which nav entries the app is willing to render. It is
 * not a permission system and must never be mistaken for one. Three gates sit
 * beneath it and none of them moves:
 *
 *   1. the persona EDGE container refuses the route on the network,
 *   2. the API's domain gate 404s the other product,
 *   3. role RBAC decides what this particular user may do.
 *
 * So this can only ever SUBTRACT from what a user would already have been shown.
 * `narrowToPersona` is written as an intersection for exactly that reason: if a
 * future persona lists a surface its user has no role for, the surface still
 * does not appear. A widening here would be a UI lie — buttons that render and
 * then fail at the edge — rather than a privilege escalation.
 *
 * UNSET IS THE FULL APP. A build with no persona behaves exactly as the app
 * always has, which is what keeps the single-container and two-container
 * topologies working unchanged.
 */
import { PERSONAS, personaByKey, type WebPersona } from "../personas.js";

export type { WebPersona as PersonaDef };

/** Anything with an `id` — NavItem, without importing the component's types. */
export interface Identified { id: string }

/**
 * Resolve a build-time value to a persona.
 *
 * An UNRECOGNISED value returns null — the full app — rather than an empty one.
 * The alternative fails in the worst way available: a typo in a compose file
 * ships a container whose sidebar is blank and whose landing view does not
 * exist, and the operator's only clue is that nothing renders. Loud is better,
 * so `personaConfigError` reports the typo for the shell to surface.
 */
export function resolvePersona(raw: string | undefined | null): WebPersona | null {
  const key = (raw ?? "").trim();
  if (!key) return null;
  return personaByKey(key) ?? null;
}

/** A message when the configured persona is not one we know; null when fine. */
export function personaConfigError(raw: string | undefined | null): string | null {
  const key = (raw ?? "").trim();
  if (!key || personaByKey(key)) return null;
  return `Unknown VITE_APP_PERSONA '${key}'. Known personas: ${PERSONAS.map((p) => p.key).join(", ")}. ` +
    "Serving the full application instead.";
}

/**
 * Keep only the nav items this persona's app serves.
 *
 * INTERSECTION, never union: `items` is what the user's role and the enabled
 * domains already allowed, and this can only remove from it.
 */
export function narrowToPersona<T extends Identified>(items: readonly T[], persona: WebPersona | null): T[] {
  if (!persona) return [...items];
  const allowed = new Set(persona.surfaces);
  return items.filter((i) => allowed.has(i.id));
}

/**
 * Where this app should open.
 *
 * The persona's preferred landing view if it survived narrowing, else the first
 * item that did. Falling back matters: a Verifier-role user on the issuer
 * console has no `identity` surface, and opening on a view they cannot see would
 * render an empty frame.
 */
export function landingView<T extends Identified>(items: readonly T[], persona: WebPersona | null, fallback: string): string {
  if (!persona) return fallback;
  const ids = new Set(items.map((i) => i.id));
  if (ids.has(persona.defaultView)) return persona.defaultView;
  const first = items.find((i) => i.id !== "logout" && i.id !== "back");
  return first?.id ?? fallback;
}

/** The persona this bundle was built as, read once from the build-time env. */
export function activePersona(): WebPersona | null {
  return resolvePersona((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_APP_PERSONA);
}

/** The persona's own name, for the shell's header and the browser title. */
export function personaTitle(persona: WebPersona | null, fallback: string): string {
  return persona ? persona.label : fallback;
}
