import { PolicyError } from "./errors.js";
import { ROLES, tokenTypeForStandard, type MetadataSchema, type TokenStandard, type UseCaseDefinition, type Role } from "./types.js";

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(ROLES);
const VALID_TOKEN_STANDARDS = new Set<string>(["ERC-20", "ERC-721", "ERC-3643"]);
const VALID_PROP_TYPES = new Set(["string", "number", "boolean"]);

/**
 * Validate a use-case definition's shape at registry load time. Throws a
 * PolicyError("INVALID_USECASE") describing the first problem found.
 */
export function validateUseCaseDefinition(def: unknown): asserts def is UseCaseDefinition {
  const fail = (msg: string): never => {
    throw new PolicyError("INVALID_USECASE", msg, { def });
  };

  if (typeof def !== "object" || def === null) fail("use case must be an object");
  const d = def as Record<string, unknown>;

  if (typeof d.key !== "string" || d.key.length === 0) fail("use case 'key' must be a non-empty string");
  if (typeof d.name !== "string" || d.name.length === 0) fail(`use case '${String(d.key)}' needs a 'name'`);
  if (typeof d.symbol !== "string" || d.symbol.length === 0) fail(`use case '${String(d.key)}' needs a token 'symbol'`);
  if (typeof d.tokenStandard !== "string" || !VALID_TOKEN_STANDARDS.has(d.tokenStandard)) {
    fail(`use case '${String(d.key)}' has invalid tokenStandard (expected ERC-20|ERC-721|ERC-3643)`);
  }
  const expectedType = tokenTypeForStandard(d.tokenStandard as TokenStandard);
  if (d.tokenType !== undefined && d.tokenType !== expectedType) {
    fail(`use case '${String(d.key)}' tokenType must be '${expectedType}' for ${String(d.tokenStandard)}`);
  }

  if (!Array.isArray(d.allowedChainIds) || d.allowedChainIds.length === 0) {
    fail(`use case '${String(d.key)}' needs a non-empty 'allowedChainIds' array`);
  }
  for (const c of d.allowedChainIds as unknown[]) {
    if (typeof c !== "string" || c.length === 0) fail(`use case '${String(d.key)}' has an invalid chain id`);
  }
  if (typeof d.defaultChainId !== "string" || !(d.allowedChainIds as string[]).includes(d.defaultChainId)) {
    fail(`use case '${String(d.key)}' defaultChainId must be one of allowedChainIds`);
  }

  validateMetadataSchema(d.metadataSchema, String(d.key), fail);

  const lifecycle = d.lifecycle as Record<string, unknown> | undefined;
  if (!lifecycle || typeof lifecycle !== "object") fail(`use case '${String(d.key)}' needs a 'lifecycle' object`);
  for (const flag of ["mint", "transfer", "burn", "freeze"]) {
    if (typeof (lifecycle as Record<string, unknown>)[flag] !== "boolean") {
      fail(`use case '${String(d.key)}' lifecycle.${flag} must be a boolean`);
    }
  }

  const compliance = d.compliance as Record<string, unknown> | undefined;
  if (!compliance || typeof compliance !== "object") fail(`use case '${String(d.key)}' needs a 'compliance' object`);
  for (const flag of ["allowlist", "transferRestrictions"]) {
    if (typeof (compliance as Record<string, unknown>)[flag] !== "boolean") {
      fail(`use case '${String(d.key)}' compliance.${flag} must be a boolean`);
    }
  }

  if (!Array.isArray(d.roles) || d.roles.length === 0) fail(`use case '${String(d.key)}' needs a non-empty 'roles' array`);
  for (const r of d.roles as unknown[]) {
    if (typeof r !== "string" || !VALID_ROLES.has(r as Role)) fail(`use case '${String(d.key)}' has invalid role '${String(r)}'`);
  }
}

function validateMetadataSchema(
  schema: unknown,
  key: string,
  fail: (msg: string) => never,
): void {
  if (typeof schema !== "object" || schema === null) fail(`use case '${key}' needs a 'metadataSchema' object`);
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") fail(`use case '${key}' metadataSchema.type must be "object"`);
  if (typeof s.properties !== "object" || s.properties === null) fail(`use case '${key}' metadataSchema.properties must be an object`);
  for (const [name, prop] of Object.entries(s.properties as Record<string, unknown>)) {
    if (typeof prop !== "object" || prop === null || !VALID_PROP_TYPES.has((prop as Record<string, unknown>).type as string)) {
      fail(`use case '${key}' property '${name}' must declare a type of string|number|boolean`);
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) fail(`use case '${key}' metadataSchema.required must be an array`);
    for (const req of s.required as unknown[]) {
      if (typeof req !== "string" || !(req in (s.properties as object))) {
        fail(`use case '${key}' requires unknown property '${String(req)}'`);
      }
    }
  }
}

/**
 * Validate issuance metadata against a use case's metadata schema. Throws
 * PolicyError("INVALID_METADATA") listing every problem at once.
 */
export function validateMetadata(metadata: Record<string, unknown>, schema: MetadataSchema): void {
  const problems: string[] = [];

  for (const req of schema.required ?? []) {
    if (metadata[req] === undefined || metadata[req] === null) {
      problems.push(`missing required field '${req}'`);
    }
  }

  for (const [name, value] of Object.entries(metadata)) {
    const prop = schema.properties[name];
    if (!prop) continue; // extra fields are tolerated, not rejected
    const actual = typeof value;
    if (actual !== prop.type) {
      problems.push(`field '${name}' should be ${prop.type} but got ${actual}`);
    }
  }

  if (problems.length > 0) {
    throw new PolicyError("INVALID_METADATA", `metadata validation failed: ${problems.join("; ")}`, { problems });
  }
}
