# Email Integration — Design

**Status:** approved by user 2026-09-04, pending spec self-review sign-off
**Scope:** real SMTP-based outbound email — password reset, welcome emails with
credentials, and transactional notifications for four platform events. This is
the first of three sub-projects requested together (KYC enhancement and asset
due-diligence/listing are separate, later specs).

## Why

Today the platform has **no email sending anywhere** in the codebase. Every
login is password-only, every new account's credentials are shown exactly
once in a UI panel (lost if missed), and there is no self-service path for a
user who forgets their password — the only recovery is an admin manually
resetting it via `PATCH /users/:id`. This closes that gap.

## Non-goals

- Rate-limiting reset requests (no rate-limiting infrastructure exists
  anywhere else in this codebase either; out of scope here, worth its own
  follow-up if abuse becomes a real concern).
- A templating engine or third-party email-template service — six small
  template functions are enough; YAGNI.
- Email verification at signup (not requested — scope is reset + welcome +
  the four notification events below).
- Re-using the EN-C webhook `emitEvent` fan-out as the mail trigger. It's
  tempting (identity.ts and shared.ts already call it at some of the same
  moments), but its payload contract is deliberately redacted for **external**
  delivery and has no notion of "which human's inbox" — conflating it with
  internal email would compromise both. The mailer gets its own call sites.

## A. Core mailer module

New `apps/api/src/mail/` directory:

- `mailer.ts` — a `Mailer` interface (`send(to, subject, text, html): Promise<void>`)
  and one real implementation using `nodemailer`'s SMTP transport, built from
  `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` (optional — Mailpit
  needs none) / `MAIL_FROM`. Added to `AppDeps` (`apps/api/src/context.ts`) as
  `deps.mail`, following the same DI pattern as `deps.audit`, `deps.webhooks`, etc.
- `templates.ts` — one small function per email type, each returning
  `{ subject, text, html }` from typed arguments. No external template files.
- A `NullMailer` (records sent messages, never touches the network) is the
  implementation used in `buildTestAppWithRepos()` for all tests, mirroring
  how the webhook dispatcher is already tested without live HTTP calls.
