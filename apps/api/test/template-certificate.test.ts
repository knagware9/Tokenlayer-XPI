import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

// ID-J3: proves certificate config survives the WHOLE api stack, end to end —
// from a template (built-in or saved) through instantiation/provisioning,
// persistence, issuance, and finally a live rendered PDF. No production api
// changes are EXPECTED here: template bodies persist as JSON and routes call
// the already-tested core functions (ID-J1/J2) and the ID-I PDF route. This
// file exists to catch a handler or fast-json-stringify response schema that
// silently strips `certificate` anywhere along that path (the ID-G G3 trap:
// a strict/ref response schema without `additionalProperties: true` drops
// unlisted nested fields).

const TEMPLATES = "/credential-use-case-templates";
const PROVISION = "/credential-use-cases/provision";

function pdfBuf(res: { rawPayload?: Buffer; payload: string }): Buffer {
  return res.rawPayload ?? Buffer.from(res.payload, "binary");
}

describe("template certificate pass-through", () => {
  it("1. provisioning from the domicile-certificate built-in interpolates certificate config through the whole stack", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: {
        templateKey: "domicile-certificate",
        params: { issuerOrgName: "Tehsildar Alpha" },
        provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: "tehsildar-alpha.gov" },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      useCase: { key: string; credentialTypes: Array<{ name: string; certificate?: { enabled: boolean; subheading?: string } }> };
      deskUsers: Array<{ email: string; password: string; role: string }>;
    };
    const domicileType = body.useCase.credentialTypes.find((t) => t.name === "DomicileCredential")!;
    expect(domicileType.certificate?.enabled).toBe(true);
    expect(domicileType.certificate?.subheading).toBe("Tehsildar Alpha");

    await app.close();
  });

  it("2. issue -> approve -> live PDF for a credential issued under a certificate-enabled provisioned use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");

    const prov = await app.inject({
      method: "POST", url: `${V1}${PROVISION}`, headers: auth(admin),
      payload: {
        templateKey: "domicile-certificate",
        params: { issuerOrgName: "Tehsildar Beta" },
        provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: "tehsildar-beta.gov" },
      },
    });
    expect(prov.statusCode).toBe(201);
    const provBody = prov.json() as {
      useCase: { key: string };
      deskUsers: Array<{ email: string; password: string; role: string }>;
    };
    const ucKey = provBody.useCase.key;
    const issuerDesk = provBody.deskUsers.find((u) => u.role === "Issuer")!;
    const holderDesk = provBody.deskUsers.find((u) => u.role === "Holder")!;
    expect(issuerDesk).toBeDefined();
    expect(holderDesk).toBeDefined();

    const issuerTok = await loginAs(app, issuerDesk.email, issuerDesk.password);

    // Find the Holder desk user through the eligible-holders lens (holderPolicy: any-onboarded).
    const eligible = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${ucKey}/eligible-holders`, headers: auth(issuerTok) });
    expect(eligible.statusCode).toBe(200);
    const holderEntry = (eligible.json() as Array<{ kind: string; id: string; label: string }>).find((e) => e.kind === "user" && e.label === holderDesk.email);
    expect(holderEntry).toBeDefined();

    const issued = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${ucKey}/credentials`, headers: auth(issuerTok),
      payload: {
        credentialType: "DomicileCredential",
        subjectUserId: holderEntry!.id,
        claims: { holderName: "Asha Rao", state: "Statelandia", district: "Central", continuousResidenceSinceYear: 2009 },
      },
    });
    expect(issued.statusCode).toBe(202);
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);

    const holderTok = await loginAs(app, holderDesk.email, holderDesk.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderTok) });
    expect(held.statusCode).toBe(200);
    const rows = held.json() as Array<{ id: string; type: string[]; certificateAvailable: boolean }>;
    const cred = rows.find((c) => c.type.includes("DomicileCredential"));
    expect(cred).toBeDefined();
    expect(cred!.certificateAvailable).toBe(true);

    const pdf = await app.inject({ method: "GET", url: `${V1}/credentials/${cred!.id}/certificate.pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/^application\/pdf/);
    const buf = pdfBuf(pdf);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(800);

    await app.close();
  });

  it("3. a saved custom template round-trips certificate config through save / get / preview", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const custom = {
      key: "my-cert-tpl",
      name: "My Cert Tpl",
      category: "custom",
      parameters: [],
      body: {
        keyTemplate: "my-cert-uc",
        nameTemplate: "My Cert UC",
        holderPolicy: { who: "any-onboarded" },
        verifier: { kind: "any" },
        credentialTypes: [
          {
            name: "ThingCredential",
            title: "Thing",
            validityDays: 365,
            requiredApprovals: 1,
            required: ["label"],
            properties: { label: { type: "string" } },
            certificate: { enabled: true, heading: "Thing Certificate", claimOrder: ["label"] },
          },
        ],
      },
    };

    const create = await app.inject({ method: "POST", url: `${V1}${TEMPLATES}`, headers: auth(admin), payload: custom });
    expect(create.statusCode).toBe(201);

    const get = await app.inject({ method: "GET", url: `${V1}${TEMPLATES}/my-cert-tpl`, headers: auth(admin) });
    expect(get.statusCode).toBe(200);
    const savedType = (get.json() as { body: { credentialTypes: Array<{ certificate?: { enabled: boolean; heading?: string; claimOrder?: string[] } }> } }).body.credentialTypes[0];
    expect(savedType.certificate?.enabled).toBe(true);
    expect(savedType.certificate?.heading).toBe("Thing Certificate");
    expect(savedType.certificate?.claimOrder).toEqual(["label"]);

    const preview = await app.inject({ method: "POST", url: `${V1}${TEMPLATES}/my-cert-tpl/preview`, headers: auth(admin), payload: {} });
    expect(preview.statusCode).toBe(200);
    const previewedType = (preview.json() as { definition: { credentialTypes: Array<{ certificate?: { enabled: boolean } }> } }).definition.credentialTypes[0];
    expect(previewedType.certificate?.enabled).toBe(true);

    await app.close();
  });

  it("4. saving a template whose certificate.claimOrder references an unknown claim 400s INVALID_TEMPLATE", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const bad = {
      key: "my-cert-tpl-bad",
      name: "My Cert Tpl Bad",
      category: "custom",
      parameters: [],
      body: {
        keyTemplate: "my-cert-uc-bad",
        nameTemplate: "My Cert UC Bad",
        holderPolicy: { who: "any-onboarded" },
        verifier: { kind: "any" },
        credentialTypes: [
          {
            name: "ThingCredential",
            title: "Thing",
            validityDays: 365,
            requiredApprovals: 1,
            required: ["label"],
            properties: { label: { type: "string" } },
            certificate: { enabled: true, claimOrder: ["ghost"] },
          },
        ],
      },
    };

    const res = await app.inject({ method: "POST", url: `${V1}${TEMPLATES}`, headers: auth(admin), payload: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_TEMPLATE");

    await app.close();
  });
});
