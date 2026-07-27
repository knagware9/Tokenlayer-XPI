import { PolicyError } from "./errors.js";
import { GATED_OPS, ROLES, tokenTypeForStandard, type MetadataSchema, type TokenStandard, type UseCaseDefinition, type Role } from "./types.js";

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(ROLES);
const VALID_TOKEN_STANDARDS = new Set<string>(["ERC-20", "ERC-721", "ERC-3643"]);
const VALID_PROP_TYPES = new Set(["string", "number", "boolean", "document"]);
/** Field types whose runtime value is a string (document values are URL strings). */
const STRING_LIKE_PROP_TYPES = new Set(["string", "document"]);

function isNonNegativeIntegerString(v: unknown): boolean {
  return typeof v === "string" && /^\d+$/.test(v);
}

function isDocumentRef(v: string): boolean {
  // Accept an absolute http(s) URL (an external document vault) OR a same-origin
  // relative path (the platform's own document store returns "/api/v1/documents/:id").
  if (v.startsWith("/")) return true;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

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
  validateCompliance(compliance as Record<string, unknown>, String(d.key), fail);

  if (d.fees !== undefined) validateFees(d.fees, String(d.key), fail);
  if (d.saleTermsDefault !== undefined) validateSaleTermsDefault(d.saleTermsDefault, String(d.key), fail);
  if (d.valuation !== undefined) validateValuation(d.valuation, String(d.key), fail);
  if (d.derivedFields !== undefined) validateDerivedFields(d.derivedFields, d.metadataSchema, String(d.key), fail);
  if (d.uniqueBy !== undefined) validateUniqueBy(d.uniqueBy, d.metadataSchema, String(d.key), fail);
  if (d.terms !== undefined) validateTerms(d.terms, d.metadataSchema, String(d.key), fail);
  if (d.workflow !== undefined) validateWorkflow(d.workflow, String(d.key), fail);

  if (!Array.isArray(d.roles) || d.roles.length === 0) fail(`use case '${String(d.key)}' needs a non-empty 'roles' array`);
  for (const r of d.roles as unknown[]) {
    if (typeof r !== "string" || !VALID_ROLES.has(r as Role)) fail(`use case '${String(d.key)}' has invalid role '${String(r)}'`);
  }
}

export function validateMetadataSchema(
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
      fail(`use case '${key}' property '${name}' must declare a type of string|number|boolean|document`);
    }
    validatePropertySchema(prop as Record<string, unknown>, name, key, fail);
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

/** Reject contradictory per-field constraints (e.g. enum on a number, min>max). */
function validatePropertySchema(
  prop: Record<string, unknown>,
  name: string,
  key: string,
  fail: (msg: string) => never,
): void {
  const type = prop.type as string;
  const isString = type === "string";
  const isNumber = type === "number";

  if (prop.enum !== undefined) {
    if (!isString) fail(`use case '${key}' property '${name}' may only use 'enum' on a string field`);
    if (!Array.isArray(prop.enum) || prop.enum.length === 0) {
      fail(`use case '${key}' property '${name}' enum must be a non-empty array`);
    }
    for (const e of prop.enum as unknown[]) {
      if (typeof e !== "string") fail(`use case '${key}' property '${name}' enum values must be strings`);
    }
  }

  if (prop.min !== undefined || prop.max !== undefined) {
    if (!isNumber) fail(`use case '${key}' property '${name}' may only use 'min'/'max' on a number field`);
    if (prop.min !== undefined && typeof prop.min !== "number") fail(`use case '${key}' property '${name}' min must be a number`);
    if (prop.max !== undefined && typeof prop.max !== "number") fail(`use case '${key}' property '${name}' max must be a number`);
    if (typeof prop.min === "number" && typeof prop.max === "number" && prop.min > prop.max) {
      fail(`use case '${key}' property '${name}' has min > max`);
    }
  }

  if (prop.pattern !== undefined) {
    if (!isString) fail(`use case '${key}' property '${name}' may only use 'pattern' on a string field`);
    if (typeof prop.pattern !== "string") fail(`use case '${key}' property '${name}' pattern must be a string`);
    try {
      new RegExp(prop.pattern as string);
    } catch {
      fail(`use case '${key}' property '${name}' pattern is not a valid RegExp`);
    }
  }
}

