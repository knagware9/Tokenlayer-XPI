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

const PROVISION = "/credential-use-cases/provision";
const ROLES = ["Issuer", "Holder", "Verifier"] as const;

describe("POST /credential-use-cases/provision", () => {
  it("one-step provisions org + use case + three scoped desk users, and each desk user can log in", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: "Acme University", jurisdiction: "IN" },
        provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: "acme.edu" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      org: { id: string; name: string; did: string };
      useCase: { key: string; issuer: { kind: string; orgId?: string } };
      deskUsers: Array<{ email: string; password: string; role: string }>;
    };
    expect(body.org.name).toBe("Acme University");
    expect(body.org.did.startsWith("did:key:z")).toBe(true);
    // The use case is bound to the provisioned org (never the platform placeholder).
    expect(body.useCase.issuer.kind).toBe("org");
    expect(body.useCase.issuer.orgId).toBe(body.org.id);

    // The org is discoverable through the normal listing.
    const orgs = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) })).json() as Array<{ name: string }>;
    expect(orgs.filter((o) => o.name === "Acme University")).toHaveLength(1);

    // The use case is persisted and bound.
    const uc = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${body.useCase.key}`, headers: auth(admin) });
    expect(uc.statusCode).toBe(200);
    expect(uc.json().issuer.orgId).toBe(body.org.id);

    // Exactly three desk users, one per role, each with a one-time plaintext password.
    expect(body.deskUsers).toHaveLength(3);
    for (const role of ROLES) {
      const du = body.deskUsers.find((u) => u.role === role);
      expect(du).toBeDefined();
      expect(du!.email).toBe(`${role.toLowerCase()}@acme.edu`);
      expect(typeof du!.password).toBe("string");
      expect(du!.password.length).toBeGreaterThan(0);

      // Each desk user logs in and lands on the identity domain scoped to this use case.
      const token = await loginAs(app, du!.email, du!.password);
      expect(token).toBeTruthy();
      const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
      expect(me.statusCode).toBe(200);
      expect(me.json().role).toBe(role);
      expect(me.json().useCaseKey).toBe(body.useCase.key);
      expect(me.json().useCaseDomain).toBe("identity");
    }
    await app.close();
  });

  it("is idempotent — a second identical call reuses the org and does not 500", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const payload = {
      templateKey: "education-certificate",
      params: { issuerOrgName: "Repeat University", jurisdiction: "IN" },
      provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: "repeat.edu" },
    };
    const first = await app.inject({ method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin), payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin), payload });
    expect(second.statusCode).toBeLessThan(500);
    expect([200, 201]).toContain(second.statusCode);

    // The org was reused, not duplicated.
    const orgs = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) })).json() as Array<{ name: string }>;
    expect(orgs.filter((o) => o.name === "Repeat University")).toHaveLength(1);
    await app.close();
  });

  it("createDeskUsers:false provisions org + use case only", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: "NoDesk University", jurisdiction: "IN" },
        provisioning: { issuerOrgType: "government", createDeskUsers: false },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().deskUsers).toEqual([]);
    await app.close();
  });

  it("400s INVALID_TEMPLATE_PARAMS when a required param is missing", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: { templateKey: "education-certificate", params: {}, provisioning: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_TEMPLATE_PARAMS");
    expect(Array.isArray(res.json().problems)).toBe(true);
    await app.close();
  });

  it("404s an unknown template", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: { templateKey: "no-such-template", params: { issuerOrgName: "X" }, provisioning: {} },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("an OrgAdmin may provision only for their OWN org (else 403)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Create the OrgAdmin's org and an OrgAdmin member of it.
    const orgA = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Scoped University", orgType: "government" } })).json();
    const mk = await app.inject({
      method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `orgadmin.${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" },
    });
    expect(mk.statusCode).toBe(201);
    const orgAdmin = await loginAs(app, `orgadmin.${orgA.id}@x.io`, "secret1");

    // Provisioning for a DIFFERENT org name is forbidden.
    const forbidden = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(orgAdmin),
      payload: { templateKey: "education-certificate", params: { issuerOrgName: "Some Other University" }, provisioning: { createDeskUsers: false } },
    });
    expect(forbidden.statusCode).toBe(403);

    // Provisioning for their OWN org succeeds.
    const ok = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(orgAdmin),
      payload: { templateKey: "education-certificate", params: { issuerOrgName: "Scoped University" }, provisioning: { createDeskUsers: false } },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().org.id).toBe(orgA.id);
    expect(ok.json().useCase.issuer.orgId).toBe(orgA.id);
    await app.close();
  });
});
