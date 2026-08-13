/**
 * ONE SLUG NAMESPACE, ACROSS BOTH PRODUCTS — asked in a way that survives the
 * split.
 *
 * A use-case key is unique across tokenization use cases and credential use
 * cases alike, so every create path checks the other side's namespace before
 * writing. On a deployment that serves both products that is a real lookup. On
 * one that serves a single product it is a question about a table that lives in
 * a DIFFERENT DATABASE, where:
 *
 *   · asking is impossible — the repository guard refuses a table this
 *     deployment does not keep, and an unhandled refusal would fail the create
 *     with a 404 about a product the caller never mentioned; and
 *   · the answer does not matter — the two namespaces are separate databases
 *     once split, so they cannot collide.
 *
 * So the rule is: consult a namespace only where this deployment keeps it. That
 * is not a weakened check; it is the same check, asked of the data that exists.
 */
import type { AppDeps } from "./context.js";

type NamespaceDeps = Pick<AppDeps, "useCases" | "credentialUseCases" | "enabledDomains">;

/**
 * Which use-case namespace already holds `key` on THIS deployment, or null.
 *
 * Tokenization is checked first so a caller that distinguishes the two (the
 * OrgAdmin create path answers `USECASE_EXISTS` for one and `KEY_TAKEN` for the
 * other) keeps the precedence it had.
 */
export async function namespaceHolding(
  deps: NamespaceDeps,
  key: string,
): Promise<"tokenization" | "identity" | null> {
  if (deps.enabledDomains.includes("tokenization") && (await deps.useCases.has(key))) return "tokenization";
  if (deps.enabledDomains.includes("identity") && (await deps.credentialUseCases.has(key))) return "identity";
  return null;
}
