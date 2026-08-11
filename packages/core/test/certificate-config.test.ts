import { describe, expect, it } from "vitest";
import { validateCredentialUseCase, type CredentialUseCaseDefinition } from "../src/credential-use-cases.js";
import { instantiateTemplate, validateTemplate, type UseCaseTemplate } from "../src/use-case-templates.js";

const ctx = { orgExists: () => true };

function def(certificate: Record<string, unknown>): CredentialUseCaseDefinition {
  return {
    key: "domicile", name: "Domicile",
    credentialTypes: [{
      name: "DomicileCredential", title: "Domicile", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      certificate: certificate as never,
    }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
}

describe("CertificateConfig carries artwork", () => {
  it("accepts background + placements", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true,
      background: { documentId: "doc_1" },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.3, align: "center" }],
    }), ctx)).not.toThrow();
  });

  it("still accepts a config with neither — every pre-EN-F config stays valid", () => {
    expect(() => validateCredentialUseCase(def({ enabled: true, heading: "Certificate of Domicile" }), ctx)).not.toThrow();
  });

  it("rejects a non-string background.documentId", () => {
    expect(() => validateCredentialUseCase(def({ enabled: true, background: { documentId: 7 } }), ctx))
      .toThrow(/background.documentId/);
  });

  it("accepts a background with a 0x-prefixed 64-char lowercase hex sha256 pin", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true,
      background: { documentId: "doc_1", sha256: "0x" + "a".repeat(64) },
    }), ctx)).not.toThrow();
  });

  it("rejects a malformed sha256", () => {
    // Every shape that isn't EXACTLY what DocumentRepository.create writes:
    // `0x` + 64 lowercase hex. Bare hex with no `0x` is the important one —
    // it's the shape a naive `createHash(...).digest("hex")` regex (what an
    // earlier draft of this validator used) would have wrongly accepted, and
    // it would never equal a stored digest.
    const badPins: unknown[] = [
      "abc", // too short
      "A".repeat(64), // uppercase — the store only ever emits lowercase
      "z".repeat(64), // not hex
      7, // not a string at all
      "a".repeat(64), // bare hex, no `0x` prefix
      "0x" + "a".repeat(65), // one hex char too many
      " 0x" + "a".repeat(64), // leading whitespace
      null,
    ];
    for (const bad of badPins) {
      expect(() => validateCredentialUseCase(def({
        enabled: true, background: { documentId: "doc_1", sha256: bad },
      }), ctx), `pin ${String(bad)}`).toThrow(/background\.sha256/);
    }
  });

  it("propagates a placement error, with its own code", () => {
    try {
      validateCredentialUseCase(def({ enabled: true, placements: [{ field: "claim:nope", x: 0, y: 0 }] }), ctx);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("INVALID_CERTIFICATE_PLACEMENT");
    }
  });

  it("allows placements with NO background — the state a template instantiation lands in", () => {
    expect(() => validateCredentialUseCase(def({
      enabled: true, placements: [{ field: "subject.name", x: 0.5, y: 0.5 }],
    }), ctx)).not.toThrow();
  });
});

