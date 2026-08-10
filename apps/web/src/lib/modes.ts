/**
 * The EN-D2 live/test vocabulary, for the console.
 *
 * A DELIBERATE MIRROR of `@tokenlayer/core`'s `modes.ts`, on exactly the terms
 * `API_SCOPES` and `EVENT_TYPES` are mirrored in types.ts: the web app has no
 * dependency on core, so this file is updated by hand. Nothing here is an
 * authority — the server re-checks every rule and answers 400
 * `INVALID_SANDBOX_CHAINS`, 409 `SANDBOX_IMMUTABLE` or 403 `WRONG_MODE`. What
 * it buys is that the builder never OFFERS a combination the server refuses,
 * which is the defect class EN-B's review found twice (a Rotate button on a key
 * that could not rotate; a role picker defaulting to maximum privilege).
 *
 * Pure: no React, no fetch. The two rendering decisions that belong to a mode
 * (its label and its tone) live here too, so no surface can invent a third way
 * of saying "this is not real".
 */

/** A principal's or a resource's environment. Mirrors core's `ResourceMode`. */
export type ResourceMode = "live" | "test";

/** The dedicated always-simulated chain. Never promoted to real by any env. */
export const SANDBOX_CHAIN_ID = "sandbox";

/**
 * The public markers a secret can carry — mirrors the API's
 * `KEY_PREFIX_MARKERS` (apps/api/src/api-keys.ts). Display-only: the server
 * parses the real marker and refuses anything else, and it additionally checks
 * the mode the STRING claims against the mode on the ROW.
 *
 * Typed as a TOTAL record over `ResourceMode`, so a third mode added to the
 * type above fails the build here rather than rendering an empty prefix.
 */
export const KEY_MARKERS: Record<ResourceMode, string> = { live: "tl_live_", test: "tl_test_" };

export function keyMarker(mode: ResourceMode): string {
  return KEY_MARKERS[mode];
}

/**
 * How an environment is NAMED, everywhere.
 *
 * "Sandbox" rather than "Test" on purpose: neither label contains the other, so
 * the two cannot be confused at the size a pill renders at, and "Sandbox" is
 * the word the API's own errors and the clone-to-live route use.
 */
export const MODE_LABELS: Record<ResourceMode, string> = { live: "Live", test: "Sandbox" };

export function modeLabel(mode: ResourceMode): string {
  return MODE_LABELS[mode];
}

/**
 * How an environment LOOKS. The two must differ — a sandbox row that is the
 * same colour as a live one is the thing a reader's eye slides past, which is
 * the whole failure this task exists to prevent.
 */
export function modeTone(mode: ResourceMode): "muted" | "warn" {
  return mode === "test" ? "warn" : "muted";
}

/** One plain line per environment, for a reader who has just met the pill. */
export const MODE_BLURBS: Record<ResourceMode, string> = {
  live: "Real ledgers. Everything issued here is a real record.",
  test: "A simulated in-memory ledger. Nothing issued here is real, and none of it can be moved to the live environment.",
};

export function modeBlurb(mode: ResourceMode): string {
  return MODE_BLURBS[mode];
}

/**
 * A use case's environment, read off its `sandbox` flag.
 *
 * ABSENT MEANS LIVE, deliberately: `sandbox` is a column with a DB default, so
 * it is missing from every row that predates EN-D2, and the server's own
 * `modeGate` reads `useCase?.sandbox ? "test" : "live"`. Guessing the other way
 * would label the entire existing catalog as fake.
 */
export function modeOf(sandbox: boolean | null | undefined): ResourceMode {
  return sandbox === true ? "test" : "live";
}

/**
 * The ledgers a use case in this environment may be OFFERED.
 *
 * THE RULE THAT STOPS THE BUILDER PRODUCING A COMBINATION THE SERVER REFUSES.
 * A sandbox use case may allow only the sandbox chain; a live one may never
 * name it. Both directions matter and neither is the safe one to forget: a
 * sandbox use case on Besu would mint real tokens under a programme whose whole
 * contract is that nothing it does is real, and a live use case on the sandbox
 * chain would give a real programme an in-memory register.
 *
 * When the catalog carries no sandbox chain (a deployment that predates EN-D2)
 * this returns NOTHING rather than falling back to the first live chain — an
 * empty picker is a visible problem, a silently wrong one is not.
 */
