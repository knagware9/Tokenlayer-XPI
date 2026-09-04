/** One small function per outbound email. No templating engine — eight fixed shapes, YAGNI. */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const wrap = (paragraphs: string[]): string => paragraphs.map((p) => `<p>${p}</p>`).join("\n");

export function welcomeCredentialsEmail(a: { email: string; password: string; loginUrl: string }): EmailContent {
  const text = `Welcome to TokenLayer.\n\nYour login: ${a.email}\nYour password: ${a.password}\n\nSign in at ${a.loginUrl}\n\nWe recommend changing your password after your first sign-in.`;
  return {
    subject: "Welcome to TokenLayer — your login details",
    text,
    html: wrap([
      "Welcome to TokenLayer.",
      `Your login: <strong>${a.email}</strong><br>Your password: <strong>${a.password}</strong>`,
      `Sign in at <a href="${a.loginUrl}">${a.loginUrl}</a>`,
      "We recommend changing your password after your first sign-in.",
    ]),
  };
}

export function welcomeSetPasswordEmail(a: { email: string; setPasswordUrl: string }): EmailContent {
  const text = `Welcome to TokenLayer.\n\nAn account was created for ${a.email}. Set your password to finish signing in:\n${a.setPasswordUrl}\n\nThis link expires in 30 minutes.`;
  return {
    subject: "Welcome to TokenLayer — set your password",
    text,
    html: wrap([
      "Welcome to TokenLayer.",
      `An account was created for <strong>${a.email}</strong>. Set your password to finish signing in:`,
      `<a href="${a.setPasswordUrl}">${a.setPasswordUrl}</a>`,
      "This link expires in 30 minutes.",
    ]),
  };
}

export function passwordResetEmail(a: { resetUrl: string }): EmailContent {
  const text = `Reset your TokenLayer password:\n${a.resetUrl}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email.`;
  return {
    subject: "Reset your TokenLayer password",
    text,
    html: wrap([
      "Reset your TokenLayer password:",
      `<a href="${a.resetUrl}">${a.resetUrl}</a>`,
      "This link expires in 30 minutes. If you didn't request this, ignore this email.",
    ]),
  };
}

export function kycDecisionEmail(a: { decision: "approved" | "rejected" }): EmailContent {
  const verb = a.decision === "approved" ? "approved" : "rejected";
  const text = `Your KYC verification was ${verb}.`;
  return { subject: `Your KYC verification was ${verb}`, text, html: wrap([text]) };
}

export function orgApprovedEmail(a: { orgName: string; loginUrl: string }): EmailContent {
  const text = `${a.orgName} has been approved on TokenLayer.\n\nSign in at ${a.loginUrl}`;
  return {
    subject: `${a.orgName} is now approved`,
    text,
    html: wrap([`<strong>${a.orgName}</strong> has been approved on TokenLayer.`, `Sign in at <a href="${a.loginUrl}">${a.loginUrl}</a>`]),
  };
}

export function credentialIssuedEmail(a: { credentialType: string; issuerName: string }): EmailContent {
  const text = `A ${a.credentialType} credential was issued to you by ${a.issuerName}.`;
  return { subject: `You received a ${a.credentialType} credential`, text, html: wrap([text]) };
}

export function credentialRevokedEmail(a: { credentialType: string; reason: string }): EmailContent {
  const text = `Your ${a.credentialType} credential was revoked.\n\nReason: ${a.reason}`;
  return { subject: `Your ${a.credentialType} credential was revoked`, text, html: wrap([`Your ${a.credentialType} credential was revoked.`, `Reason: ${a.reason}`]) };
}

export function proposalAwaitingApprovalEmail(a: { kind: string; proposerLabel: string; approvalsUrl: string }): EmailContent {
  const text = `A '${a.kind}' proposal from ${a.proposerLabel} is awaiting your approval.\n\nReview it at ${a.approvalsUrl}`;
  return {
    subject: `Approval needed: ${a.kind}`,
    text,
    html: wrap([`A '${a.kind}' proposal from <strong>${a.proposerLabel}</strong> is awaiting your approval.`, `Review it at <a href="${a.approvalsUrl}">${a.approvalsUrl}</a>`]),
  };
}
