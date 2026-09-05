/** One small function per outbound email. No templating engine — eight fixed shapes, YAGNI. */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const wrap = (paragraphs: string[]): string => paragraphs.map((p) => `<p>${p}</p>`).join("\n");

/**
 * HTML-escape a value before it lands in an `html` template. Several of these
 * values are attacker-reachable (org names via the public `POST /orgs/register`,
 * user emails via `POST /users` — neither field is pattern-restricted) and end
 * up in mail sent to third parties and to every PlatformAdmin, so every `${...}`
 * interpolated into an `html` string (never `text`, which is safe as-is) must go
 * through this first — URLs included, for attribute-context consistency even
 * though every URL here is internally constructed, never caller-supplied.
 */
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function welcomeCredentialsEmail(a: { email: string; password: string; loginUrl: string }): EmailContent {
  const text = `Welcome to TokenLayer.\n\nYour login: ${a.email}\nYour password: ${a.password}\n\nSign in at ${a.loginUrl}\n\nWe recommend changing your password after your first sign-in.`;
  return {
    subject: "Welcome to TokenLayer — your login details",
    text,
    html: wrap([
      "Welcome to TokenLayer.",
      `Your login: <strong>${esc(a.email)}</strong><br>Your password: <strong>${esc(a.password)}</strong>`,
      `Sign in at <a href="${esc(a.loginUrl)}">${esc(a.loginUrl)}</a>`,
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
      `An account was created for <strong>${esc(a.email)}</strong>. Set your password to finish signing in:`,
      `<a href="${esc(a.setPasswordUrl)}">${esc(a.setPasswordUrl)}</a>`,
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
      `<a href="${esc(a.resetUrl)}">${esc(a.resetUrl)}</a>`,
      "This link expires in 30 minutes. If you didn't request this, ignore this email.",
    ]),
  };
}

export function kycDecisionEmail(a: { decision: "approved" | "rejected"; rejectionReason?: string }): EmailContent {
  const verb = a.decision === "approved" ? "approved" : "rejected";
  const reasonLine = a.decision === "rejected" && a.rejectionReason ? `\n\nReason: ${a.rejectionReason}` : "";
  const text = `Your KYC verification was ${verb}.${reasonLine}`;
  const htmlParts = [esc(`Your KYC verification was ${verb}.`)];
  if (a.decision === "rejected" && a.rejectionReason) htmlParts.push(`Reason: ${esc(a.rejectionReason)}`);
  return { subject: `Your KYC verification was ${verb}`, text, html: wrap(htmlParts) };
}

export function orgApprovedEmail(a: { orgName: string; loginUrl: string }): EmailContent {
  const text = `${a.orgName} has been approved on TokenLayer.\n\nSign in at ${a.loginUrl}`;
  return {
    subject: `${a.orgName} is now approved`,
    text,
    html: wrap([`<strong>${esc(a.orgName)}</strong> has been approved on TokenLayer.`, `Sign in at <a href="${esc(a.loginUrl)}">${esc(a.loginUrl)}</a>`]),
  };
}

export function credentialIssuedEmail(a: { credentialType: string; issuerName: string }): EmailContent {
  const text = `A ${a.credentialType} credential was issued to you by ${a.issuerName}.`;
  return { subject: `You received a ${a.credentialType} credential`, text, html: wrap([`A ${esc(a.credentialType)} credential was issued to you by ${esc(a.issuerName)}.`]) };
}

export function credentialRevokedEmail(a: { credentialType: string; reason: string }): EmailContent {
  const text = `Your ${a.credentialType} credential was revoked.\n\nReason: ${a.reason}`;
  return { subject: `Your ${a.credentialType} credential was revoked`, text, html: wrap([`Your ${esc(a.credentialType)} credential was revoked.`, `Reason: ${esc(a.reason)}`]) };
}

export function proposalAwaitingApprovalEmail(a: { kind: string; proposerLabel: string; approvalsUrl: string }): EmailContent {
  const text = `A '${a.kind}' proposal from ${a.proposerLabel} is awaiting your approval.\n\nReview it at ${a.approvalsUrl}`;
  return {
    subject: `Approval needed: ${a.kind}`,
    text,
    html: wrap([`A '${esc(a.kind)}' proposal from <strong>${esc(a.proposerLabel)}</strong> is awaiting your approval.`, `Review it at <a href="${esc(a.approvalsUrl)}">${esc(a.approvalsUrl)}</a>`]),
  };
}
