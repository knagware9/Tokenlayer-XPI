/**
 * Declarative, serializable use-case TEMPLATES for the Identity domain.
 *
 * A template is DATA, not code: it carries a list of parameters plus a "body"
 * whose strings/numbers may reference those parameters. Built-in templates (this
 * catalog) and customer-saved templates share one `UseCaseTemplate` shape and
 * one `instantiateTemplate` engine, which materializes a template + a set of
 * parameter values into a concrete `CredentialUseCaseDefinition` — the same
 * shape hand-authored use cases use, so the output flows through the existing
 * `validateCredentialUseCase` validator and runtime unchanged.
 */
import { PolicyError } from "./errors.js";
import type {
  CredentialUseCaseDefinition,
  CredentialTypeSpec,
  HolderPolicy,
  VerifierBinding,
  CertificateConfig,
} from "./credential-use-cases.js";
import type { MetadataSchema, PropertySchema } from "./types.js";

export type TemplateParamType = "text" | "number" | "enum" | "boolean";

/** One knob a template exposes. Values are supplied at instantiation time. */
export interface TemplateParam {
  name: string;
  label: string;
  type: TemplateParamType;
  required: boolean;
  default?: string | number | boolean;
  /** enum params only: the permitted choices. */
  options?: string[];
  /** number params only: inclusive bounds. */
  min?: number;
  max?: number;
  help?: string;
}

/** A number literal, or a reference to a numeric parameter by name. */
type NumOrParam = number | { param: string };

/**
 * A claim property in template form: a metadata `PropertySchema` (restricted to
 * string|number here) plus an optional `includeIf` naming a boolean param — when
 * that param is false the whole property is pruned from the emitted claim schema
 * (and removed from `required`). The `includeIf` key is stripped before emit.
 */
export interface TemplateClaimProp {
  type: "string" | "number";
  enum?: string[];
  pattern?: string;
  min?: number;
  max?: number;
  includeIf?: string;
}

/**
 * A credential type in template form. `validityDays`/`requiredApprovals` may be
 * numeric literals or `{ param }` references. An optional `includeIf` names a
 * boolean param that gates the WHOLE credential type (dropped when false).
 */
export interface TemplateCredentialType {
  name: string;
  title: string;
  validityDays: NumOrParam;
  requiredApprovals: NumOrParam;
  required: string[];
  properties: Record<string, TemplateClaimProp>;
  /** Boolean param name; when its value is false the whole type is dropped. */
  includeIf?: string;
  /** Optional ID-I PDF-certificate config. `heading`/`subheading` may contain
   *  `${param}` references (interpolated at instantiation); `claimOrder` is
   *  filtered to claims that survive `includeIf` pruning. */
  certificate?: CertificateConfig;
}

export interface UseCaseTemplate {
  key: string;
  name: string;
  category: string;
  description?: string;
  parameters: TemplateParam[];
  body: {
    keyTemplate: string;
    nameTemplate: string;
    descriptionTemplate?: string;
    credentialTypes: TemplateCredentialType[];
    holderPolicy: HolderPolicy;
    /** A literal binding, or `{ param }` naming an enum param ("any" ⇒ any). */
    verifier: VerifierBinding | { param: string };
  };
  builtIn?: boolean;
}

