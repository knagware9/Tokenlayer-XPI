/**
 * THE PERSISTENCE CONTRACT, assembled from its three products.
 *
 * Split by `../model-domains.ts` — the declared owner of every table, and the
 * same map the repository seam enforces at runtime. This barrel keeps the
 * import specifier honest for callers who legitimately need several products'
 * types at once (the composition root, the route context, tests).
 */
export * from "./shared.js";
export * from "./tokenization.js";
export * from "./identity.js";
