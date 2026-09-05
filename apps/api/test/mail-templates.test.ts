import { describe, expect, it } from "vitest";
import {
  credentialIssuedEmail,
  credentialRevokedEmail,
  kycDecisionEmail,
  orgApprovedEmail,
  passwordResetEmail,
  proposalAwaitingApprovalEmail,
  welcomeCredentialsEmail,
  welcomeSetPasswordEmail,
} from "../src/mail/templates.js";

describe("mail templates", () => {
  it("welcomeCredentialsEmail includes the email and password in plain text", () => {
    const t = welcomeCredentialsEmail({ email: "a@x.com", password: "hunter2", loginUrl: "https://app/login" });
    expect(t.text).toContain("a@x.com");
    expect(t.text).toContain("hunter2");
    expect(t.text).toContain("https://app/login");
    expect(t.subject).toMatch(/welcome/i);
  });

  it("welcomeSetPasswordEmail includes the set-password link, never a password", () => {
    const t = welcomeSetPasswordEmail({ email: "a@x.com", setPasswordUrl: "https://app/reset-password?token=abc" });
    expect(t.text).toContain("https://app/reset-password?token=abc");
    expect(t.text).not.toMatch(/password:/i);
  });

  it("passwordResetEmail includes the reset link", () => {
    const t = passwordResetEmail({ resetUrl: "https://app/reset-password?token=xyz" });
    expect(t.text).toContain("https://app/reset-password?token=xyz");
    expect(t.subject).toMatch(/reset/i);
  });

  it("kycDecisionEmail renders approved and rejected distinctly", () => {
    const approved = kycDecisionEmail({ decision: "approved" });
    const rejected = kycDecisionEmail({ decision: "rejected" });
    expect(approved.subject).toMatch(/approved/i);
    expect(rejected.subject).toMatch(/rejected/i);
  });

  it("orgApprovedEmail includes the org name and login link", () => {
    const t = orgApprovedEmail({ orgName: "Acme Corp", loginUrl: "https://app/login" });
    expect(t.text).toContain("Acme Corp");
    expect(t.text).toContain("https://app/login");
  });

  it("credentialIssuedEmail includes the credential type and issuer", () => {
    const t = credentialIssuedEmail({ credentialType: "KycCredential", issuerName: "TokenLayer Platform" });
    expect(t.text).toContain("KycCredential");
    expect(t.text).toContain("TokenLayer Platform");
  });

  it("credentialRevokedEmail includes the credential type and reason", () => {
    const t = credentialRevokedEmail({ credentialType: "KycCredential", reason: "holder offboarded" });
    expect(t.text).toContain("KycCredential");
    expect(t.text).toContain("holder offboarded");
  });

  it("proposalAwaitingApprovalEmail includes the kind and proposer", () => {
    const t = proposalAwaitingApprovalEmail({ kind: "create-use-case", proposerLabel: "admin@acme.com", approvalsUrl: "https://app/approvals" });
    expect(t.text).toContain("create-use-case");
    expect(t.text).toContain("admin@acme.com");
    expect(t.text).toContain("https://app/approvals");
  });

  // HTML-escaping: org names, proposer labels, and revoke reasons are
  // attacker-reachable (public POST /orgs/register and POST /users have no
  // pattern restriction on these fields) and land in mail sent to third
  // parties and every PlatformAdmin — the `html` output must never carry raw
  // markup from them. `text` is untouched (plain text is safe as-is).
  it("orgApprovedEmail escapes HTML in the org name", () => {
    const t = orgApprovedEmail({ orgName: `<script>alert(1)</script>`, loginUrl: "https://app/login" });
    expect(t.html).not.toContain("<script>");
    expect(t.html).toContain("&lt;script&gt;");
    expect(t.text).toContain("<script>alert(1)</script>"); // text is unescaped by design
  });

  it("credentialRevokedEmail escapes HTML in the reason", () => {
    const t = credentialRevokedEmail({ credentialType: "KycCredential", reason: `bad" onmouseover="alert(1)` });
    expect(t.html).not.toContain(`bad" onmouseover="alert(1)`);
    expect(t.html).toContain("&quot;");
  });

  it("proposalAwaitingApprovalEmail escapes HTML in the proposer label", () => {
    const t = proposalAwaitingApprovalEmail({ kind: "onboard-user", proposerLabel: `<img src=x onerror=alert(1)>`, approvalsUrl: "https://app/approvals" });
    expect(t.html).not.toContain("<img");
    expect(t.html).toContain("&lt;img");
  });
});
