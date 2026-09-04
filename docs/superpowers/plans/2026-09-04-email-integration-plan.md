# Email Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the platform real outbound email — password reset, welcome emails, and notifications for KYC/org/credential/proposal events — with zero email infrastructure existing today.

**Architecture:** A small `apps/api/src/mail/` module (a `Mailer` interface, an SMTP implementation via `nodemailer`, a `NullMailer` test double, and template functions) is added to `AppDeps` as `deps.mail`. A new `PasswordResetToken` table (mirroring `ApiKey`'s prefix+bcrypt-hash pattern) backs a public forgot/reset-password route pair. Every other email is sent from the single existing chokepoint each event already funnels through — `issueCredentialFor`/`revokeCredentialById` for credentials, the two direct-activation routes for welcome emails, `onboardSingle` for gated onboarding, and a new `createProposalAndNotify` wrapper for proposal creation — never scattered ad hoc across route handlers.

**Tech Stack:** Fastify, Prisma (SQLite), `nodemailer`, `bcryptjs`, vitest, React (web), Mailpit (dev SMTP catcher in Docker Compose).

**Spec:** [docs/superpowers/specs/2026-09-04-email-integration-design.md](../specs/2026-09-04-email-integration-design.md)

## Global Constraints

- Reuse `deps.publicWebUrl` (already exists, env `PUBLIC_WEB_URL`) for building links in emails — do NOT add a new `WEB_ORIGIN` var as the spec's draft suggested; it would duplicate an existing value.
- Every mail send is wrapped in try/catch and logged, never thrown — mirrors the `emitEvent` posture ("observing must not break acting") already established in `apps/api/src/shared/events.ts`.
- Tests use `NullMailer` (records sent messages, no network) — never a real SMTP call in the test suite.
- Reset-token secrets: bcrypt cost `API_KEY_BCRYPT_ROUNDS` (10) from `apps/api/src/shared/api-keys.ts` — high-entropy random tokens, same reasoning as API keys, not `BCRYPT_ROUNDS` (12, for human-chosen passwords).
- New Prisma model `PasswordResetToken` is `domain: shared` (same as `User`).
- Every `AppDeps` construction site must be updated in the same task that adds a field: `apps/api/src/server.ts` (production) and `apps/api/test/helpers.ts` (tests) are the only two.

---

### Task 1: Mailer module — interface, NullMailer, SmtpMailer

**Files:**
- Modify: `apps/api/package.json` (add `nodemailer` dependency)
- Create: `apps/api/src/mail/mailer.ts`
- Test: `apps/api/test/mailer.test.ts`

**Interfaces:**
- Produces: `Mailer` interface (`send(to, subject, text, html): Promise<void>`), `SentMail` type, `NullMailer` class (`sent: SentMail[]`), `SmtpMailer` class (constructor `(from: string, opts: { host: string; port: number; user?: string; pass?: string })`).

- [ ] **Step 1: Add the `nodemailer` dependency**

```bash
cd "apps/api" && pnpm add nodemailer && pnpm add -D @types/nodemailer
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/mailer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { NullMailer } from "../src/mail/mailer.js";

describe("NullMailer", () => {
  it("records every send instead of transmitting it", async () => {
    const mailer = new NullMailer();
    await mailer.send("a@example.com", "Subject one", "text one", "<p>html one</p>");
    await mailer.send("b@example.com", "Subject two", "text two", "<p>html two</p>");
    expect(mailer.sent).toEqual([
      { to: "a@example.com", subject: "Subject one", text: "text one", html: "<p>html one</p>" },
      { to: "b@example.com", subject: "Subject two", text: "text two", html: "<p>html two</p>" },
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/mailer.test.ts`
Expected: FAIL — `src/mail/mailer.ts` does not exist.

- [ ] **Step 4: Write the mailer module**

Create `apps/api/src/mail/mailer.ts`:

```typescript
/**
 * Outbound email. `SmtpMailer` is the real transport (nodemailer over SMTP —
 * Mailpit in dev, a real provider's SMTP endpoint in production); `NullMailer`
 * is the test double every suite uses instead, mirroring how the webhook
 * dispatcher is tested without a live HTTP call.
 */
import nodemailer from "nodemailer";

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(to: string, subject: string, text: string, html: string): Promise<void>;
}

export class NullMailer implements Mailer {
  readonly sent: SentMail[] = [];
  async send(to: string, subject: string, text: string, html: string): Promise<void> {
    this.sent.push({ to, subject, text, html });
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: nodemailer.Transporter;
  constructor(private readonly from: string, opts: SmtpOptions) {
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      // Mailpit (dev) takes unauthenticated SMTP — omitting `auth` entirely
      // (not an empty-string user/pass) is what nodemailer requires to skip
      // the AUTH handshake a real provider would otherwise fail on.
      auth: opts.user && opts.pass ? { user: opts.user, pass: opts.pass } : undefined,
    });
  }
  async send(to: string, subject: string, text: string, html: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text, html });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "apps/api" && pnpm exec vitest run test/mailer.test.ts`
Expected: PASS (2 assertions in 1 test).

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/mail/mailer.ts apps/api/test/mailer.test.ts
git commit -m "feat(mail): add Mailer interface with SMTP and null implementations"
```

---

### Task 2: Email templates

**Files:**
- Create: `apps/api/src/mail/templates.ts`
- Test: `apps/api/test/mail-templates.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `EmailContent { subject: string; text: string; html: string }` and eight template functions, each `(args) => EmailContent`: `welcomeCredentialsEmail`, `welcomeSetPasswordEmail`, `passwordResetEmail`, `kycDecisionEmail`, `orgApprovedEmail`, `credentialIssuedEmail`, `credentialRevokedEmail`, `proposalAwaitingApprovalEmail`. Later tasks call these by name with the exact argument shapes below.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/mail-templates.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/mail-templates.test.ts`
Expected: FAIL — `src/mail/templates.ts` does not exist.

- [ ] **Step 3: Write the templates module**

Create `apps/api/src/mail/templates.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "apps/api" && pnpm exec vitest run test/mail-templates.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/templates.ts apps/api/test/mail-templates.test.ts
git commit -m "feat(mail): add the eight email templates"
```

---

### Task 3: Wire `deps.mail` into AppDeps, env, server, and tests

**Files:**
- Modify: `apps/api/src/context.ts` (add `mail: Mailer` to `AppDeps`)
- Modify: `apps/api/src/env.ts` (add `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM`)
- Modify: `apps/api/src/server.ts` (construct `SmtpMailer`)
- Modify: `apps/api/test/helpers.ts` (construct `NullMailer`, expose it on `TestAppHandle`)

**Interfaces:**
- Consumes: `Mailer`, `NullMailer`, `SmtpMailer` from Task 1 (`../mail/mailer.js`).
- Produces: `deps.mail: Mailer` available to every route/executor via `AppDeps`; `TestAppHandle.mail: NullMailer` for tests to assert on.

- [ ] **Step 1: Add `mail` to `AppDeps`**

In `apps/api/src/context.ts`, add the import and field. Add near the top with the other type-only imports:

```typescript
import type { Mailer } from "./mail/mailer.js";
```

Add inside `export interface AppDeps { ... }`, right after the `registry?: IdentityRegistry;` line:

```typescript
  /** Outbound email — password reset, welcome, and notification sends. */
  mail: Mailer;
```

- [ ] **Step 2: Add SMTP config to `env.ts`**

In `apps/api/src/env.ts`, add to the `Env` interface (right after the `webhooksTimeoutMs: number;` line, before the closing `}`):

```typescript
  /** SMTP transport for outbound email. Defaults to Mailpit's usual dev port. */
  smtpHost: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPass?: string;
  /** The `From:` address on every outbound email. */
  mailFrom: string;
