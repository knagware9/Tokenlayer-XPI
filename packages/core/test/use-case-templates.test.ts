import { describe, expect, it } from "vitest";
import {
  TEMPLATE_CATALOG,
  getBuiltInTemplate,
  validateTemplate,
  validateTemplateParams,
  instantiateTemplate,
  validateCredentialUseCase,
  PolicyError,
} from "../src/index.js";
import type { UseCaseTemplate } from "../src/index.js";

const edu = () => getBuiltInTemplate("education-certificate");
const egov = () => getBuiltInTemplate("egovernance-certificate");

describe("validateTemplate", () => {
  it("accepts every built-in template", () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(() => validateTemplate(t)).not.toThrow();
      expect(t.builtIn).toBe(true);
    }
  });
  it("rejects a bad key / missing options / duplicate param", () => {
    const base = edu();
    expect(() => validateTemplate({ ...base, key: "Not A Slug" })).toThrow(PolicyError);
    expect(() => validateTemplate({ ...base, name: "" })).toThrow(PolicyError);
    expect(() =>
      validateTemplate({
        ...base,
        parameters: [{ name: "j", label: "J", type: "enum", required: false }],
      }),
    ).toThrow(/options/);
  });
});

describe("validateTemplateParams", () => {
  it("rejects a missing required param and a bad enum/range", () => {
    const t = edu();
    const probs = validateTemplateParams(t.parameters, {});
    expect(probs.some((p) => /issuerOrgName/.test(p))).toBe(true);
    expect(
      validateTemplateParams(t.parameters, { issuerOrgName: "U", jurisdiction: "ZZ" }).some((p) =>
        /jurisdiction/.test(p),
      ),
    ).toBe(true);
    expect(
      validateTemplateParams(t.parameters, { issuerOrgName: "U", requiredApprovals: 0 }).some((p) =>
        /requiredApprovals/.test(p),
      ),
    ).toBe(true);
  });
  it("accepts valid params (defaults fill optionals)", () => {
    expect(
      validateTemplateParams(edu().parameters, { issuerOrgName: "Acme University", jurisdiction: "IN" }),
    ).toEqual([]);
  });
});

describe("instantiateTemplate", () => {
  it("interpolates, derives a slug key, resolves numeric params, prunes includeIf-off claims", () => {
    const def = instantiateTemplate(edu(), {
      issuerOrgName: "Acme University",
      jurisdiction: "IN",
      includeClassification: false,
      requiredApprovals: 2,
    });
    expect(def.key).toMatch(/^[a-z0-9-]+$/);
    expect(def.key).toBe("education-acme-university");
    expect(def.name).toContain("Acme University");
    const ct = def.credentialTypes[0];
    expect(ct.requiredApprovals).toBe(2);
    expect(ct.claimSchema.properties.classification).toBeUndefined(); // pruned
    expect(ct.claimSchema.required).not.toContain("classification");
    // classification is NOT required, so it does not appear in required either way;
    // the included props survive.
    expect(ct.claimSchema.properties.studentName).toBeDefined();
  });

  it("keeps an includeIf claim when its param is true, and strips the includeIf key from the emitted prop", () => {
    const def = instantiateTemplate(edu(), {
      issuerOrgName: "Acme University",
      includeClassification: true,
    });
    const ct = def.credentialTypes[0];
    expect(ct.claimSchema.properties.classification).toBeDefined();
    expect((ct.claimSchema.properties.classification as Record<string, unknown>).includeIf).toBeUndefined();
  });

  it("resolves a numeric-param validityDays from the parameter value", () => {
    const def = instantiateTemplate(edu(), { issuerOrgName: "U", degreeValidityDays: 3650 });
    expect(def.credentialTypes[0].validityDays).toBe(3650);
  });

  it("gates a whole credential TYPE off via type-level includeIf=false", () => {
    const def = instantiateTemplate(egov(), {
      issuerOrgName: "Line Dept",
      includeIncome: false,
      includeCaste: true,
      includeBirth: true,
      includeTradeLicence: true,
    });
    const names = def.credentialTypes.map((c) => c.name);
    expect(names).not.toContain("IncomeCertificate");
    expect(names).toContain("CasteCertificate");
    expect(def.credentialTypes.length).toBe(3);
  });

  it("throws INVALID_TEMPLATE_PARAMS with a problems list on bad params", () => {
    try {
      instantiateTemplate(edu(), {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      expect((e as PolicyError).code).toBe("INVALID_TEMPLATE_PARAMS");
      expect(Array.isArray((e as PolicyError).details.problems)).toBe(true);
    }
  });

  it("every built-in instantiates to a valid credential use case", () => {
    for (const t of TEMPLATE_CATALOG) {
      const params = Object.fromEntries(
        t.parameters.map((p) => [
          p.name,
          p.default ??
            (p.type === "text"
              ? "Sample Org"
              : p.type === "enum"
                ? p.options?.[0]
                : p.type === "number"
                  ? (p.min ?? 1)
                  : true),
        ]),
      );
      const def = instantiateTemplate(t, params);
      expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
    }
  });
});

describe("getBuiltInTemplate", () => {
  it("throws UNKNOWN_TEMPLATE for an unknown key", () => {
    try {
      getBuiltInTemplate("nope");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PolicyError).code).toBe("UNKNOWN_TEMPLATE");
    }
  });
});