/** Validate the optional data-dependent compliance rules. */
function validateCompliance(
  compliance: Record<string, unknown>,
  key: string,
  fail: (msg: string) => never,
): void {
  const { maxHolders, lockupDays, allowedJurisdictions } = compliance;
  if (maxHolders !== undefined) {
    if (typeof maxHolders !== "number" || !Number.isInteger(maxHolders) || maxHolders <= 0) {
      fail(`use case '${key}' compliance.maxHolders must be a positive integer`);
    }
  }
  if (lockupDays !== undefined) {
    if (typeof lockupDays !== "number" || !Number.isInteger(lockupDays) || lockupDays < 0) {
      fail(`use case '${key}' compliance.lockupDays must be a non-negative integer`);
    }
  }
  if (allowedJurisdictions !== undefined) {
    if (!Array.isArray(allowedJurisdictions) || allowedJurisdictions.length === 0) {
      fail(`use case '${key}' compliance.allowedJurisdictions must be a non-empty array`);
    }
    for (const j of allowedJurisdictions as unknown[]) {
      if (typeof j !== "string" || j.length === 0) {
        fail(`use case '${key}' compliance.allowedJurisdictions entries must be non-empty strings`);
      }
    }
  }
}

/** Validate the optional fee configuration. */
function validateFees(fees: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof fees !== "object" || fees === null) fail(`use case '${key}' 'fees' must be an object`);
  const f = fees as Record<string, unknown>;
  if (f.marketplaceBps !== undefined) {
    if (typeof f.marketplaceBps !== "number" || !Number.isInteger(f.marketplaceBps) || f.marketplaceBps < 0 || f.marketplaceBps > 10000) {
      fail(`use case '${key}' fees.marketplaceBps must be an integer between 0 and 10000`);
    }
  }
  if (f.issuanceFlat !== undefined && !isNonNegativeIntegerString(f.issuanceFlat)) {
    fail(`use case '${key}' fees.issuanceFlat must be a non-negative integer string`);
  }
}

/** Validate the optional default sale-terms shape (not enforced at runtime). */
function validateSaleTermsDefault(terms: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof terms !== "object" || terms === null) fail(`use case '${key}' 'saleTermsDefault' must be an object`);
  const t = terms as Record<string, unknown>;
  if (t.unitPrice !== undefined && typeof t.unitPrice !== "string") {
    fail(`use case '${key}' saleTermsDefault.unitPrice must be a string`);
  }
  if (t.currency !== undefined && typeof t.currency !== "string") {
    fail(`use case '${key}' saleTermsDefault.currency must be a string`);
  }
}

/** Validate the optional analytics valuation shape (both fields required together). */
function validateValuation(valuation: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof valuation !== "object" || valuation === null) fail(`use case '${key}' 'valuation' must be an object`);
  const v = valuation as Record<string, unknown>;
  if (typeof v.metadataField !== "string" || v.metadataField === "") {
    fail(`use case '${key}' valuation.metadataField must be a non-empty string`);
  }
  if (typeof v.currency !== "string" || v.currency === "") {
    fail(`use case '${key}' valuation.currency must be a non-empty string`);
  }
}

const TERM_FREQUENCIES = new Set(["atMaturity", "monthly", "quarterly", "semiannual", "annual"]);