- New env vars (`.env`, `.env.personas`): `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `WEB_ORIGIN` (base URL used to build
  the password-reset link — does not exist today; every web console currently
  assumes it's reached directly, so this is a new config value).

## B. Password reset flow

**Data:** new Prisma model, `domain: shared` (same domain as `User`, right
below it in `schema.prisma`):

```prisma
/// domain: shared
model PasswordResetToken {
  id         String   @id @default(cuid())
  userId     String
  tokenHash  String   // bcrypt hash of the raw token — same pattern as ApiKey.secretHash
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime @default(now())
}
```

Mirrored by an in-memory repo (`apps/api/src/persistence/memory/shared.ts`)
and a Prisma repo (`apps/api/src/persistence/prisma/shared.ts`), same as
every other shared entity — this is what the codebase's PARITY RULE test
enforces.

**Endpoints** (`apps/api/src/http/routes/shared.ts`, public — no auth):

- `POST /auth/forgot-password { email }` → **always** `202`, whether or not
  the email exists (no account enumeration). If a matching active user
  exists: generate a random 32-byte token, store its bcrypt hash with a
  30-minute expiry, email a link `${WEB_ORIGIN}/reset-password?token=<raw>`.
- `POST /auth/reset-password { token, newPassword }` → looks up the token by
  re-hashing and comparing (same lookup shape as API-key auth), rejects if
  missing/expired/already used, sets the new `passwordHash`, marks the token
  used, invalidates every other outstanding token for that user, and
  audit-logs a `password-reset` action. `400 INVALID_TOKEN` on any failure
  (same message whether expired, used, or never existed — don't leak which).

**Web:** `apps/web/src/components/shared/Login.tsx` gets a "Forgot password?"
link. Two new small screens/components: a request-reset form (email → calls
`forgot-password`, always shows the same "if that address has an account,
we've sent a link" message) and a `/reset-password` screen reached via the
emailed link's query param, which calls `reset-password` and redirects to
login on success.

## C. Welcome email

Sent at every point that creates a **human** user with a password the caller
(admin) chose or that the system generated, alongside the existing UI
one-time-display (which stays — the email is a backup, not a replacement):

- `onboardUserKind.execute` / `onboardUserBatchKind.execute`
  (`apps/api/src/shared/user-kinds.ts`) — single and CSV-batch onboarding.
- The admin-provisioning branch of `POST /orgs` and `activateOrgAdmin`
  (`apps/api/src/http/routes/shared.ts`) — org creation with an admin login
  set up immediately, and the existing `/orgs/:id/approve` path that also
  calls `activateOrgAdmin`.
- The exact remaining call sites (any other direct, non-proposal user-create
  path) get enumerated and wired during implementation planning — this list
  covers the ones already confirmed by this session's earlier RBAC work.

Service-account creation (`kind: "service"`, EN-B API-key principals) is
excluded — they have no usable password and no inbox.

## D. Notification emails

Four triggers, each a direct call to `deps.mail` right after the state change
already commits (same "never let observing break acting" posture the
`emitEvent` doc comment establishes for webhooks — a failed send is logged
and swallowed, never turned into a 500):

1. **KYC approved/rejected** — `PATCH /users/:id` when `kycStatus` changes
   (`apps/api/src/http/routes/shared.ts`, ~line 571) and the VC-based
   `issue-kyc`/verification-approval path in `apps/api/src/http/routes/identity.ts`
   (~line 2116). Emails the affected user.
2. **Org approved** — `POST /orgs/:id/approve`
   (`apps/api/src/http/routes/shared.ts`, ~line 965), after `activateOrgAdmin`
   succeeds. Emails the org's admin. (The immediate-activation path on
   `POST /orgs` does not get a *separate* org-approved email — its welcome
   email already tells the admin the org is live.)
3. **Credential issued / revoked** — `POST /credential-use-cases/:key/credentials`
   (+ its batch variant) and `POST /credentials/:id/revoke`
   (`apps/api/src/http/routes/identity.ts`). Emails the credential's holder.
4. **Proposal awaiting approval** — every route that calls
   `deps.proposals.create` (roughly a dozen call sites across
   `shared.ts`/`identity.ts`/`context.ts`) emails every active `PlatformAdmin`
   user. Rather than touching every call site individually, add a thin
   wrapper — `createProposalAndNotify(deps, input)` in
   `apps/api/src/shared/support.ts` — and switch call sites to it; this also
   leaves a single, testable choke point instead of a dozen near-duplicate
   hooks.

## E. Dev environment

- Add a `mailpit` service to `docker-compose.identity.yml` and
  `docker-compose.tokenization.yml` (image `axllent/mailpit`, exposing 1025
  for SMTP and 8025 for its web UI).
- `.env` / `.env.personas` default `SMTP_HOST=mailpit` (the compose service
  name), `SMTP_PORT=1025`, no user/pass, so local dev and the existing test
  stacks send real SMTP traffic that lands in Mailpit's UI —
  `http://localhost:8025` — with zero real credentials needed.
- A real deployment overrides `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
  to a real provider's SMTP endpoint (Gmail, SES SMTP, SendGrid SMTP, etc.) —
  no code change, just env config.
- `bash scripts/stack-up.sh` needs no changes beyond what compose already
  does; Mailpit comes up as part of `docker compose up`.

## Testing

- Unit tests for `templates.ts` (each template renders expected content from
  given inputs — no snapshot brittleness, just key substrings).
- API tests for `forgot-password`/`reset-password` using the `NullMailer`
  stub: happy path, expired token, reused token, unknown email still 202,
  token invalidation-on-reset.
- API tests asserting the `NullMailer` recorded a message (right `to`, right
  subject substring) at each of the C/D trigger points, reusing existing test
  fixtures for org/user/proposal/credential creation.
- One live end-to-end check post-deploy: request a reset through the browser,
  confirm the email appears in Mailpit's UI, click through, set a new
  password, log in with it.