const certTemplate = (certificate?: unknown): UseCaseTemplate => ({
  key: "cert-tpl", name: "Cert Tpl", category: "test", parameters: [
    { name: "issuerOrgName", label: "Issuer", type: "text", required: true },
    { name: "includeExtra", label: "Extra?", type: "boolean", required: false, default: true },
  ],
  body: {
    keyTemplate: "cert-${issuerOrgNameSlug}", nameTemplate: "${issuerOrgName} Certs",
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    credentialTypes: [{
      name: "DemoCredential", title: "Demo", validityDays: 365, requiredApprovals: 1,
      required: ["fullName"],
      properties: { fullName: { type: "string" }, extra: { type: "string", includeIf: "includeExtra" } },
      ...(certificate !== undefined ? { certificate } : {}),
    }],
  },
} as UseCaseTemplate);

describe("template certificate config", () => {
  const cert = { enabled: true, heading: "Demo Certificate — ${issuerOrgName}", subheading: "${issuerOrgName}", claimOrder: ["fullName", "extra"] };

  it("emits an interpolated certificate on instantiation", () => {
    const def = instantiateTemplate(certTemplate(cert), { issuerOrgName: "Acme" });
    const c = def.credentialTypes[0].certificate;
    expect(c?.enabled).toBe(true);
    expect(c?.heading).toBe("Demo Certificate — Acme");
    expect(c?.subheading).toBe("Acme");
    expect(c?.claimOrder).toEqual(["fullName", "extra"]);
  });

  it("filters claimOrder to includeIf-surviving claims", () => {
    const def = instantiateTemplate(certTemplate(cert), { issuerOrgName: "Acme", includeExtra: false });
    expect(def.credentialTypes[0].certificate?.claimOrder).toEqual(["fullName"]);
  });

  it("emits undefined claimOrder when filtering empties it, and undefined heading when interpolation is blank", () => {
    const t = certTemplate({ enabled: true, heading: "${missing}", claimOrder: ["extra"] });
    const def = instantiateTemplate(t, { issuerOrgName: "Acme", includeExtra: false });
    expect(def.credentialTypes[0].certificate?.claimOrder).toBeUndefined();
    expect(def.credentialTypes[0].certificate?.heading).toBeUndefined();
  });

  it("emits no certificate when the template has none (back-compat)", () => {
    const def = instantiateTemplate(certTemplate(), { issuerOrgName: "Acme" });
    expect(def.credentialTypes[0].certificate).toBeUndefined();
  });

  it("validateTemplate accepts a valid certificate and rejects bad ones", () => {
    expect(() => validateTemplate(certTemplate(cert))).not.toThrow();
    expect(() => validateTemplate(certTemplate({ enabled: "yes" }))).toThrow(/enabled/);
    expect(() => validateTemplate(certTemplate({ enabled: true, claimOrder: ["ghost"] }))).toThrow(/ghost|claimOrder/);
    expect(() => validateTemplate(certTemplate({ enabled: true, heading: 5 }))).toThrow(/heading/);
  });
});

describe("built-in certificate defaults", () => {
  it("education-certificate instantiates cert-enabled and valid", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "education-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Acme University" });
    const c = def.credentialTypes[0]!.certificate;
    expect(c?.enabled).toBe(true);
    expect(c?.subheading).toBe("Acme University");
    expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
  });
  it("education claimOrder drops classification when toggled off", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "education-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Acme University", includeClassification: false });
    expect(def.credentialTypes[0]!.certificate?.claimOrder).not.toContain("classification");
  });
  it("domicile-certificate instantiates cert-enabled and valid", () => {
    const t = TEMPLATE_CATALOG.find((x) => x.key === "domicile-certificate")!;
    const def = instantiateTemplate(t, { issuerOrgName: "Tehsildar Office" });
    expect(def.credentialTypes[0]!.certificate?.enabled).toBe(true);
    expect(() => validateCredentialUseCase(def, { orgExists: () => true })).not.toThrow();
  });
  it("the other built-ins stay certificate-free", () => {
    for (const key of ["invoice-financing", "egovernance-certificate", "generic-credential"]) {
      const t = TEMPLATE_CATALOG.find((x) => x.key === key)!;
      for (const ct of t.body.credentialTypes) expect(ct.certificate).toBeUndefined();
    }
  });
});
