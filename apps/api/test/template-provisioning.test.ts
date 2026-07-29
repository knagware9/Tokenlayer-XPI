import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

// NOTE: the route base is `/credential-use-case-templates`, NOT `/credential-templates` —
// `/credential-templates` is an already-existing, actively-used route (schemas.ts
// `S.credentialTemplates`, routes.ts) that returns the unrelated starter
// CREDENTIAL_TEMPLATES catalog of raw CredentialTypeSpec (KycCredential, MCACredential,
// ...), consumed by apps/web/src/components/CredentialUseCaseBuilder.tsx. Reusing that
// path for the new UseCaseTemplate catalog would silently break that existing endpoint,
// so the new provisioning-template routes live at a distinct, non-colliding base.
const BASE = "/credential-use-case-templates";

const BUILT_IN_KEYS = ["education-certificate", "invoice-financing", "domicile-certificate", "egovernance-certificate", "generic-credential"];

const CUSTOM_TEMPLATE = {
  key: "custom-membership",
  name: "Custom Membership",
  category: "Custom",
  description: "A saved custom template.",
  parameters: [
    { name: "issuerOrgName", label: "Issuer organization name", type: "text", required: true },
  ],
  body: {
    keyTemplate: "membership-${issuerOrgNameSlug}",
    nameTemplate: "${issuerOrgName} — Membership",
    credentialTypes: [
      {
        name: "MembershipCredential",
        title: "Membership Credential",
        validityDays: 365,
        requiredApprovals: 1,
        required: ["memberName"],
        properties: { memberName: { type: "string" } },
      },
    ],
    holderPolicy: { who: "any-onboarded" },
    verifier: { kind: "any" },
  },
};

describe("credential-use-case template catalog API", () => {
  it("GET lists the 5 built-ins (builtIn:true, no body) plus any saved template", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}${BASE}`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: Array<Record<string, unknown>> };
    const keys = body.templates.map((t) => t.key as string);
    for (const k of BUILT_IN_KEYS) expect(keys).toContain(k);
    for (const t of body.templates) {
      if (BUILT_IN_KEYS.includes(t.key as string)) expect(t.builtIn).toBe(true);
      expect(t.body).toBeUndefined();
    }

    const create = await app.inject({ method: "POST", url: `${V1}${BASE}`, headers: auth(admin), payload: CUSTOM_TEMPLATE });
    expect(create.statusCode).toBe(201);

    const res2 = await app.inject({ method: "GET", url: `${V1}${BASE}`, headers: auth(admin) });
    const keys2 = (res2.json() as { templates: Array<{ key: string }> }).templates.map((t) => t.key);
    expect(keys2).toContain("custom-membership");
  });

  it("POST saves a valid custom template; rejects duplicate/built-in keys and structurally invalid templates", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const created = await app.inject({ method: "POST", url: `${V1}${BASE}`, headers: auth(admin), payload: CUSTOM_TEMPLATE });
    expect(created.statusCode).toBe(201);
    expect(created.json().key).toBe("custom-membership");

    const dup = await app.inject({ method: "POST", url: `${V1}${BASE}`, headers: auth(admin), payload: CUSTOM_TEMPLATE });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("TEMPLATE_KEY_TAKEN");

    const builtinDup = await app.inject({
      method: "POST", url: `${V1}${BASE}`, headers: auth(admin),
      payload: { ...CUSTOM_TEMPLATE, key: "education-certificate" },
    });
    expect(builtinDup.statusCode).toBe(409);
    expect(builtinDup.json().error).toBe("TEMPLATE_KEY_TAKEN");

    const invalid = await app.inject({
      method: "POST", url: `${V1}${BASE}`, headers: auth(admin),
      payload: { ...CUSTOM_TEMPLATE, key: "invalid-one", parameters: [{ name: "", label: "x", type: "text", required: false }], body: { ...CUSTOM_TEMPLATE.body, credentialTypes: [] } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("INVALID_TEMPLATE");
  });

  it("GET /:key returns the full template (with body) for a built-in; 404 for unknown", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await app.inject({ method: "GET", url: `${V1}${BASE}/education-certificate`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBeDefined();
    expect(res.json().body.credentialTypes.length).toBeGreaterThan(0);

    const missing = await app.inject({ method: "GET", url: `${V1}${BASE}/nope`, headers: auth(admin) });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /:key/preview instantiates a definition on valid params; 400 with problems on invalid params", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const ok = await app.inject({
      method: "POST", url: `${V1}${BASE}/education-certificate/preview`, headers: auth(admin),
      payload: { params: { issuerOrgName: "Acme University", jurisdiction: "IN" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().definition.name).toContain("Acme University");

    const bad = await app.inject({
      method: "POST", url: `${V1}${BASE}/education-certificate/preview`, headers: auth(admin),
      payload: { params: {} },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("INVALID_TEMPLATE_PARAMS");
    expect(Array.isArray(bad.json().problems)).toBe(true);
    expect(bad.json().problems.length).toBeGreaterThan(0);
  });
});
