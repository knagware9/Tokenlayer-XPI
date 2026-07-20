import { describe, expect, it } from "vitest";
import { buildTestApp, V1 } from "./helpers.js";

const registerBody = {
  company: { name: "Globex Trade Pvt Ltd", orgType: "corporate", registrationId: "U12345", jurisdiction: "IN" },
  admin: { name: "Rhea Kapoor", email: "rhea@globex.dev", password: "corp-secret-1" },
};

describe("corporate self-registration", () => {
  it("creates a pending org (DID minted, not on-chain) + a pending admin who cannot log in", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending");
    const orgId = res.json().organizationId;
    expect(typeof orgId).toBe("string");
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: registerBody.admin.email, password: registerBody.admin.password } });
    expect(login.statusCode).toBe(401);
  });
  it("rejects a verifier orgType and duplicate name/registration/email", async () => {
    const app = await buildTestApp();
    const verifier = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, orgType: "verifier" } } });
    expect(verifier.statusCode).toBe(400);
    await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: registerBody });
    const dupName = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, admin: { ...registerBody.admin, email: "other@x.dev" } } });
    expect(dupName.statusCode).toBe(409);
    const dupEmail = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, name: "Different Co", registrationId: "U999" } } });
    expect(dupEmail.statusCode).toBe(409);
    const dupRegistrationId = await app.inject({ method: "POST", url: `${V1}/orgs/register`, payload: { ...registerBody, company: { ...registerBody.company, name: "Yet Another Co" }, admin: { ...registerBody.admin, email: "third@x.dev" } } });
    expect(dupRegistrationId.statusCode).toBe(409);
  });
});
