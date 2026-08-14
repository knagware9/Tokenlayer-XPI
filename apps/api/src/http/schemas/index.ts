/**
 * PER-ROUTE SCHEMAS, ASSEMBLED FROM ONE FILE PER PRODUCT.
 *
 * schemas.ts was 3,389 lines: 131 route schemas with both products interleaved,
 * in the same file as the shared components. Every one of those 131 turned out
 * to be referenced by exactly ONE route file — a clean partition, which is why
 * this split needed no judgement calls.
 *
 * `S` keeps its shape, so every `S.someRoute` in the route files is untouched
 * and the OpenAPI document is byte-identical.
 */
import type { FastifySchema } from "fastify";
import { sharedSchemas } from "./shared.js";
import { tokenizationSchemas } from "./tokenization.js";
import { identitySchemas } from "./identity.js";

export { components } from "./components.js";

/** Per-route schemas, referenced from the route files. Typed as FastifySchema so
 *  the framework does not over-narrow reply status codes from the literal objects. */
export const S: Record<string, FastifySchema> = {
  ...sharedSchemas,
  ...tokenizationSchemas,
  ...identitySchemas,
};
