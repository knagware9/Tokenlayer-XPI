import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

const pdfBase64 = (label: string): string => Buffer.from(`%PDF-1.4 fake ${label}`).toString("base64");

describe("org-approved notification", () => {
  it("POST /orgs/:id/approve emails the org's admin", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const orgName = `Approve Notify Org ${Date.now()}`;
    const adminEmail = `approve-notify-${Date.now()}@x.com`;
    // Real KYB flow: upload the certificate to the public endpoint first, then
    // reference its returned id — mirrors corporate.test.ts's registerPayload
    // helper (unexported there, so reproduced inline here).
    const upload = await h.app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: pdfBase64("cin") } });
    expect(upload.statusCode).toBe(201);
    const cinDocId = upload.json().id as string;
    const reg = await h.app.inject({
      method: "POST", url: `${V1}/orgs/register`,
      payload: {
        company: {
          name: orgName, orgType: "corporate", cin: `U${Date.now()}MH2020PTC000000`, pan: "AABCU9603R",
          state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-06-15",
          category: "private-limited", companyStatus: "active",
          documents: { cinCertificate: { id: cinDocId } },
        },
        admin: { name: "Notify Admin", email: adminEmail, password: "whatever-123" },
      },
    });
    expect(reg.statusCode).toBe(202);
    const orgId = reg.json().organizationId as string;
    const before = h.mail.sent.length;
    const approve = await h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: auth(platform), payload: {} });
    expect(approve.statusCode).toBe(200);
    // `.slice(before)` can also catch the OrganizationCredential-issued
    // notification (Task 10 hooks credential issuance itself, and approval
    // issues the org's OrganizationCredential to this same admin) — match on
    // subject to get the org-approved email specifically, not just any email
    // to this address.
    const sent = h.mail.sent.slice(before).find((m) => m.to === adminEmail && /approved/i.test(m.subject));
    expect(sent).toBeDefined();
    expect(sent!.text).toContain(orgName);
  });
});
