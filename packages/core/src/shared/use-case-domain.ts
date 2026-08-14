/** A configurable use case belongs to exactly one product domain. */
export type UseCaseDomain = "tokenization" | "identity";

/**
 * Classify a use-case key by domain. Identity keys name a credential use case;
 * tokenization keys name an asset use case. Cross-type key collisions are
 * prevented at creation time, so a key resolves to at most one domain.
 * Returns undefined when the key names neither.
 */
export function useCaseDomainOf(
  key: string,
  known: { tokenizationKeys: Iterable<string>; credentialKeys: Iterable<string> },
): UseCaseDomain | undefined {
  for (const k of known.credentialKeys) if (k === key) return "identity";
  for (const k of known.tokenizationKeys) if (k === key) return "tokenization";
  return undefined;
}