describe("templates carry placements, never artwork", () => {
  // NOTE the real shapes, checked against packages/core/src/use-case-templates.ts:
  // the type is `UseCaseTemplate`, the body uses `keyTemplate`/`nameTemplate`,
  // interpolation is `${param}` (NOT `{{param}}`), a template carries NO issuer,
  // and the function is `instantiateTemplate(template, values)` — two arguments.
  const template: UseCaseTemplate = {
    key: "course-completion", name: "Course Completion", category: "education",
    description: "Completion certificate",
    parameters: [{ name: "orgName", label: "Organization", type: "string", required: true }],
    body: {
      keyTemplate: "${orgName}-completion",
      nameTemplate: "${orgName} Completion",
      credentialTypes: [{
        name: "CompletionCredential", title: "Completion", validityDays: 365, requiredApprovals: 1,
        required: ["fullName"], properties: { fullName: { type: "string" } },
        certificate: {
          enabled: true,
          heading: "Awarded by ${orgName}",
          background: { documentId: "doc_org_a_letterhead" },
          placements: [{ field: "claim:fullName", x: 0.5, y: 0.42, align: "center", fontSize: 20 }],
        },
      }],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  } as UseCaseTemplate;

  it("instantiation keeps placements and DROPS the background", () => {
    const out = instantiateTemplate(template, { orgName: "Acme" });
    const cert = out.credentialTypes[0]!.certificate!;
    expect(cert.placements).toHaveLength(1);
    expect(cert.placements![0]!.field).toBe("claim:fullName");
    // THE CROSS-TENANT RULE. GET /credential-use-case-templates is open to any
    // authenticated user and GET /documents/:id is gated by role rather than by
    // org, so carrying A's artwork id would hand B a pixel-exact impersonation
    // of A's certificates — on a route that needs no credential to read.
    expect(cert.background).toBeUndefined();
    // The parameterised heading still interpolates, and stays placeable.
    expect(cert.heading).toBe("Awarded by Acme");
  });

  it("drops a placement whose claim was gated out of the instantiated schema", () => {
    const gated = JSON.parse(JSON.stringify(template)) as UseCaseTemplate;
    gated.body.credentialTypes[0]!.properties = {};
    gated.body.credentialTypes[0]!.required = [];
    const out = instantiateTemplate(gated, { orgName: "Acme" });
    // A placement pointing at a claim that no longer exists would fail
    // validation on the way in — so instantiation must not emit one.
    expect(out.credentialTypes[0]!.certificate!.placements ?? []).toHaveLength(0);
  });
});

describe("validateTemplate is the SECOND door, and enforces the same placement rules", () => {
  // Without this the template author gets a 201 and the person who uses their
  // template gets the 400 — the split that EN-B's scope map and EN-D2's mode
  // gate were both bitten by. A rule with two doors gets checked at both.
  const tpl = (certificate: Record<string, unknown>): UseCaseTemplate => ({
    key: "t", name: "T", category: "education",
    parameters: [{ name: "orgName", label: "Org", type: "string", required: true }],
    body: {
      keyTemplate: "${orgName}-t", nameTemplate: "${orgName} T",
      credentialTypes: [{
        name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
        required: ["fullName"], properties: { fullName: { type: "string" } },
        certificate: certificate as never,
      }],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  } as UseCaseTemplate);

  it("accepts well-formed placements", () => {
    expect(() => validateTemplate(tpl({ enabled: true, placements: [{ field: "claim:fullName", x: 0.5, y: 0.4 }] }))).not.toThrow();
  });

  it("rejects an off-page coordinate", () => {
    expect(() => validateTemplate(tpl({ enabled: true, placements: [{ field: "subject.name", x: 9, y: 0.4 }] })))
      .toThrow(/x must be a number between 0 and 1/);
  });

  it("rejects a claim ref naming nothing in the template's own properties", () => {
    expect(() => validateTemplate(tpl({ enabled: true, placements: [{ field: "claim:nope", x: 0.5, y: 0.4 }] })))
      .toThrow(/nope/);
  });

  it("rejects two QRs", () => {
    // Both coordinates FIT on the page, so the duplicate rule is what fires
    // rather than the geometry rule that runs before it.
    expect(() => validateTemplate(tpl({ enabled: true, placements: [{ field: "qr", x: 0.1, y: 0.1 }, { field: "qr", x: 0.8, y: 0.8 }] })))
      .toThrow(/at most one/);
  });

  it("still ACCEPTS a background — instantiate drops it, so carrying one is legal", () => {
    expect(() => validateTemplate(tpl({ enabled: true, background: { documentId: "doc_1" } }))).not.toThrow();
  });

  it("…but rejects a malformed one", () => {
    expect(() => validateTemplate(tpl({ enabled: true, background: { documentId: 7 } }))).toThrow(/background.documentId/);
  });

  it("accepts a well-formed sha256 pin on the background — same format, same door", () => {
    expect(() => validateTemplate(tpl({
      enabled: true, background: { documentId: "doc_1", sha256: "0x" + "a".repeat(64) },
    }))).not.toThrow();
  });

  it("rejects a malformed sha256 pin — held to the same format as the use-case door", () => {
    expect(() => validateTemplate(tpl({
      enabled: true, background: { documentId: "doc_1", sha256: "nope" },
    }))).toThrow(/background\.sha256/);
  });
});