```

Add to the `export const env: Env = { ... }` object literal, right before the closing `};`:

```typescript
  smtpHost: process.env.SMTP_HOST ?? "localhost",
  smtpPort: Number(process.env.SMTP_PORT ?? 1025),
  smtpUser: process.env.SMTP_USER || undefined,
  smtpPass: process.env.SMTP_PASS || undefined,
  mailFrom: process.env.MAIL_FROM ?? "no-reply@tokenlayer.dev",
```

- [ ] **Step 3: Construct `SmtpMailer` in `server.ts`**

In `apps/api/src/server.ts`, add the import alongside the other top-level imports:

```typescript
import { SmtpMailer } from "./mail/mailer.js";
```

In the `const deps: AppDeps = { ... }` object literal, add right after `registry,`:

```typescript
    mail: new SmtpMailer(env.mailFrom, { host: env.smtpHost, port: env.smtpPort, user: env.smtpUser, pass: env.smtpPass }),
```

- [ ] **Step 4: Construct `NullMailer` in the test harness**

In `apps/api/test/helpers.ts`, add the import:

```typescript
import { NullMailer } from "../src/mail/mailer.js";
```

Add `mail: MailerRepo;`-shaped field to `TestAppHandle` — actually use the concrete type directly. In the `TestAppHandle` interface, add:

```typescript
  /** Every email the app under test sent — assert against `.sent`. */
  mail: NullMailer;
```

Right before `const deps: AppDeps = {`, add:

```typescript
  const mail = new NullMailer();
```

In the `const deps: AppDeps = { ... }` object literal, add `mail,` right after `registry: opts.registry,`.

In the `return { app: await buildApp(deps), users, apiKeys, loginKeys, organizations, audit, deps };` line at the end of `buildTestAppWithRepos`, add `mail` to the returned object:

```typescript
  return { app: await buildApp(deps), users, apiKeys, loginKeys, organizations, audit, deps, mail };
```

- [ ] **Step 5: Typecheck**

Run: `cd "apps/api" && pnpm exec tsc --noEmit`
Expected: no errors. (This step has no dedicated test — it's config wiring the later tasks exercise indirectly. Confirms every `AppDeps` construction site was updated.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/context.ts apps/api/src/env.ts apps/api/src/server.ts apps/api/test/helpers.ts
git commit -m "feat(mail): wire deps.mail into AppDeps, env config, and the test harness"
```

---

### Task 4: PasswordResetToken persistence

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new `PasswordResetToken` model)
- Modify: `apps/api/src/persistence/types/shared.ts` (`PasswordResetTokenRecord`, `PasswordResetTokenRepository`)
- Modify: `apps/api/src/persistence/memory/shared.ts` (`MemoryPasswordResetTokenRepository`)
- Modify: `apps/api/src/persistence/prisma/shared.ts` (`PrismaPasswordResetTokenRepository`)
- Modify: `apps/api/src/persistence/model-domains.ts` (register the model + repository key)
- Modify: `apps/api/src/context.ts` (add `passwordResetTokens` to `AppDeps`)
- Modify: `apps/api/src/server.ts`, `apps/api/test/helpers.ts` (construct the repo)
- Create: `apps/api/src/mail/reset-tokens.ts` (mint/match helpers, mirrors `shared/api-keys.ts`)

**Interfaces:**
- Produces: `mintResetToken(): Promise<{ token: string; prefix: string; hash: string }>`, `resetTokenMatches(raw: string, hash: string): Promise<boolean>` from `mail/reset-tokens.ts`; `PasswordResetTokenRecord { id, userId, tokenPrefix, tokenHash, expiresAt, usedAt, createdAt }`; `PasswordResetTokenRepository { create(input): Promise<Record>; findByPrefix(prefix): Promise<Record | null>; markUsed(id): Promise<Record>; invalidateAllForUser(userId): Promise<void> }`; `deps.passwordResetTokens`.

- [ ] **Step 1: Add the Prisma model**

