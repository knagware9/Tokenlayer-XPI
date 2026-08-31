// apps/api/test/selective-disclosure.test.ts
/**
 * End-to-end selective disclosure: a verifier requests a predicate on a
 * numeric claim, the holder discloses less than asked, a withheld field never
 * appears, and old-shape (no disclosures) consent still discloses in full.
 *
 * Modeled on credential-usecase-verify.test.ts's full-runtime fixture — a
 * custom use case is needed because none of the built-in CREDENTIAL_TYPES has
 * a numeric claim field.
 */
import { describe, expect, it } from "vitest";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const DEF = {
  key: "sd-domicile", name: "Selective Disclosure Domicile",
  credentialTypes: [{
    name: "DomicileCredential", title: "Domicile", validityDays: 365, requiredApprovals: 1,
    claimSchema: {
      type: "object", required: ["holderName", "continuousResidenceSinceYear"],
      properties: { holderName: { type: "string" }, continuousResidenceSinceYear: { type: "number" } },
    },
  }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

async function setup() {
  const anchor = new FakeAnchor();
  const app = await buildTestApp({ registry: fakeRegistry(anchor) });
  const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

  const holderOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `SD Holder Co ${Date.now()}`, orgType: "corporate" } })).json();
  const holderEmail = `sd.holder.${Date.now()}@x.io`;
  const holderMk = await app.inject({ method: "POST", url: `${V1}/orgs/${holderOrg.id}/users`, headers: auth(admin), payload: { email: holderEmail, password: "secret1", role: "Issuer" } });
  expect(holderMk.statusCode).toBe(201);
  const holder = holderMk.json() as { id: string; did: string };
  const holderToken = await loginAs(app, holderEmail, "secret1");

  const issued = await app.inject({
    method: "POST", url: `${V1}/credential-use-cases/sd-domicile/credentials`, headers: auth(admin),
    payload: { credentialType: "DomicileCredential", subjectUserId: holder.id, claims: { holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 } },
  });
  expect(issued.statusCode).toBe(202);
  expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);
  const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) });
  const credentialId = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("DomicileCredential"))!.id;

  const verifierOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `SD Verifier Co ${Date.now()}`, orgType: "corporate" } })).json();
  const verifierEmail = `sd.verifier.${Date.now()}@x.io`;
  const vMk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifierOrg.id}/users`, headers: auth(admin), payload: { email: verifierEmail, password: "secret1", role: "OrgAdmin" } });
  expect(vMk.statusCode).toBe(201);
  const verifierToken = await loginAs(app, verifierEmail, "secret1");

  return { app, holder, holderToken, verifierToken, credentialId };
}

function createRequest(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(token), payload: { holderDid: undefined, requestedTypes: ["DomicileCredential"], purpose: "check", credentialUseCaseKey: "sd-domicile", ...body } });
}
function consent(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, id: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests/${id}/consent`, headers: auth(token), payload: body });
}
function verify(app: Awaited<ReturnType<typeof buildTestApp>>, token: string, id: string) {
  return app.inject({ method: "GET", url: `${V1}/verification-requests/${id}/verify`, headers: auth(token) });
}

describe("selective disclosure", () => {
  it("requesting a predicate on a non-numeric field is refused at create time", async () => {
    const { app, holder, verifierToken } = await setup();
    const res = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_PREDICATE_FIELD");
  });

  it("requesting an unknown field is refused at create time", async () => {
    const { app, holder, verifierToken } = await setup();
    const res = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { notAField: { kind: "value" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_FIELD");
  });

  it("the holder's inbox carries claims on each eligible credential, so the consent UI needs no second round-trip", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const inboxRes = await app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(holderToken) });
    expect(inboxRes.statusCode).toBe(200);
    const rows = inboxRes.json() as Array<{ id: string; eligibleCredentials: Array<{ id: string; claims: Record<string, unknown> }> }>;
    const row = rows.find((r) => r.id === requestId)!;
    const eligible = row.eligibleCredentials.find((c) => c.id === credentialId)!;
    expect(eligible.claims).toEqual({ id: holder.did, holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 });
  });

  it("disclosing a predicate on a non-numeric field is refused at consent time", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const res = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "predicate", op: "eq", threshold: 1 } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_PREDICATE_FIELD");
  });

  it("disclosing an unknown field is refused at consent time", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const res = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { notAField: { kind: "value" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_FIELD");
  });

  it("a predicate consent evaluates correctly and /verify never returns the raw value", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    expect(created.json().requestedFields).toEqual({ DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } });

    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(consented.statusCode).toBe(200);

    const result = (await verify(app, verifierToken, requestId)).json();
    const claims = result.credentials[0].claims;
    expect(claims).toEqual({ continuousResidenceSinceYear: { predicate: { op: "lte", threshold: 2011, result: true } } });
    expect(JSON.stringify(claims)).not.toContain("2010");
  });

  it("a withheld field is absent from /verify's response", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "withhold" } } },
    });
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar" });
  });

  it("the holder can disclose fewer fields than requested — consent is never blocked", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { holderName: { kind: "value" }, continuousResidenceSinceYear: { kind: "value" } } },
    });
    const requestId = created.json().id as string;
    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { holderName: { kind: "value" } } }, // continuousResidenceSinceYear left off entirely
    });
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar" });
  });

  it("a holder-volunteered predicate on a field not requested as one is honored", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    // Verifier asks for the raw value...
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "value" } } },
    });
    const requestId = created.json().id as string;
    // ...but the holder chooses to disclose a predicate instead, with their own threshold.
    const consented = await consent(app, holderToken, requestId, {
      credentialIds: [credentialId],
      disclosures: { [credentialId]: { continuousResidenceSinceYear: { kind: "predicate", op: "gte", threshold: 2000 } } },
    });
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ continuousResidenceSinceYear: { predicate: { op: "gte", threshold: 2000, result: true } } });
  });

  it("old-shape consent (no disclosures) still discloses every field in full", async () => {
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, { holderDid: holder.did });
    const requestId = created.json().id as string;
    const consented = await consent(app, holderToken, requestId, { credentialIds: [credentialId] }); // no `disclosures` key at all
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 });
  });

  it("requestedFields is advisory even when specific: consenting WITHOUT a disclosures body still discloses in full", async () => {
    // The verifier asks for a predicate on a specific field this time — proving
    // that a specific ask, not just an empty one, still never blocks or
    // partially discloses an old-shape consent.
    const { app, holder, holderToken, verifierToken, credentialId } = await setup();
    const created = await createRequest(app, verifierToken, {
      holderDid: holder.did,
      requestedFields: { DomicileCredential: { continuousResidenceSinceYear: { kind: "predicate", op: "lte", threshold: 2011 } } },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    const consented = await consent(app, holderToken, requestId, { credentialIds: [credentialId] }); // no `disclosures` key at all
    expect(consented.statusCode).toBe(200);
    const result = (await verify(app, verifierToken, requestId)).json();
    expect(result.credentials[0].claims).toEqual({ holderName: "Ramesh Kumar", continuousResidenceSinceYear: 2010 });
    expect(result.valid).toBe(true);
  });
});