export function chainChoicesFor<T extends { id: string }>(sandbox: boolean, allChains: readonly T[]): T[] {
  return allChains.filter((c) => (sandbox ? c.id === SANDBOX_CHAIN_ID : c.id !== SANDBOX_CHAIN_ID));
}

/** The chain rule itself, in both directions — mirrors core's `sandboxChainsValid`. */
export function sandboxChainsValid(sandbox: boolean, allowedChainIds: readonly string[]): boolean {
  if (allowedChainIds.length === 0) return false;
  return sandbox
    ? allowedChainIds.every((c) => c === SANDBOX_CHAIN_ID)
    : allowedChainIds.every((c) => c !== SANDBOX_CHAIN_ID);
}

/** The environment-and-ledger half of a use-case draft: what the builder holds. */
export interface UseCaseModeDraft {
  sandbox: boolean;
  allowedChainIds: readonly string[];
  defaultChainId: string;
}

/**
 * A discriminated union rather than a message-or-null, on the same terms as
 * `checkKeyDraft` and `checkWebhookDraft`: the `ok` arm CARRIES the validated
 * values, so a draft whose chains and environment disagree has no
 * `allowedChainIds` to hand `api.createUseCase` and therefore cannot reach it.
 */
export type UseCaseDraftCheck =
  | { ok: true; sandbox: boolean; mode: ResourceMode; allowedChainIds: string[]; defaultChainId: string }
  | { ok: false; message: string };

export function checkUseCaseDraft(draft: UseCaseModeDraft): UseCaseDraftCheck {
  const allowedChainIds = [...draft.allowedChainIds];
  if (allowedChainIds.length === 0) {
    return { ok: false, message: "Select at least one ledger — a use case that may deploy nowhere cannot issue anything" };
  }
  // The environment rule runs BEFORE the default-chain rule: a mismatched
  // allowlist is wrong whichever of its entries is starred, and reporting the
  // star first would send the operator to fix the wrong control.
  if (!sandboxChainsValid(draft.sandbox, allowedChainIds)) {
    const offenders = allowedChainIds.filter((c) => (draft.sandbox ? c !== SANDBOX_CHAIN_ID : c === SANDBOX_CHAIN_ID));
    return {
      ok: false,
      message: draft.sandbox
        ? `A sandbox use case runs only on the '${SANDBOX_CHAIN_ID}' ledger — remove ${offenders.join(", ")}`
        : `A live use case may not run on the '${SANDBOX_CHAIN_ID}' ledger — it is simulated, so nothing issued on it is real. Remove ${offenders.join(", ")}, or create this as a sandbox use case`,
    };
  }
  if (!allowedChainIds.includes(draft.defaultChainId)) {
    return { ok: false, message: "The default ledger must be one of the selected ledgers" };
  }
  return {
    ok: true,
    sandbox: draft.sandbox,
    mode: modeOf(draft.sandbox),
    allowedChainIds,
    defaultChainId: draft.defaultChainId,
  };
}

/**
 * WHY A SANDBOX SUPPLY FIGURE IS NOT A SUPPLY FIGURE. Shown wherever a sandbox
 * use case's numbers are on screen, because a supply, a holder count or a
 * contract address reads exactly the same whether the ledger behind it is a
 * chain or a map in a process's memory.
 */
export const SANDBOX_LEDGER_NOTE =
  "Assets under this use case are minted on a simulated in-memory ledger. Supply, holders, balances and contract addresses shown here are not on any chain, and they do not survive a restart of the platform.";

/** Why a headline number here is smaller than the catalog suggests. */
export const SANDBOX_EXCLUDED_NOTE =
  "Sandbox use cases are excluded from these figures. A simulated asset inside a real total is a reporting error nobody catches, because the number still looks like a number.";

/** Why the environment cannot be changed after creation, and what to do instead. */
export const SANDBOX_IMMUTABLE_NOTE =
  "A use case's environment is fixed when it is created — flipping it would reclassify everything already issued under it. Clone a sandbox use case to live to carry its configuration (and nothing else) into the real environment.";