/** Lowercased-hyphenated slug of a free-text string, safe for a use-case key. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "org";

/** Structural validation of a template (built-in or saved). Throws PolicyError. */
export function validateTemplate(t: UseCaseTemplate): void {
  const fail = (m: string): never => {
    throw new PolicyError("INVALID_TEMPLATE", m);
  };
  if (!t.key || !/^[a-z0-9-]+$/.test(t.key)) fail("template key must be a lowercase slug");
  if (!t.name?.trim()) fail("template name is required");
  const names = new Set<string>();
  for (const p of t.parameters) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(p.name)) fail(`bad param name '${p.name}'`);
    if (names.has(p.name)) fail(`duplicate param '${p.name}'`);
    names.add(p.name);
    if (p.type === "enum" && !p.options?.length) fail(`enum param '${p.name}' needs options`);
  }
  if (!t.body?.credentialTypes?.length) fail("template needs at least one credential type");
  for (const ct of t.body.credentialTypes) {
    const cert = ct.certificate;
    if (cert === undefined) continue;
    if (typeof cert.enabled !== "boolean") fail(`credential type '${ct.name}' certificate.enabled must be a boolean`);
    for (const [f, v] of [["heading", cert.heading], ["subheading", cert.subheading], ["logoDocumentId", cert.logoDocumentId]] as const)
      if (v !== undefined && typeof v !== "string") fail(`credential type '${ct.name}' certificate.${f} must be a string`);
    if (cert.claimOrder !== undefined) {
      if (!Array.isArray(cert.claimOrder) || cert.claimOrder.some((k) => typeof k !== "string"))
        fail(`credential type '${ct.name}' certificate.claimOrder must be an array of strings`);
      for (const k of cert.claimOrder)
        if (!(k in ct.properties)) fail(`credential type '${ct.name}' certificate.claimOrder references unknown claim '${k}'`);
    }
  }
}

/**
 * Validate a set of parameter VALUES against the declared parameters. Returns a
 * list of human-readable problems (empty array = ok). Required params are only
 * flagged missing when they also lack a `default`.
 */
export function validateTemplateParams(
  params: TemplateParam[],
  values: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const p of params) {
    const v = values[p.name];
    if (v === undefined || v === "" || v === null) {
      if (p.required && p.default === undefined) problems.push(`missing required parameter '${p.name}'`);
      continue;
    }
    if (p.type === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) {
        problems.push(`'${p.name}' must be a number`);
        continue;
      }
      if (p.min !== undefined && v < p.min) problems.push(`'${p.name}' must be >= ${p.min}`);
      if (p.max !== undefined && v > p.max) problems.push(`'${p.name}' must be <= ${p.max}`);
    } else if (p.type === "boolean") {
      if (typeof v !== "boolean") problems.push(`'${p.name}' must be a boolean`);
    } else if (p.type === "enum") {
      if (!p.options?.includes(String(v))) problems.push(`'${p.name}' must be one of: ${p.options?.join(", ")}`);
    } else {
      if (typeof v !== "string") problems.push(`'${p.name}' must be text`);
    }
  }
  return problems;
}

/** Fill omitted values from each param's `default`. */
const resolved = (params: TemplateParam[], values: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const p of params) out[p.name] = values[p.name] ?? p.default;
  return out;
};

/**
 * Interpolate `${param}` references in a string. A `${xxxSlug}` reference emits
 * a lowercased-hyphenated slug of the `xxx` param's value (used for keys).
 */
const interp = (s: string, vals: Record<string, unknown>): string =>
  s.replace(/\$\{(\w+)\}/g, (_, name: string) =>
    name.endsWith("Slug") ? slug(String(vals[name.slice(0, -4)] ?? "")) : String(vals[name] ?? ""),
  );

/** Resolve a numeric-or-`{param}` field to a concrete number. */
const num = (v: NumOrParam, vals: Record<string, unknown>): number =>
  typeof v === "number" ? v : Number(vals[v.param]);

/**
 * Materialize a template + parameter values into a concrete
 * `CredentialUseCaseDefinition`. Validates the params first (throws
 * `INVALID_TEMPLATE_PARAMS` with a `problems` list on failure). The output uses
 * a platform issuer binding; provisioning re-binds it to the chosen issuer org.
 */
