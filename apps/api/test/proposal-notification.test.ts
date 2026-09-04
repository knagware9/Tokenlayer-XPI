import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const platformAdmin = (h: TestAppHandle): Promise<string> => loginAs(h.app, "admin@tokenlayer.dev", "admin123");

async function makeOrg(h: TestAppHandle, admin: string, name: string): Promise<string> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType: "corporate" } });
  if (res.statusCode !== 201) throw new Error(`makeOrg(${name}) failed: ${res.statusCode} ${res.payload}`);
  return res.json().id as string;
}

async function makeOrgAdmin(h: TestAppHandle, admin: string, orgId: string, email: string): Promise<string> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: { email, password: "secret1", role: "OrgAdmin" } });
  if (res.statusCode !== 201) throw new Error(`makeOrgAdmin failed: ${res.statusCode} ${res.payload}`);
  return loginAs(h.app, email, "secret1");
}

describe("proposal-awaiting-approval notification", () => {
  it("an OrgAdmin's create-use-case proposal emails every active PlatformAdmin", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, `Notify Org ${Date.now()}`);
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, `notify-org-admin-${Date.now()}@x.com`);
    const before = h.mail.sent.length;
    const res = await h.app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(orgAdmin),
      payload: {
        key: `notify-${Date.now()}`, name: "Notify Test", symbol: "NTS", tokenStandard: "ERC-20",
        allowedChainIds: ["fabric"], defaultChainId: "fabric",
        metadataSchema: { type: "object", properties: {} },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: true, transferRestrictions: false },
        roles: ["UseCaseAdmin", "Issuer"],
      },
    });
    expect(res.statusCode).toBe(202);
    const sent = h.mail.sent.slice(before).find((m) => m.to === "admin@tokenlayer.dev");
    expect(sent).toBeDefined();
    expect(sent!.subject).toMatch(/approval needed/i);
    expect(sent!.text).toContain("create-use-case");
  });
});