In `apps/api/prisma/schema.prisma`, add right after the `User` model (before the `ApiKey` model's `/// domain: shared` comment):

```prisma
/// domain: shared
model PasswordResetToken {
  id         String    @id @default(cuid())
  userId     String
  tokenPrefix String   @unique
  tokenHash  String
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime  @default(now())
}
```

- [ ] **Step 2: Register the model's domain ownership**

In `apps/api/src/persistence/model-domains.ts`, add to `MODEL_DOMAINS` under the "Shared platform" section, right after `User: "shared",`:

```typescript
  PasswordResetToken: "shared",
```

Add to `REPOSITORY_MODELS`, right after `users: "User",`:

```typescript
  passwordResetTokens: "PasswordResetToken",
```

- [ ] **Step 3: Write the reset-token secret helpers**

Create `apps/api/src/mail/reset-tokens.ts`:

```typescript
/**
 * Password-reset token secrets. Same shape as API-key secrets
 * (`shared/api-keys.ts`): a bcrypt hash plus an indexed public prefix, so a
 * leaked database yields no working token and lookup never needs a full-table
 * bcrypt scan.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { API_KEY_BCRYPT_ROUNDS } from "../shared/api-keys.js";

const PREFIX_LEN = 8;
const BODY_LEN = 32;
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface MintedResetToken {
  /** The raw token — returned to the caller once, embedded in the emailed link, never stored. */
  token: string;
  /** First `PREFIX_LEN` chars — safe to index. */
  prefix: string;
  /** bcrypt hash of the FULL token. */
  hash: string;
}

export async function mintResetToken(): Promise<MintedResetToken> {
  const token = Array.from(randomBytes(BODY_LEN), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return { token, prefix: token.slice(0, PREFIX_LEN), hash: await bcrypt.hash(token, API_KEY_BCRYPT_ROUNDS) };
}

/** Constant-time by construction — bcrypt.compare does not short-circuit. */
export async function resetTokenMatches(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
```

- [ ] **Step 4: Add the record type and repository interface**

In `apps/api/src/persistence/types/shared.ts`, add right after the `ApiKeyRepository` interface's closing `}`:

```typescript
/**
 * A single-use password-reset token. `tokenPrefix` is the indexed lookup key
 * (same pattern as `ApiKeyRecord.prefix`); `tokenHash` is a bcrypt hash of the
 * full raw token, which is never itself stored.
 */
export interface PasswordResetTokenRecord {
  id: string;
  userId: string;
  tokenPrefix: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export type PasswordResetTokenCreateInput = Omit<PasswordResetTokenRecord, "id" | "createdAt" | "usedAt">;

export interface PasswordResetTokenRepository {
  create(input: PasswordResetTokenCreateInput): Promise<PasswordResetTokenRecord>;
  /** The single indexed lookup before any bcrypt work. */
  findByPrefix(prefix: string): Promise<PasswordResetTokenRecord | null>;
  markUsed(id: string): Promise<PasswordResetTokenRecord>;
  /** Every OTHER outstanding (unused) token for this user is invalidated on a successful reset. */
  invalidateAllForUser(userId: string): Promise<void>;
}
```

- [ ] **Step 5: Implement the memory repository**

In `apps/api/src/persistence/memory/shared.ts`, add `PasswordResetTokenCreateInput`, `PasswordResetTokenRecord`, `PasswordResetTokenRepository` to the big type-only import list at the top of the file (alphabetical slot, right after `LoginKeyRepository`). Then add the class, right after `MemoryApiKeyRepository`'s closing `}`:

```typescript
export class MemoryPasswordResetTokenRepository implements PasswordResetTokenRepository {
  private readonly byId = new Map<string, PasswordResetTokenRecord>();
  async create(input: PasswordResetTokenCreateInput): Promise<PasswordResetTokenRecord> {
    const rec: PasswordResetTokenRecord = { ...input, id: id("prt"), createdAt: now(), usedAt: null };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findByPrefix(prefix: string): Promise<PasswordResetTokenRecord | null> {
    return [...this.byId.values()].find((t) => t.tokenPrefix === prefix) ?? null;
  }
  async markUsed(id: string): Promise<PasswordResetTokenRecord> {
    const rec = this.byId.get(id);
    if (!rec) throw new Error(`password reset token ${id} not found`);
    const updated = { ...rec, usedAt: now() };
    this.byId.set(id, updated);
    return updated;
  }
  async invalidateAllForUser(userId: string): Promise<void> {
    for (const [key, rec] of this.byId) {
      if (rec.userId === userId && !rec.usedAt) this.byId.set(key, { ...rec, usedAt: now() });
    }
  }
}
```

- [ ] **Step 6: Implement the Prisma repository**

In `apps/api/src/persistence/prisma/shared.ts`, add `PasswordResetTokenCreateInput`, `PasswordResetTokenRecord`, `PasswordResetTokenRepository` to the type-only import list, then add the mapper and class right after `PrismaApiKeyRepository`'s closing `}`:

```typescript
const rowToPasswordResetToken = (r: {
  id: string; userId: string; tokenPrefix: string; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date;
}): PasswordResetTokenRecord => ({
  id: r.id, userId: r.userId, tokenPrefix: r.tokenPrefix, tokenHash: r.tokenHash,
  expiresAt: r.expiresAt.toISOString(), usedAt: r.usedAt ? r.usedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});

export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  async create(input: PasswordResetTokenCreateInput): Promise<PasswordResetTokenRecord> {
    return rowToPasswordResetToken(await prisma.passwordResetToken.create({
      data: { userId: input.userId, tokenPrefix: input.tokenPrefix, tokenHash: input.tokenHash, expiresAt: new Date(input.expiresAt) },
    }));
  }
  async findByPrefix(prefix: string): Promise<PasswordResetTokenRecord | null> {
    const r = await prisma.passwordResetToken.findUnique({ where: { tokenPrefix: prefix } });
    return r ? rowToPasswordResetToken(r) : null;
  }
  async markUsed(id: string): Promise<PasswordResetTokenRecord> {
    return rowToPasswordResetToken(await prisma.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } }));
  }
  async invalidateAllForUser(userId: string): Promise<void> {
    await prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  }
}
```

- [ ] **Step 7: Wire the repository into `AppDeps`**

In `apps/api/src/context.ts`, add the import to the `persistence/types/index.js` import list (alphabetical slot after `OrganizationRepository`):

```typescript
  PasswordResetTokenRepository,
```

Add to `AppDeps`, right after `mail: Mailer;`:

```typescript
  passwordResetTokens: PasswordResetTokenRepository;
```

In `apps/api/src/server.ts`: add `PrismaPasswordResetTokenRepository` to the `persistence/prisma/index.js` import list, add `const passwordResetTokens = new PrismaPasswordResetTokenRepository();` near the other repo constructions, and add `passwordResetTokens,` to the `deps` object literal.

In `apps/api/test/helpers.ts`: add `MemoryPasswordResetTokenRepository` to the `persistence/memory/index.js` import list, add `const passwordResetTokens = new MemoryPasswordResetTokenRepository();`, and add `passwordResetTokens,` to the `deps` object literal.

- [ ] **Step 8: Push the schema and typecheck**

Run: `cd "apps/api" && pnpm exec prisma generate && pnpm exec prisma db push --skip-generate --accept-data-loss && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Run the persistence parity suite**

Run: `cd "apps/api" && pnpm exec vitest run test/persistence-parity.test.ts`
Expected: PASS — confirms `PasswordResetTokenRepository` has a twin in both `memory/shared.ts` and `prisma/shared.ts`, correctly bucketed as `shared`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/mail/reset-tokens.ts
git commit -m "feat(mail): add PasswordResetToken persistence (memory + prisma)"
```

---

### Task 5: Forgot/reset-password routes

**Files:**
- Modify: `apps/api/src/http/schemas/shared.ts` (add `forgotPassword`, `resetPassword` schemas)
- Modify: `apps/api/src/http/routes/shared.ts` (add the two routes)
- Test: `apps/api/test/password-reset.test.ts`

**Interfaces:**
- Consumes: `mintResetToken`, `resetTokenMatches` (Task 4), `deps.passwordResetTokens` (Task 4), `deps.mail` + `passwordResetEmail` (Tasks 1–3), `deps.publicWebUrl` (existing), `loginThrottled` (existing, from `ctx`).
- Produces: `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/password-reset.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos, V1 } from "./helpers.js";

describe("password reset", () => {
  it("forgot-password always returns 202, and emails a reset link for a real user", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    expect(res.statusCode).toBe(202);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]!.to).toBe("admin@tokenlayer.dev");
    expect(h.mail.sent[0]!.text).toMatch(/reset-password\?token=/);
  });

  it("forgot-password returns 202 and sends nothing for an unknown email (no enumeration)", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "nobody@nowhere.test" } });
    expect(res.statusCode).toBe(202);
    expect(h.mail.sent).toHaveLength(0);
  });

  it("reset-password with the emailed token sets the new password and logs in with it", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const link = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    const reset = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "brand-new-pw-123" } });
    expect(reset.statusCode).toBe(200);
    const login = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "brand-new-pw-123" } });
    expect(login.statusCode).toBe(200);
  });

  it("reset-password rejects an unknown token", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: "not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa", newPassword: "whatever123" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_TOKEN");
  });

  it("reset-password rejects a token that was already used", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const link = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "first-reset-123" } });
    const second = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "second-reset-456" } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("INVALID_TOKEN");
  });

  it("a fresh forgot-password request invalidates the previous token", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const firstLink = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const reset = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: firstLink, newPassword: "whatever-123" } });
    expect(reset.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/password-reset.test.ts`
Expected: FAIL — 404s (routes don't exist yet).

- [ ] **Step 3: Add the schemas**

In `apps/api/src/http/schemas/shared.ts`, add to `sharedSchemas`, right after the `login` schema's closing `,`:

```typescript
  forgotPassword: {
    tags: ["Auth"],
    summary: "Request a password-reset email",
    body: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
    response: { 202: { type: "object", properties: {} } },
  },
  resetPassword: {
    tags: ["Auth"],
    summary: "Set a new password using a reset token",
    body: { type: "object", required: ["token", "newPassword"], properties: { token: { type: "string" }, newPassword: { type: "string", minLength: 8 } } },
    response: { 200: { type: "object", properties: { status: { type: "string" } } }, 400: { $ref: "Error#" } },
  },
```

- [ ] **Step 4: Add the routes**

In `apps/api/src/http/routes/shared.ts`, add the imports at the top (alongside the existing `bcrypt`/`BCRYPT_ROUNDS` imports):

```typescript
import { mintResetToken, resetTokenMatches } from "../../mail/reset-tokens.js";
import { passwordResetEmail } from "../../mail/templates.js";
```

Add the two routes right after the existing `app.post("/auth/login", ...)` handler's closing `});` (before the `// --- passwordless device login keys ---` comment):

```typescript
  app.post("/auth/forgot-password", { schema: S.forgotPassword }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const { email } = request.body as { email: string };
    const user = await deps.users.findByEmail(email);
    // Same response whether or not the account exists — no enumeration.
    if (user && user.kind === "human" && user.active) {
      await deps.passwordResetTokens.invalidateAllForUser(user.id);
      const minted = await mintResetToken();
      await deps.passwordResetTokens.create({
        userId: user.id, tokenPrefix: minted.prefix, tokenHash: minted.hash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      const resetUrl = `${deps.publicWebUrl}/reset-password?token=${minted.token}`;
      const email_ = passwordResetEmail({ resetUrl });
      await deps.mail.send(user.email, email_.subject, email_.text, email_.html).catch((err) => request.log.error({ err }, "[mail] forgot-password send failed"));
    }
    return reply.code(202).send({});
  });

  app.post("/auth/reset-password", { schema: S.resetPassword }, async (request, reply) => {
    const { token, newPassword } = request.body as { token: string; newPassword: string };
    const prefix = token.slice(0, 8);
    const row = await deps.passwordResetTokens.findByPrefix(prefix);
    const invalid = () => reply.code(400).send({ error: "INVALID_TOKEN", message: "this reset link is invalid or has expired" });
    if (!row || row.usedAt || new Date(row.expiresAt) < new Date()) return invalid();
    if (!(await resetTokenMatches(token, row.tokenHash))) return invalid();
    await deps.users.update(row.userId, { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
    await deps.passwordResetTokens.markUsed(row.id);
    await deps.passwordResetTokens.invalidateAllForUser(row.userId);
    await deps.audit.append({ actorId: row.userId, action: "password-reset" as LifecycleAction, payload: { userId: row.userId } });
    return reply.code(200).send({ status: "ok" });
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/password-reset.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS — no regressions from the new routes/schema entries.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/schemas/shared.ts apps/api/src/http/routes/shared.ts apps/api/test/password-reset.test.ts
git commit -m "feat(auth): add POST /auth/forgot-password and /auth/reset-password"
```

---

### Task 6: Web — forgot-password link and reset-password screen

**Files:**
- Modify: `apps/web/src/api.ts` (add `forgotPassword`, `resetPassword` calls)
- Modify: `apps/web/src/components/shared/Login.tsx` (add "Forgot password?" toggle)
- Create: `apps/web/src/components/shared/ResetPassword.tsx`
- Modify: `apps/web/src/App.tsx` (route `reset-password` to the new screen)

**Interfaces:**
- Consumes: `api.forgotPassword(email)`, `api.resetPassword(token, newPassword)` from this task's own `api.ts` addition.

- [ ] **Step 1: Add the API calls**

In `apps/web/src/api.ts`, add to the `api` object, right after the `login` entry:

```typescript
  forgotPassword: (email: string) => request<Record<string, never>>("/auth/forgot-password", null, { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ status: string }>("/auth/reset-password", null, { method: "POST", body: JSON.stringify({ token, newPassword }) }),
```

- [ ] **Step 2: Add the "Forgot password?" toggle to Login.tsx**

In `apps/web/src/components/shared/Login.tsx`, add state right after the existing `password`/`error`/`busy` state declarations:

```typescript
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotNotice, setForgotNotice] = useState<string | null>(null);
```

Add the handler right after the `submit` function:

```typescript
  async function submitForgot(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setForgotBusy(true);
    try {
      await api.forgotPassword(forgotEmail);
      setForgotNotice("If that address has an account, we've sent a password-reset link to it.");
    } catch (err) {
      setForgotNotice(err instanceof ApiError ? err.message : "Something went wrong — try again.");
    } finally {
      setForgotBusy(false);
    }
  }
```

Replace the `<p className="mt-5 text-center text-sm text-slate-500">` block at the end of the form panel (the "New enterprise?" paragraph) with a version that also renders the forgot-password link/form above it. Replace:

```typescript
              <p className="mt-5 text-center text-sm text-slate-500">
                New enterprise?{" "}
                <button
                  type="button"
                  onClick={() => navigate("/signup")}
                  className="font-medium text-brand-700 hover:text-brand-600"
                >
                  Register your company
                </button>
              </p>
```

with:

```typescript
              {forgotMode ? (
                <form onSubmit={submitForgot} className="mt-5 space-y-3 border-t border-slate-100 pt-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">Email</label>
                    <input
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      autoComplete="username"
                      placeholder="you@institution.com"
                    />
                  </div>
                  {forgotNotice && <p className="text-sm text-slate-600">{forgotNotice}</p>}
                  <div className="flex items-center gap-3">
                    <button
                      type="submit"
                      disabled={forgotBusy}
                      className="flex-1 rounded-lg bg-brand-600 text-white py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                    >
                      {forgotBusy ? "Sending…" : "Send reset link"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setForgotMode(false); setForgotNotice(null); }}
                      className="text-sm font-medium text-slate-500 hover:text-slate-700"
                    >
                      Back to sign in
                    </button>
                  </div>
                </form>
              ) : (
                <p className="mt-5 text-center text-sm text-slate-500">
                  <button type="button" onClick={() => setForgotMode(true)} className="font-medium text-brand-700 hover:text-brand-600">
                    Forgot password?
                  </button>
                  {" · "}
                  New enterprise?{" "}
                  <button
                    type="button"
                    onClick={() => navigate("/signup")}
                    className="font-medium text-brand-700 hover:text-brand-600"
                  >
                    Register your company
                  </button>
                </p>
              )}
```

- [ ] **Step 3: Create the reset-password screen**

Create `apps/web/src/components/shared/ResetPassword.tsx`:

```typescript
import { useState } from "react";
import { api, ApiError } from "../../api.js";
import { Logo } from "./Logo.js";

function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

export function ResetPassword(): JSX.Element {
  const [token] = useState(tokenFromUrl);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e?: React.FormEvent): Promise<void> {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset your password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo size={34} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-8">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 mb-1">Set a new password</h2>
          {!token ? (
            <p className="text-sm text-red-600 mt-4">This reset link is missing its token. Request a new one from the sign-in page.</p>
          ) : done ? (
            <p className="text-sm text-slate-600 mt-4">
              Your password has been reset.{" "}
              <a href="/login" className="font-medium text-brand-700 hover:text-brand-600">
                Sign in
              </a>
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4 mt-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">New password</label>
                <input
                  type="password"
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-brand-600 text-white py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Set password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route in App.tsx**

In `apps/web/src/App.tsx`, add the import next to `Login`:

```typescript
import { ResetPassword } from "./components/shared/ResetPassword.js";
```

In the `if (!token || !user) { ... }` block, add a branch right before `if (routeKey === "signup") return <Signup />;`:

```typescript
    if (routeKey === "reset-password") return <ResetPassword />;
```

- [ ] **Step 5: Typecheck and run the web test suite**

Run: `cd "apps/web" && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: no type errors, all existing tests still pass (this task adds no new web unit tests — it's exercised live in Task 12).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/components/shared/Login.tsx apps/web/src/components/shared/ResetPassword.tsx apps/web/src/App.tsx
git commit -m "feat(web): add forgot-password link and reset-password screen"
```

---

### Task 7: Welcome emails

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts` (`POST /orgs` admin-immediate path)
- Modify: `apps/api/src/http/routes/identity.ts` (`provisionDeskUser`)
- Modify: `apps/api/src/shared/user-kinds.ts` (`onboardSingle` — gated path, set-password variant)
- Test: append to `apps/api/test/org-admin-operational.test.ts` is NOT right (different concern) — create `apps/api/test/welcome-emails.test.ts`

**Interfaces:**
- Consumes: `welcomeCredentialsEmail`, `welcomeSetPasswordEmail` (Task 2), `mintResetToken` (Task 4), `deps.passwordResetTokens`, `deps.mail`, `deps.publicWebUrl`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/welcome-emails.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("welcome emails", () => {
  it("POST /orgs with an admin block emails the real password", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs`, headers: auth(platform),
      payload: { name: `Welcome Org ${Date.now()}`, orgType: "corporate", admin: { name: "A Admin", email: `welcome-${Date.now()}@x.com`, password: "the-real-password-1" } },
    });
    expect(res.statusCode).toBe(201);
    const sent = h.mail.sent.find((m) => m.text.includes("the-real-password-1"));
    expect(sent).toBeDefined();
  });

  it("gated onboard-user (POST /users, approved) emails a set-password link, never the password", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `gated-${Date.now()}@x.com`;
    await onboardUser(h.app, maker, checker, { email, password: "never-sent-anywhere", role: "Buyer", useCaseKey: "carbon-credit" });
    const sent = h.mail.sent.find((m) => m.to === email);
    expect(sent).toBeDefined();
    expect(sent!.text).not.toContain("never-sent-anywhere");
    expect(sent!.text).toMatch(/reset-password\?token=/);
  });
});
```

`onboardUser`'s `maker`/`checker` parameters are JWTs, not emails — log in first with `loginAs`, as above. `PLATFORM_ADMIN_2` (the seeded second approver) is exported from `./helpers.js`; add it to this test file's import line.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/welcome-emails.test.ts`
Expected: FAIL — no email was recorded in either case.

- [ ] **Step 3: Send the welcome-with-credentials email from `POST /orgs`**

In `apps/api/src/http/routes/shared.ts`, add the import:

```typescript
import { welcomeCredentialsEmail } from "../../mail/templates.js";
```

Right after the line `orgCredentialId = ceremony.orgCredentialId;` inside the `if (b.admin) { try { ... } catch ... }` block of the `POST /orgs` handler, add:

```typescript
        const welcome = welcomeCredentialsEmail({ email: adminUser.email, password: b.admin.password, loginUrl: `${deps.publicWebUrl}/login` });
        await deps.mail.send(adminUser.email, welcome.subject, welcome.text, welcome.html).catch((err) => request.log.error({ err }, "[mail] welcome send failed"));
```

- [ ] **Step 4: Send the welcome-with-credentials email from `provisionDeskUser`**

In `apps/api/src/http/routes/identity.ts`, add the import alongside the other `../../mail/...` additions from earlier tasks (or as a fresh import if this is the first mail import in this file):

```typescript
import { welcomeCredentialsEmail } from "../../mail/templates.js";
```

In `provisionDeskUser`, right after the `await proposalKind("onboard-user").execute(...)` call succeeds (before its `return { email, password, role };` — check the exact line after the try/catch block that logs+rethrows), add:

```typescript
    const welcome = welcomeCredentialsEmail({ email, password, loginUrl: `${deps.publicWebUrl}/login` });
    await deps.mail.send(email, welcome.subject, welcome.text, welcome.html).catch((err) => log.error({ err }, "[mail] welcome send failed"));
```

- [ ] **Step 5: Send the set-password email from the gated onboarding executor**

In `apps/api/src/shared/user-kinds.ts`, add the imports:

```typescript
import { mintResetToken } from "../mail/reset-tokens.js";
import { welcomeSetPasswordEmail } from "../mail/templates.js";
```

In `onboardSingle`, right after `const created = await deps.users.create({...});` (before the `let issuedCredentialId: string | null = null;` line), add:

```typescript
  {
    const minted = await mintResetToken();
    await deps.passwordResetTokens.create({
      userId: created.id, tokenPrefix: minted.prefix, tokenHash: minted.hash,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const setPasswordUrl = `${deps.publicWebUrl}/reset-password?token=${minted.token}`;
    const welcome = welcomeSetPasswordEmail({ email: created.email, setPasswordUrl });
    await deps.mail.send(created.email, welcome.subject, welcome.text, welcome.html).catch(() => undefined);
  }
```

This block is deliberately its own scope (`{ ... }`) so `minted` doesn't leak into the rest of the function, and deliberately swallows its error with `.catch(() => undefined)` (no logger is threaded into `onboardSingle` — matching the file's existing rollback `.catch(() => undefined)` calls a few lines below).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/welcome-emails.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS — no regressions.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/routes/identity.ts apps/api/src/shared/user-kinds.ts apps/api/test/welcome-emails.test.ts
git commit -m "feat(mail): send welcome emails on org-admin, desk-user, and gated onboarding"
```

---

### Task 8: KYC decision notification

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts` (`PATCH /users/:id`)
- Modify: `apps/api/src/http/routes/identity.ts` (`POST /users/:id/identity/verify`)
- Test: `apps/api/test/kyc-notification.test.ts`

**Interfaces:**
- Consumes: `kycDecisionEmail` (Task 2), `deps.mail`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/kyc-notification.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("KYC decision notification", () => {
  it("PATCH /users/:id with kycStatus emails the affected user", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `kyc-${Date.now()}@x.com`;
    const created = await onboardUser(h.app, platform, checker, { email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit" });
    h.mail.sent.length = 0; // ignore the welcome + proposal-notify emails onboarding just sent
    const res = await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(res.statusCode).toBe(200);
    const sent = h.mail.sent.find((m) => m.to === email);
    expect(sent).toBeDefined();
    expect(sent!.subject).toMatch(/approved/i);
  });

  it("PATCH /users/:id without a kycStatus field sends no KYC email", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `no-kyc-${Date.now()}@x.com`;
    const created = await onboardUser(h.app, platform, checker, { email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit" });
    h.mail.sent.length = 0;
    await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: auth(platform), payload: { active: false } });
    expect(h.mail.sent).toHaveLength(0);
  });
});
```

`onboardUser`'s `maker`/`checker` are JWTs (log in first, as above); its return is a `UserSummary` (`{ id, email, role, useCaseKey, accountId, kycStatus, kyc }`), so `created.id` is correct.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-notification.test.ts`
Expected: FAIL on the first test (no email sent).

- [ ] **Step 3: Notify from `PATCH /users/:id`**

In `apps/api/src/http/routes/shared.ts`, add the import:

```typescript
import { kycDecisionEmail } from "../../mail/templates.js";
```

Right after `const updated = await deps.users.update(id, patch);` in the `PATCH /users/:id` handler, add:

```typescript
    if (patch.kycStatus) {
      const notice = kycDecisionEmail({ decision: patch.kycStatus });
      await deps.mail.send(updated.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] kyc-decision send failed"));
    }
```

- [ ] **Step 4: Notify from the VC-verify path**

In `apps/api/src/http/routes/identity.ts`, add `kycDecisionEmail` to the existing `../../mail/templates.js` import from Task 7 (or add the import fresh if that task's edit landed differently — merge into one `import { ... } from "../../mail/templates.js";` line).

Right after the `await deps.users.update(target.id, {...});` call in `POST /users/:id/identity/verify`, add:

```typescript
    {
      const notice = kycDecisionEmail({ decision: "approved" });
      await deps.mail.send(target.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] kyc-decision send failed"));
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd "apps/api" && pnpm exec vitest run test/kyc-notification.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/src/http/routes/identity.ts apps/api/test/kyc-notification.test.ts
git commit -m "feat(mail): notify a user by email on KYC approval/rejection"
```

---

### Task 9: Org-approved notification

**Files:**
- Modify: `apps/api/src/http/routes/shared.ts` (`POST /orgs/:id/approve`)
- Test: `apps/api/test/org-approved-notification.test.ts`

**Interfaces:**
- Consumes: `orgApprovedEmail` (Task 2), `deps.mail`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/org-approved-notification.test.ts`:

```typescript
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
    const sent = h.mail.sent.slice(before).find((m) => m.to === adminEmail);
    expect(sent).toBeDefined();
    expect(sent!.text).toContain(orgName);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/org-approved-notification.test.ts`
Expected: FAIL — either on the document fixture (fix using the real existing pattern found above) or, once that's fixed, on no email being sent.

- [ ] **Step 3: Notify from `POST /orgs/:id/approve`**

In `apps/api/src/http/routes/shared.ts`, add `orgApprovedEmail` to the existing `../../mail/templates.js` import (merge with the `kycDecisionEmail`/`welcomeCredentialsEmail` imports from Tasks 7–8 into one line).

Right after `await deps.audit.append({ actorId: claims.id, action: "org-approved" as LifecycleAction, ... });` in `POST /orgs/:id/approve`, add (before the `return reply.code(200).send(...)` line):

```typescript
    if (admin) {
      const notice = orgApprovedEmail({ orgName: active.name, loginUrl: `${deps.publicWebUrl}/login` });
      await deps.mail.send(admin.email, notice.subject, notice.text, notice.html).catch((err) => request.log.error({ err }, "[mail] org-approved send failed"));
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "apps/api" && pnpm exec vitest run test/org-approved-notification.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes/shared.ts apps/api/test/org-approved-notification.test.ts
git commit -m "feat(mail): notify an org's admin by email when the org is approved"
```

---

### Task 10: Credential issued/revoked notification

**Files:**
- Modify: `apps/api/src/identity/credential-issuance.ts`
- Test: `apps/api/test/credential-mail-notification.test.ts`

**Interfaces:**
- Consumes: `credentialIssuedEmail`, `credentialRevokedEmail` (Task 2), `deps.mail`, `deps.users`, `deps.organizations`.
- Produces: `resolveCredentialRecipientEmail(deps, subjectDid): Promise<string | null>` (local helper, not exported — only this file needs it).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/credential-mail-notification.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("credential issue/revoke notification", () => {
  it("issuing a credential to a user (via onboarding's auto-KYC) emails the holder", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `cred-${Date.now()}@x.com`;
    // onboardUser's `body.kyc` (already part of its signature — see helpers.ts)
    // triggers issueCredentialFor for a KycCredential inside onboardSingle.
    await onboardUser(h.app, maker, checker, {
      email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit",
      kyc: { legalName: "Cred Holder", country: "IN" },
    });
    const sent = h.mail.sent.find((m) => m.to === email && /credential/i.test(m.subject));
    expect(sent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/credential-mail-notification.test.ts`
Expected: FAIL — no credential email sent.

- [ ] **Step 3: Add the recipient-resolution helper and hook both call sites**

In `apps/api/src/identity/credential-issuance.ts`, add the imports:

```typescript
import { credentialIssuedEmail, credentialRevokedEmail } from "../mail/templates.js";
```

Add this helper near the top of the file, after the imports:

```typescript
/**
 * The email to notify for a credential concerning `subjectDid` — the holder's
 * own address if it belongs to a user, else that org's OrgAdmin if it belongs
 * to an organization, else null (nothing to notify, e.g. a DID this deployment
 * has never onboarded). No `findByDid` on `UserRepository` today, so this
 * scans — acceptable at pilot scale; revisit if the roster grows large.
 */
async function resolveCredentialRecipientEmail(deps: AppDeps, subjectDid: string): Promise<string | null> {
  const user = (await deps.users.list()).find((u) => u.did === subjectDid);
  if (user) return user.email;
  const org = await deps.organizations.findByDid(subjectDid).catch(() => null);
  if (!org) return null;
  const admin = (await deps.users.listByOrg(org.id)).find((u) => u.role === "OrgAdmin");
  return admin?.email ?? null;
}
```

In `issueCredentialFor`, right after the existing `await emitEvent(deps, { type: "credential.issued", ... });` call (before `return credential;`), add:

```typescript
  try {
    const to = await resolveCredentialRecipientEmail(deps, credential.holderDid);
    if (to) {
      const notice = credentialIssuedEmail({ credentialType: credential.type, issuerName: a.issuerOrg.name });
      await deps.mail.send(to, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    console.error({ err, credentialId: credential.id }, "[mail] credential-issued send failed");
  }
```

In `revokeCredentialById`, right after the existing `await emitEvent(deps, { type: "credential.revoked", ... });` call (at the end of the function), add:

```typescript
  try {
    const to = await resolveCredentialRecipientEmail(deps, cred.holderDid);
    if (to) {
      const notice = credentialRevokedEmail({ credentialType: cred.type, reason: meta.reason });
      await deps.mail.send(to, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    console.error({ err, credentialId: cred.id }, "[mail] credential-revoked send failed");
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "apps/api" && pnpm exec vitest run test/credential-mail-notification.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS — this hook sits in the single chokepoint every credential path uses, so watch specifically for any existing test asserting an exact count/shape of `emitEvent` calls or webhook deliveries; this change adds no webhook traffic, only mail, so it should not affect those.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/identity/credential-issuance.ts apps/api/test/credential-mail-notification.test.ts
git commit -m "feat(mail): notify the holder by email on credential issue/revoke"
```

---

### Task 11: Proposal-awaiting-approval notification

**Files:**
- Create: `apps/api/src/shared/proposal-notify.ts`
- Modify: `apps/api/src/http/routes/shared.ts` (2 call sites)
- Modify: `apps/api/src/http/routes/identity.ts` (6 call sites — excludes `provisionDeskUser`, which auto-approves in-process)
- Modify: `apps/api/src/http/routes/context.ts` (1 call site)
- Modify: `apps/api/src/http/routes/tokenization.ts` (1 call site)
- Test: `apps/api/test/proposal-notification.test.ts`

**Interfaces:**
- Produces: `createProposalAndNotify(deps: AppDeps, input: Parameters<ProposalRepository["create"]>[0], log?: { error(obj: unknown, msg?: string): void }): Promise<ProposalRecord>`.
- Consumes: `proposalAwaitingApprovalEmail` (Task 2), `deps.mail`, `deps.proposals`, `deps.users`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/proposal-notification.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "apps/api" && pnpm exec vitest run test/proposal-notification.test.ts`
Expected: FAIL — `res.statusCode` is 202 already (this path is unmodified), but no email is recorded yet.

- [ ] **Step 3: Write the notify wrapper**

Create `apps/api/src/shared/proposal-notify.ts`:

```typescript
/**
 * Every route that creates a Proposal calls THIS instead of `deps.proposals.
 * create` directly, so "email every PlatformAdmin that something needs their
 * approval" is one chokepoint instead of a dozen near-duplicate hooks. Mirrors
 * the "never let observing break acting" posture in `shared/events.ts` — a
 * mail failure never fails proposal creation.
 */
import type { AppDeps } from "../context.js";
import type { ProposalRecord, ProposalRepository } from "../persistence/types/index.js";
import { proposalAwaitingApprovalEmail } from "../mail/templates.js";

interface NotifyLogger {
  error(obj: unknown, msg?: string): void;
}

export async function createProposalAndNotify(
  deps: AppDeps,
  input: Parameters<ProposalRepository["create"]>[0],
  log: NotifyLogger = console,
): Promise<ProposalRecord> {
  const proposal = await deps.proposals.create(input);
  try {
    const admins = (await deps.users.list()).filter((u) => u.role === "PlatformAdmin" && u.active && u.kind === "human");
    const notice = proposalAwaitingApprovalEmail({
      kind: proposal.kind,
      proposerLabel: proposal.proposerLabel,
      approvalsUrl: `${deps.publicWebUrl}/approvals`,
    });
    for (const admin of admins) {
      await deps.mail.send(admin.email, notice.subject, notice.text, notice.html);
    }
  } catch (err) {
    log.error({ err, proposalId: proposal.id, kind: proposal.kind }, "[mail] proposal-awaiting-approval send failed");
  }
  return proposal;
}
```

- [ ] **Step 4: Swap the 11 call sites**

In each of the files below, add the import (one line per file):

```typescript
import { createProposalAndNotify } from "../../shared/proposal-notify.js";
```

(In `apps/api/src/http/routes/context.ts`, the relative path is the same: `../../shared/proposal-notify.js`.)

Then, in each location, replace `deps.proposals.create({` with `createProposalAndNotify(deps, {` and, where the call already ends `});`, change the closing to pass `request.log` as the third argument: `}, request.log);`. The 11 sites:

1. `apps/api/src/http/routes/shared.ts:454` (`POST /users`, kind `onboard-user`)
2. `apps/api/src/http/routes/shared.ts:524` (`POST /users/batch`, kind `onboard-user-batch`)
3. `apps/api/src/http/routes/shared.ts:1288` (`POST /orgs/:id/capabilities/request`, kind `org-capability-change`)
4. `apps/api/src/http/routes/identity.ts:351` (`create-credential-use-case` OrgAdmin propose)
5. `apps/api/src/http/routes/identity.ts:1312` (`issue-usecase-credential`)
6. `apps/api/src/http/routes/identity.ts:1353` (`issue-usecase-credential-batch`)
7. `apps/api/src/http/routes/identity.ts:1415` (`revoke-user-identity`)
8. `apps/api/src/http/routes/identity.ts:1481` (`issue-credential`)
9. `apps/api/src/http/routes/identity.ts:1520` (`revoke-credential`)
10. `apps/api/src/http/routes/context.ts:108` (generic use-case-gated op, inside `proposeIfGated`) — this one is a bare `return deps.proposals.create({...});` with no trailing local variable; change it to `return createProposalAndNotify(deps, { useCaseKey: useCase.key, orgId: null, assetId, kind: op, payload, proposerId: claims.id, proposerLabel: claims.email, required }, request.log);`
11. `apps/api/src/http/routes/tokenization.ts:156` (`create-use-case` OrgAdmin propose)

Exact line numbers may have drifted since this plan was written (earlier tasks touched some of these files) — locate each by its `kind: "..."` string (listed above) rather than trusting the line number blindly.

**Do NOT touch** `apps/api/src/http/routes/identity.ts`'s `provisionDeskUser` (`deps.proposals.create` for kind `onboard-user`, around what was line 1000) — that proposal is auto-approved synchronously in the same function call, so "awaiting approval" would be sent for something already resolved by the time anyone reads it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "apps/api" && pnpm exec vitest run test/proposal-notification.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full API suite**

Run: `cd "apps/api" && pnpm exec vitest run`
Expected: PASS — 11 call sites changed shape (still return the same `ProposalRecord`), so no route's response contract should differ. Investigate immediately if anything besides mail-related assertions changes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/shared/proposal-notify.ts apps/api/src/http/routes/shared.ts apps/api/src/http/routes/identity.ts apps/api/src/http/routes/context.ts apps/api/src/http/routes/tokenization.ts apps/api/test/proposal-notification.test.ts
git commit -m "feat(mail): email every PlatformAdmin when a proposal awaits approval"
```

---

### Task 12: Mailpit in dev, deploy, and live verification

**Files:**
- Modify: `docker-compose.identity.yml` (add `identity-mailpit` service + `identity-api` SMTP env)
- Modify: `docker-compose.tokenization.yml` (add `tokenization-mailpit` service + `tokenization-api` SMTP env)

**Interfaces:**
- Consumes: nothing new — pure deployment config, wires `SMTP_HOST`/`SMTP_PORT`/`MAIL_FROM` env into the already-built `apps/api` image from Tasks 1–11.

- [ ] **Step 1: Add the identity stack's Mailpit service and SMTP env**

In `docker-compose.identity.yml`, add to the `identity-api` service's `environment:` block, right after the `SENTRY_ENVIRONMENT` line:

```yaml
      SMTP_HOST: ${IDENTITY_SMTP_HOST:-identity-mailpit}
      SMTP_PORT: ${IDENTITY_SMTP_PORT:-1025}
      SMTP_USER: ${IDENTITY_SMTP_USER:-}
      SMTP_PASS: ${IDENTITY_SMTP_PASS:-}
      MAIL_FROM: ${MAIL_FROM:-no-reply@tokenlayer.dev}
```

Add a new service, alongside the other services at the top level of the file (same indentation as `identity-api:`):

```yaml
  identity-mailpit:
    image: axllent/mailpit:latest
    ports: ["8026:8025"]
    networks: [xi-net]
    restart: unless-stopped
```

- [ ] **Step 2: Add the tokenization stack's Mailpit service and SMTP env**

In `docker-compose.tokenization.yml`, add to the `tokenization-api` service's `environment:` block, right after the `SENTRY_ENVIRONMENT` line:

```yaml
      SMTP_HOST: ${TOKENIZATION_SMTP_HOST:-tokenization-mailpit}
      SMTP_PORT: ${TOKENIZATION_SMTP_PORT:-1025}
      SMTP_USER: ${TOKENIZATION_SMTP_USER:-}
      SMTP_PASS: ${TOKENIZATION_SMTP_PASS:-}
      MAIL_FROM: ${MAIL_FROM:-no-reply@tokenlayer.dev}
```

Add a new service:

```yaml
  tokenization-mailpit:
    image: axllent/mailpit:latest
    ports: ["8025:8025"]
    networks: [xi-net]
    restart: unless-stopped
```

- [ ] **Step 3: Redeploy the stacks**

Run: `bash scripts/stack-up.sh identity tokenization`
Expected: both stacks come up including the two new `*-mailpit` containers.

- [ ] **Step 4: Verify live in the browser — forgot/reset password**

1. Open `http://localhost:8102` (Platform Admin), sign in as `admin@tokenlayer.dev` / `admin123` (or the current known credential — check `docs/demo-credentials.md`).
2. Sign out; on the login screen, click "Forgot password?", submit the admin's email.
3. Open `http://localhost:8025` (Mailpit's web UI for the tokenization stack) — confirm the reset email arrived, open it, copy the reset link.
4. Navigate to that link in the browser, set a new password, confirm the success message.
5. Sign in with the new password — confirm it works.
6. Reset the admin's password back afterward via the same flow (or `PATCH /users/:id`) so this doesn't leave the demo credential changed for future sessions — note the final working password wherever `docs/demo-credentials.md` already tracks it.

- [ ] **Step 5: Verify live — a notification email**

1. As `admin@tokenlayer.dev`, approve a pending organization (or, if none are pending, register a fresh test org via the public signup flow first — mirroring how earlier verification passes this session created and then deactivated test orgs).
2. Check Mailpit at `http://localhost:8025` for the "is now approved" email addressed to that org's admin.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.identity.yml docker-compose.tokenization.yml
git commit -m "feat(mail): add Mailpit to both dev stacks for local email visibility"
```

---

## Self-Review Notes

- **Spec coverage:** A (mailer module) → Tasks 1–3. B (password reset) → Tasks 4–5–6. C (welcome email) → Task 7, refined during planning: the spec's "email the password" only holds where the plaintext is actually in scope (`POST /orgs` admin block, `provisionDeskUser`); the genuinely two-step maker-checker onboarding path (`POST /users`, `POST /users/batch`) never has the plaintext at execute time by this codebase's own design ("hashed at propose time — plaintext never stored"), so that path gets a set-password link instead, reusing the Task 4 token machinery. D (four notifications) → Tasks 8–11, with `provisionDeskUser`'s auto-approved proposal deliberately excluded from Task 11 (documented in Step 4). E (dev environment) → Task 12, with two independent Mailpit instances (one per stack) rather than one shared instance, matching the stacks' existing "two independent compose projects" design.
- **Placeholder scan:** no TBD/TODO left in any step; every test fixture (Task 9's `/orgs/register` document-upload flow, Task 11's OrgAdmin-propose org/use-case setup, Tasks 7/8/10's `onboardUser` maker/checker tokens) was verified against the real helpers in `apps/api/test/helpers.ts` and `apps/api/test/corporate.test.ts`/`org-admin-operational.test.ts` during planning and written out in full — none left as a "figure it out" note.
- **Type consistency:** `Mailer`/`NullMailer`/`SmtpMailer` (Task 1) are used identically in Tasks 3, 5, 7–11. `PasswordResetTokenRecord`/`Repository` (Task 4) fields (`tokenPrefix`, `tokenHash`, `expiresAt`, `usedAt`) are used with the same names in Tasks 5 and 7. `createProposalAndNotify`'s signature (Task 11) matches `ProposalRepository.create`'s existing input type exactly, so every one of the 11 swapped call sites keeps its original payload shape unchanged — only the function name and (optionally) a trailing logger argument differ.