export function instantiateTemplate(
  t: UseCaseTemplate,
  values: Record<string, unknown>,
): CredentialUseCaseDefinition {
  const probs = validateTemplateParams(t.parameters, values);
  if (probs.length) {
    throw new PolicyError("INVALID_TEMPLATE_PARAMS", `template parameter errors: ${probs.join("; ")}`, {
      problems: probs,
    });
  }
  const vals = resolved(t.parameters, values);

  const credentialTypes: CredentialTypeSpec[] = t.body.credentialTypes
    // (a) drop a whole credential type gated off by a false boolean param.
    .filter((ctpl) => !ctpl.includeIf || Boolean(vals[ctpl.includeIf]))
    .map((ctpl) => {
      const properties: MetadataSchema["properties"] = {};
      const required: string[] = [];
      for (const [key, prop] of Object.entries(ctpl.properties)) {
        // (b) drop a claim property gated off by a false boolean param.
        if (prop.includeIf && !vals[prop.includeIf]) continue;
        const { includeIf: _drop, ...schemaProp } = prop; // strip includeIf before emit
        properties[key] = schemaProp as PropertySchema;
        if (ctpl.required.includes(key)) required.push(key);
      }
      let certificate: CertificateConfig | undefined;
      if (ctpl.certificate) {
        const src = ctpl.certificate;
        const interpOrUndef = (s: string | undefined): string | undefined => {
          if (s === undefined) return undefined;
          const out = interp(s, vals).trim();
          return out || undefined;
        };
        const claimOrder = src.claimOrder?.filter((k) => k in properties);
        certificate = {
          enabled: src.enabled,
          heading: interpOrUndef(src.heading),
          subheading: interpOrUndef(src.subheading),
          claimOrder: claimOrder?.length ? claimOrder : undefined,
          logoDocumentId: src.logoDocumentId,
        };
      }
      return {
        name: ctpl.name,
        title: interp(ctpl.title, vals),
        validityDays: num(ctpl.validityDays, vals),
        requiredApprovals: num(ctpl.requiredApprovals, vals),
        claimSchema: { type: "object", required, properties } satisfies MetadataSchema,
        ...(certificate ? { certificate } : {}),
      };
    });

  const verifier: VerifierBinding =
    "param" in t.body.verifier
      ? String(vals[(t.body.verifier as { param: string }).param]) === "any"
        ? { kind: "any" }
        : { kind: "orgs", orgIds: [] }
      : t.body.verifier;

  return {
    key: interp(t.body.keyTemplate, vals),
    name: interp(t.body.nameTemplate, vals),
    description: t.body.descriptionTemplate ? interp(t.body.descriptionTemplate, vals) : undefined,
    credentialTypes,
    // Templates carry no issuer; provisioning binds the issuer org. A platform
    // binding keeps the standalone def valid (needs no org existence check).
    issuer: { kind: "platform" },
    holderPolicy: t.body.holderPolicy,
    verifier,
  };
}

// ---------------------------------------------------------------------------
// Built-in catalog — five templates generalizing the hand-authored identity
// use cases (see scripts/seed-identity-usecases.mjs) into parameterized form.
// ---------------------------------------------------------------------------

const S = (extra: Partial<TemplateClaimProp> = {}): TemplateClaimProp => ({ type: "string", ...extra });
const Nprop = (extra: Partial<TemplateClaimProp> = {}): TemplateClaimProp => ({ type: "number", ...extra });

const issuerOrgNameParam: TemplateParam = {
  name: "issuerOrgName",
  label: "Issuer organization name",
  type: "text",
  required: true,
  help: "The real-world authority whose name signs these credentials.",
};
const requiredApprovalsParam: TemplateParam = {
  name: "requiredApprovals",
  label: "Approvals required to issue",
  type: "number",
  required: false,
  default: 1,
  min: 1,
};
const RA: NumOrParam = { param: "requiredApprovals" };