/** Validate the optional financial terms template (fields must be declared metadata properties). */
function validateTerms(terms: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof terms !== "object" || terms === null) fail(`use case '${key}' 'terms' must be an object`);
  const t = terms as Record<string, unknown>;
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  for (const f of ["principalField", "maturityField"] as const) {
    if (typeof t[f] !== "string" || !((t[f] as string) in props)) fail(`use case '${key}' terms.${f} must name a declared metadata field`);
  }
  if (t.rateField !== undefined && (typeof t.rateField !== "string" || !(t.rateField in props))) {
    fail(`use case '${key}' terms.rateField must name a declared metadata field`);
  }
  if (t.frequency !== undefined && (typeof t.frequency !== "string" || !TERM_FREQUENCIES.has(t.frequency))) {
    fail(`use case '${key}' terms.frequency must be one of ${[...TERM_FREQUENCIES].join("|")}`);
  }
  if (t.frequency !== undefined && t.frequency !== "atMaturity" && t.rateField === undefined) {
    fail(`use case '${key}' terms.rateField is required for periodic frequency`);
  }
  if (typeof t.currency !== "string" || t.currency === "") fail(`use case '${key}' terms.currency must be a non-empty string`);
}

const GATED_OP_SET = new Set<string>(GATED_OPS);

/** Validate the optional maker-checker workflow block (gated op → required approvals). */
function validateWorkflow(workflow: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof workflow !== "object" || workflow === null) fail(`use case '${key}' 'workflow' must be an object`);
  const approvals = (workflow as Record<string, unknown>).approvals;
  if (approvals === undefined) return;
  if (typeof approvals !== "object" || approvals === null) fail(`use case '${key}' workflow.approvals must be an object`);
  for (const [op, n] of Object.entries(approvals as Record<string, unknown>)) {
    if (!GATED_OP_SET.has(op)) fail(`use case '${key}' workflow.approvals has unknown operation '${op}'`);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) fail(`use case '${key}' workflow.approvals.${op} must be an integer >= 1`);
  }
}

const DERIVED_GENERATORS = new Set(["invoiceFingerprint"]);

/** Validate the optional server-derived metadata fields (target must be declared, generator known). */
function validateDerivedFields(df: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  if (typeof df !== "object" || df === null) fail(`use case '${key}' 'derivedFields' must be an object`);
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  for (const [field, gen] of Object.entries(df as Record<string, unknown>)) {
    if (!(field in props)) fail(`use case '${key}' derivedFields target '${field}' is not a declared metadata field`);
    if (typeof gen !== "string" || !DERIVED_GENERATORS.has(gen)) fail(`use case '${key}' derivedFields.${field} has unknown generator '${String(gen)}'`);
  }
}

/** Validate the optional uniqueBy field (must name a declared metadata property). */
function validateUniqueBy(uniqueBy: unknown, schema: unknown, key: string, fail: (msg: string) => never): void {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if (typeof uniqueBy !== "string" || !(uniqueBy in props)) fail(`use case '${key}' uniqueBy '${String(uniqueBy)}' is not a declared metadata field`);
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

    // A document field's runtime value is a string URL — treat its expected type as string.
    const expectedRuntimeType = STRING_LIKE_PROP_TYPES.has(prop.type) ? "string" : prop.type;
    const actual = typeof value;
    if (actual !== expectedRuntimeType) {
      problems.push(`field '${name}' should be ${expectedRuntimeType} but got ${actual}`);
      continue; // constraint checks below assume the value is the right type
    }

    if (prop.type === "document") {
      if (!isDocumentRef(value as string)) {
        problems.push(`field '${name}' must be an http(s) URL or an uploaded-document path`);
      }
    }
    if (prop.enum !== undefined && !prop.enum.includes(value as string)) {
      problems.push(`field '${name}' must be one of: ${prop.enum.join(", ")}`);
    }
    if (typeof value === "number") {
      if (prop.min !== undefined && value < prop.min) {
        problems.push(`field '${name}' must be >= ${prop.min}`);
      }
      if (prop.max !== undefined && value > prop.max) {
        problems.push(`field '${name}' must be <= ${prop.max}`);
      }
    }
    if (prop.pattern !== undefined && typeof value === "string" && !new RegExp(prop.pattern).test(value)) {
      problems.push(`field '${name}' must match pattern ${prop.pattern}`);
    }
  }

  if (problems.length > 0) {
    throw new PolicyError("INVALID_METADATA", `metadata validation failed: ${problems.join("; ")}`, { problems });
  }
}