export const TEMPLATE_CATALOG: UseCaseTemplate[] = [
  {
    key: "education-certificate",
    name: "Education Certificate",
    category: "Education",
    description: "Degree & academic credentials issued by a university registrar or examination board.",
    builtIn: true,
    parameters: [
      issuerOrgNameParam,
      {
        name: "jurisdiction",
        label: "Jurisdiction",
        type: "enum",
        required: false,
        default: "IN",
        options: ["IN", "US", "EU", "Other"],
      },
      { name: "degreeValidityDays", label: "Degree validity (days)", type: "number", required: false, default: 10950, min: 1 },
      { name: "includeClassification", label: "Include classification/grade", type: "boolean", required: false, default: true },
      requiredApprovalsParam,
    ],
    body: {
      keyTemplate: "education-${issuerOrgNameSlug}",
      nameTemplate: "${issuerOrgName} — Education Certificate",
      descriptionTemplate: "Degree & academic credentials issued by ${issuerOrgName} (${jurisdiction}).",
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
      credentialTypes: [
        {
          name: "DegreeCredential",
          title: "Degree Credential",
          validityDays: { param: "degreeValidityDays" },
          requiredApprovals: RA,
          required: ["studentName", "institution", "degree", "conferredYear"],
          properties: {
            studentName: S(),
            institution: S(),
            degree: S(),
            conferredYear: Nprop({ min: 1900, max: 2100 }),
            classification: S({
              enum: ["First Class with Distinction", "First Class", "Second Class", "Pass"],
              includeIf: "includeClassification",
            }),
            rollNumber: S(),
          },
          certificate: {
            enabled: true,
            heading: "Degree Certificate",
            subheading: "${issuerOrgName}",
            claimOrder: ["studentName", "institution", "degree", "conferredYear", "classification"],
          },
        },
      ],
    },
  },
  {
    key: "invoice-financing",
    name: "Invoice Financing",
    category: "Finance",
    description: "Chained receivable credentials: an Invoice VC on IRN generation plus a Buyer Acceptance VC.",
    builtIn: true,
    parameters: [issuerOrgNameParam, requiredApprovalsParam],
    body: {
      keyTemplate: "invoice-financing-${issuerOrgNameSlug}",
      nameTemplate: "${issuerOrgName} — Invoice Financing",
      descriptionTemplate: "Receivable credentials issued via ${issuerOrgName}, presented by an MSME to a financier.",
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
      credentialTypes: [
        {
          name: "InvoiceCredential",
          title: "Invoice Credential",
          validityDays: 1825,
          requiredApprovals: RA,
          required: ["irn", "invoiceNumber", "amount"],
          properties: {
            irn: S(),
            invoiceNumber: S(),
            documentHash: S(),
            sellerGstin: S(),
            buyerGstin: S(),
            amount: Nprop({ min: 0 }),
            currency: S({ enum: ["INR"] }),
            dueDate: S(),
          },
        },
        {
          name: "AcceptanceCredential",
          title: "Buyer Acceptance Credential",
          validityDays: 1825,
          requiredApprovals: RA,
          required: ["irn", "paymentDueDate"],
          properties: {
            irn: S(),
            buyerName: S(),
            paymentDueDate: S(),
            grnReference: S(),
          },
        },
      ],
    },
  },
  {
    key: "domicile-certificate",
    name: "Domicile Certificate",
    category: "Government",
    description: "Residence credential issued by a Tehsildar/District Collector office; designed for predicate disclosure.",
    builtIn: true,
    parameters: [issuerOrgNameParam, requiredApprovalsParam],
    body: {
      keyTemplate: "domicile-certificate-${issuerOrgNameSlug}",
      nameTemplate: "${issuerOrgName} — Domicile Certificate",
      descriptionTemplate: "Residence credential issued by ${issuerOrgName}.",
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
      credentialTypes: [
        {
          name: "DomicileCredential",
          title: "Domicile Credential",
          validityDays: 1825,
          requiredApprovals: RA,
          required: ["holderName", "state", "continuousResidenceSinceYear"],
          properties: {
            holderName: S(),
            state: S(),
            district: S(),
            continuousResidenceSinceYear: Nprop({ min: 1900, max: 2100 }),
          },
          certificate: {
            enabled: true,
            heading: "Certificate of Domicile",
            subheading: "${issuerOrgName}",
            claimOrder: ["holderName", "state", "district", "continuousResidenceSinceYear"],
          },
        },
      ],
    },
  },
  {
    key: "egovernance-certificate",
    name: "e-Governance Certificate",
    category: "Government",
    description: "Income, caste, birth and trade-licence credentials issued by line departments and consumed across government.",
    builtIn: true,
    parameters: [
      issuerOrgNameParam,
      { name: "includeIncome", label: "Include Income Certificate", type: "boolean", required: false, default: true },
      { name: "includeCaste", label: "Include Caste Certificate", type: "boolean", required: false, default: true },
      { name: "includeBirth", label: "Include Birth Certificate", type: "boolean", required: false, default: true },
      { name: "includeTradeLicence", label: "Include Trade Licence", type: "boolean", required: false, default: true },
      requiredApprovalsParam,
    ],
    body: {
      keyTemplate: "egovernance-certificate-${issuerOrgNameSlug}",
      nameTemplate: "${issuerOrgName} — e-Governance Certificate",
      descriptionTemplate: "Line-department credentials issued by ${issuerOrgName}.",
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
      credentialTypes: [
        {
          name: "IncomeCertificate",
          title: "Income Certificate",
          validityDays: 1825,
          requiredApprovals: RA,
          includeIf: "includeIncome",
          required: ["holderName", "annualIncome", "financialYear"],
          properties: {
            holderName: S(),
            annualIncome: Nprop({ min: 0 }),
            financialYear: S(),
            issuingAuthority: S(),
          },
        },
        {
          name: "CasteCertificate",
          title: "Caste Certificate",
          validityDays: 1825,
          requiredApprovals: RA,
          includeIf: "includeCaste",
          required: ["holderName", "category"],
          properties: {
            holderName: S(),
            category: S({ enum: ["SC", "ST", "OBC", "General"] }),
            issuingAuthority: S(),
          },
        },
        {
          name: "BirthCertificate",
          title: "Birth Certificate",
          validityDays: 36500,
          requiredApprovals: RA,
          includeIf: "includeBirth",
          required: ["holderName", "dateOfBirth"],
          properties: {
            holderName: S(),
            dateOfBirth: S(),
            placeOfBirth: S(),
            registrationNumber: S(),
          },
        },
        {
          name: "TradeLicence",
          title: "Trade Licence",
          validityDays: 1825,
          requiredApprovals: RA,
          includeIf: "includeTradeLicence",
          required: ["businessName", "licenceNumber"],
          properties: {
            businessName: S(),
            licenceNumber: S(),
            tradeType: S(),
            validUpto: S(),
          },
        },
      ],
    },
  },
  {
    key: "generic-credential",
    name: "Generic Credential",
    category: "Generic",
    description: "A minimal starting point: one credential type with a customizable label and a single subject-name claim.",
    builtIn: true,
    parameters: [
      issuerOrgNameParam,
      {
        name: "credentialLabel",
        label: "Credential label",
        type: "text",
        required: true,
        default: "Custom Credential",
        help: "The human title of the credential this use case issues.",
      },
      requiredApprovalsParam,
    ],
    body: {
      keyTemplate: "generic-${issuerOrgNameSlug}",
      nameTemplate: "${issuerOrgName} — ${credentialLabel}",
      descriptionTemplate: "${credentialLabel} issued by ${issuerOrgName}.",
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
      credentialTypes: [
        {
          name: "GenericCredential",
          title: "${credentialLabel}",
          validityDays: 365,
          requiredApprovals: RA,
          required: ["subjectName"],
          properties: {
            subjectName: S(),
          },
        },
      ],
    },
  },
];

/** Resolve a built-in template by key. Throws UNKNOWN_TEMPLATE when absent. */
export function getBuiltInTemplate(key: string): UseCaseTemplate {
  const t = TEMPLATE_CATALOG.find((x) => x.key === key);
  if (!t) throw new PolicyError("UNKNOWN_TEMPLATE", `no built-in template '${key}'`);
  return t;
}
