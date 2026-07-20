# Gated Onboarding + Identity Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User onboarding becomes maker-checker: `POST /users` creates an `onboard-user` proposal; a second user-manager approves; approval creates the user, mints their custodial DID, and issues a KycCredential (anchored on-chain when Besu is up). Identity revocation becomes an equally gated `revoke-user-identity` flow (chain-first). The web gets the full Add-User form, gated Revoke-identity, and holder Sell/My-listings.

**Architecture:** Two new proposal kinds ride the existing scope-agnostic maker-checker registry (`proposal-kinds.ts`). Credential sign→anchor→persist and chain-first revoke are extracted from `credential-kinds.ts` into a shared `credential-issuance.ts` (behaviour-preserving). A "TokenLayer Platform" verifier org is seeded at boot as the default VC issuer when a use case has no owner org. The org-member path (`claims.orgId` on `POST /users`, and `/orgs/:id/users`) stays direct.

**Tech Stack:** Fastify + Prisma/SQLite (apps/api), vitest, React+Vite (apps/web), existing keystore (AES-256-GCM custodial seeds) and on-chain registry adapters.

**Spec:** `docs/superpowers/specs/2026-07-20-gated-onboarding-identity-lifecycle-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/user-policy.ts` (modify) | PlatformAdmin may assign all roster roles |
| `apps/api/src/credential-issuance.ts` (create) | shared `issueCredentialFor` / `revokeCredentialById` |
| `apps/api/src/credential-kinds.ts` (modify) | thin wrappers over the shared helpers |
| `apps/api/src/platform-org.ts` (create) | `ensurePlatformIssuerOrg` boot seeding |
| `apps/api/src/user-kinds.ts` (create) | `onboard-user` + `revoke-user-identity` kinds |
| `apps/api/src/proposal-kinds.ts` (modify) | register the two kinds |
| `apps/api/src/http/routes.ts` (modify) | gate `POST /users` (non-org path); add `POST /users/:id/revoke-identity` |
| `apps/api/src/http/schemas.ts` (modify) | 202 response on createUser; revoke-identity schema |
| `apps/api/src/server.ts` (modify) | call `ensurePlatformIssuerOrg` at boot |
| `apps/api/test/helpers.ts` (modify) | seed the platform org in `buildTestApp` |
| `apps/api/test/user-policy.test.ts`/core test (modify) | widened assignable roles |
| `apps/api/test/onboarding.test.ts` (create) | the full behavioural suite |
| `apps/web/src/api.ts`, `types.ts` (modify) | `revokeUserIdentity`; createUser returns proposal |
| `apps/web/src/components/UserManagement.tsx` (modify) | roles, 202 note, gated revoke, Suspend rename |
| `apps/web/src/components/ApprovalsPanel.tsx` (modify) | summaries for the two kinds |
| `apps/web/src/components/InvestorPortal.tsx` (modify) | Sell + My listings |
| `scripts/onboarding-e2e.mjs` (create) | live Besu E2E |
| `scripts/*.mjs` + `apps/api/src/e2e-*.ts` (modify) | propose→approve where they created users |

Conventions the implementer must follow (all confirmed in the codebase):
- Proposals are created with `deps.proposals.create({ useCaseKey, orgId, assetId, kind, payload, proposerId, proposerLabel, required })` and returned as `202 { proposal }`.
- Kind handlers implement `ProposalKindHandler` from `apps/api/src/proposal-kinds.ts`; errors thrown from `execute` use `coded(status, code, message)` from `./executors.js`. The proposal routes already exclude the proposer from approving (`SELF_APPROVAL`).
- Credential rows: `deps.credentials.create({ id, holderDid, issuerDid, type, vcJwt, subjectClaims, issuedAt, expiresAt, revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId })`; revocation via `deps.credentials.revoke(id, { reason, by, at })`.
- On-chain: `deps.registry?.anchor.anchorCredential(deps.registry.vcRegistry, id, vcJwt, now, expiresAt)`, `.revokeCredential(deps.registry.vcRegistry, id)`, `.registerDid(deps.registry.didRegistry, did)` — registry is optional; absent ⇒ skip (unanchored).
- Audit: `deps.audit.append({ actorId, action: "<name>" as LifecycleAction, payload })` (cast at the boundary, mirroring the existing `"kyc-verified"` entry in routes.ts).

---

### Task 1: Core — PlatformAdmin may assign roster roles

**Files:**
- Modify: `packages/core/src/user-policy.ts`
- Test: `packages/core/test/user-policy.test.ts` (add cases to the existing file; create it in this shape if absent)

- [ ] **Step 1: Write the failing test**

Append to the user-policy test file:

```ts
import { describe, expect, it } from "vitest";
import { assignableRoles, canCreateUser } from "../src/user-policy.js";

describe("PlatformAdmin assignable roles (gated onboarding)", () => {
  it("PlatformAdmin may assign every roster role", () => {
    expect(assignableRoles("PlatformAdmin")).toEqual(["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]);
  });
  it("PlatformAdmin may create a Buyer in a named use case, but never without one", () => {
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Buyer", "invoice-tokenization")).toBe(true);
    expect(canCreateUser({ role: "PlatformAdmin", useCaseKey: null }, "Buyer", null)).toBe(false);
  });
  it("UseCaseAdmin scope is unchanged", () => {
    expect(canCreateUser({ role: "UseCaseAdmin", useCaseKey: "a" }, "Buyer", "a")).toBe(true);
    expect(canCreateUser({ role: "UseCaseAdmin", useCaseKey: "a" }, "Buyer", "b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`assignableRoles("PlatformAdmin")` currently returns `["UseCaseAdmin"]`)

Run: `pnpm --filter @tokenlayer/core exec vitest run test/user-policy.test.ts`

- [ ] **Step 3: Implement** — in `packages/core/src/user-policy.ts` change only the PlatformAdmin branch:

```ts
export function assignableRoles(role: Role): Role[] {
  // PlatformAdmin may provision the full roster (gated onboarding approves it),
  // not just UseCaseAdmins; scoping still requires a named use case below.
  if (role === "PlatformAdmin") return ["UseCaseAdmin", ...ORG_INTERNAL_ROLES.filter((r) => r !== "UseCaseAdmin")];
  if (role === "OrgAdmin") return [...ORG_INTERNAL_ROLES];
  if (role === "UseCaseAdmin") return ["Issuer", "Buyer", "Auditor"];
  return [];
}
```

`canCreateUser` needs no change — it already requires a named use case for PlatformAdmin.

- [ ] **Step 4: Run core tests** — `pnpm --filter @tokenlayer/core test` → all pass.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): PlatformAdmin may assign roster roles (gated onboarding)"`

---

### Task 2: API — shared credential issuance/revocation helpers (behaviour-preserving refactor)

**Files:**
- Create: `apps/api/src/credential-issuance.ts`
- Modify: `apps/api/src/credential-kinds.ts`
- Guard: `pnpm --filter @tokenlayer/api test` — the existing credential tests must pass **unedited**.

- [ ] **Step 1: Create `apps/api/src/credential-issuance.ts`** — the bodies are MOVED verbatim from `credential-kinds.ts` (id-before-sign, anchor-before-persist, chain-first revoke), parameterised:

```ts
/**
 * Shared credential side-effects: sign→anchor→persist issuance and chain-first
 * revocation. Used by the credential proposal kinds AND the onboarding /
 * identity-revoke kinds so the invariants live in exactly one place.
 */
import { randomUUID } from "node:crypto";
import { credentialTypeDef } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { CredentialRecord, OrganizationRecord } from "./persistence/types.js";

export interface IssueCredentialArgs {
  issuerOrg: OrganizationRecord;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  proposalId: string | null;
}

/** Sign → anchor (when a registry is present) → persist. Throws ⇒ nothing persisted. */
export async function issueCredentialFor(deps: AppDeps, a: IssueCredentialArgs): Promise<CredentialRecord> {
  const def = credentialTypeDef(a.type);
  // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
  const credentialId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statusUrl = `${deps.publicApiUrl}/credentials/${credentialId}/status`;
  const { vcJwt, expiresAt } = deps.keystore.issueOrgCredential({
    orgEncSeed: a.issuerOrg.didSeedEncrypted, orgDid: a.issuerOrg.did, subjectDid: a.subjectDid,
    type: a.type, claims: a.claims, credentialId, statusUrl, validityDays: def.validityDays, now,
  });
  // Anchor BEFORE persisting: a throw here fails the caller and no row exists.
  if (deps.registry) {
    await deps.registry.anchor.anchorCredential(deps.registry.vcRegistry, credentialId, vcJwt, now, expiresAt);
  }
  return deps.credentials.create({
    id: credentialId,
    holderDid: a.subjectDid,
    issuerDid: a.issuerOrg.did,
    type: a.type,
    vcJwt,
    subjectClaims: { id: a.subjectDid, ...a.claims },
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: a.proposalId,
  });
}

/** Chain FIRST, then the database — the DB is never "more revoked" than the chain. */
export async function revokeCredentialById(
  deps: AppDeps, credentialId: string, meta: { reason: string; by: string; at: string },
): Promise<void> {
  const cred = await deps.credentials.get(credentialId);
  if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
  if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
  if (deps.registry) {
    await deps.registry.anchor.revokeCredential(deps.registry.vcRegistry, cred.id);
  }
  await deps.credentials.revoke(cred.id, meta);
}
```

(If `CredentialRecord`/`OrganizationRecord` are named differently in `persistence/types.ts`, use the exact exported names — check the imports at the top of `credential-kinds.ts` and `routes.ts`.)

- [ ] **Step 2: Rewrite the two executors in `credential-kinds.ts` as thin wrappers** (keep the payload interfaces and canView/canApprove untouched):

```ts
import { issueCredentialFor, revokeCredentialById } from "./credential-issuance.js";
// ...
export const issueCredentialKind: ProposalKindHandler = {
  kind: "issue-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueCredentialPayload;
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: pl.type, claims: pl.claims, proposalId: p.id,
    });
  },
};

export const revokeCredentialKind: ProposalKindHandler = {
  kind: "revoke-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as RevokeCredentialPayload;
    await revokeCredentialById(ctx.deps, pl.credentialId, {
      reason: pl.reason, by: p.proposerId, at: new Date().toISOString(),
    });
  },
};
```

Delete the now-unused `randomUUID`/`credentialTypeDef` imports from `credential-kinds.ts` if nothing else uses them.

- [ ] **Step 3: Run the FULL api suite — the refactor guard.** `pnpm --filter @tokenlayer/api test` → **all existing tests pass with zero edits to test files.** If any credential test fails, the refactor changed behaviour — fix the helper, not the test.

- [ ] **Step 4: Commit** — `git commit -am "refactor(api): extract shared credential issuance/revocation helpers (behaviour-preserving)"`

---

### Task 3: API — platform issuer org, seeded at boot

**Files:**
- Create: `apps/api/src/platform-org.ts`
- Modify: `apps/api/src/server.ts` (call after the registry is resolved), `apps/api/test/helpers.ts` (call in `buildTestApp`)
- Test: `apps/api/test/onboarding.test.ts` (start the file with this test)

- [ ] **Step 1: Write the failing test** — create `apps/api/test/onboarding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";
import { PLATFORM_ORG_NAME } from "../src/platform-org.js";

describe("platform issuer org", () => {
  it("is seeded at boot: verifier type, verified, has a did:key", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123"); // use the helper login pattern already in this test suite (see identity.test.ts)
    const res = await app.inject({ method: "GET", url: "/api/v1/orgs", headers: { authorization: `Bearer ${platform}` } });
    const org = (res.json() as Array<{ name: string; orgType: string; verified: boolean; did: string }>).find((o) => o.name === PLATFORM_ORG_NAME);
    expect(org).toBeDefined();
    expect(org!.orgType).toBe("verifier");
    expect(org!.verified).toBe(true);
    expect(org!.did.startsWith("did:key:z")).toBe(true);
  });
});
```

Copy the exact login helper used by `apps/api/test/identity.test.ts` (an `app.inject` POST to `/api/v1/auth/login` returning `token`) to the top of this file as `loginAs`.

- [ ] **Step 2: Run it — FAIL** (`platform-org.js` doesn't exist).

Run: `pnpm --filter @tokenlayer/api exec vitest run test/onboarding.test.ts`

- [ ] **Step 3: Implement `apps/api/src/platform-org.ts`:**

```ts
/**
 * The "TokenLayer Platform" issuer organization — the default signer for
 * onboarding KycCredentials when a use case has no owner org. Seeded
 * idempotently at boot; its DID is registered on-chain when a registry is
 * present (best-effort — boot never fails on it).
 */
import { didKeyFromSeed } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import type { OrganizationRecord } from "./persistence/types.js";

export const PLATFORM_ORG_NAME = "TokenLayer Platform";

type PlatformOrgDeps = Pick<AppDeps, "organizations" | "keystore" | "registry">;

export async function ensurePlatformIssuerOrg(deps: PlatformOrgDeps): Promise<OrganizationRecord> {
  const existing = (await deps.organizations.list()).find((o) => o.name === PLATFORM_ORG_NAME);
  if (existing) return existing;
  const seed = deps.keystore.newSeed();
  const didSeedEncrypted = deps.keystore.encryptSeed(seed);
  const did = didKeyFromSeed(seed).did;
  const org = await deps.organizations.create({
    // Mirror the exact create-input shape used by POST /orgs in routes.ts
    // (name, orgType, registrationId, jurisdiction, did, didSeedEncrypted, verified, status).
    name: PLATFORM_ORG_NAME, orgType: "verifier", registrationId: null, jurisdiction: null,
    did, didSeedEncrypted, verified: true, status: "active",
  } as Parameters<typeof deps.organizations.create>[0]);
  if (deps.registry) {
    // Best-effort: an unreachable chain must not block boot.
    await deps.registry.anchor.registerDid(deps.registry.didRegistry, did).catch((err) =>
      console.warn(`[platform-org] on-chain DID registration failed (will remain unregistered): ${(err as Error).message}`));
  }
  return org;
}
```

Open `routes.ts` POST `/orgs` and copy its exact `organizations.create({...})` field list — if it differs from the above (e.g. extra timestamps), match it and drop the `as Parameters<...>` cast.

- [ ] **Step 4: Wire boot + tests.**
  - `apps/api/src/server.ts`: after the registry is resolved and deps are assembled (immediately after the `[registry]` log / `resolveIdentityRegistry` block), add:
    ```ts
    const { ensurePlatformIssuerOrg } = await import("./platform-org.js");
    await ensurePlatformIssuerOrg(deps);
    ```
    (Use a static top-of-file import if server.ts uses static imports — match the file's existing style.)
  - `apps/api/test/helpers.ts`: inside `buildTestApp`, after the deps object is assembled and before the app is returned, add `await ensurePlatformIssuerOrg(deps);` with the matching import.

- [ ] **Step 5: Run** `pnpm --filter @tokenlayer/api exec vitest run test/onboarding.test.ts` → PASS; then the full api suite → green.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): seed the TokenLayer Platform issuer org at boot"`

---

### Task 4: API — `onboard-user` and `revoke-user-identity` proposal kinds

**Files:**
- Create: `apps/api/src/user-kinds.ts`
- Modify: `apps/api/src/proposal-kinds.ts` (register)

- [ ] **Step 1: Create `apps/api/src/user-kinds.ts`:**

```ts
/**
 * User-lifecycle proposal kinds: gated onboarding (create user + custodial DID
 * + KycCredential) and gated identity revocation (chain-first). USE-CASE scoped:
 * PlatformAdmin always; a UseCaseAdmin of the same use case otherwise.
 */
import { didKeyFromSeed, type LifecycleAction, type Role } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { issueCredentialFor, revokeCredentialById } from "./credential-issuance.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import { PLATFORM_ORG_NAME } from "./platform-org.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

/** PlatformAdmin always; a UseCaseAdmin of the SAME use case. Never null-matches. */
const userScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" ||
  (claims.role === "UseCaseAdmin" && p.useCaseKey !== null && claims.useCaseKey === p.useCaseKey);

export interface OnboardUserPayload {
  email: string;
  passwordHash: string;          // hashed at propose time — plaintext never stored
  role: Role;
  useCaseKey: string | null;
  walletAddress: string | null;
  kyc: { legalName: string; country: string; idType?: string; idNumber?: string; documentRef?: string } | null;
}

/** ownerOrg of the use case when present, else the platform issuer org. */
async function resolveIssuerOrg(deps: AppDeps, useCaseKey: string | null) {
  if (useCaseKey) {
    const uc = await deps.useCases.get(useCaseKey).catch(() => null);
    if (uc?.ownerOrgId) {
      const org = await deps.organizations.get(uc.ownerOrgId);
      if (org) return org;
    }
  }
  const platform = (await deps.organizations.list()).find((o) => o.name === PLATFORM_ORG_NAME);
  if (!platform) throw coded(503, "PLATFORM_ISSUER_MISSING", "the platform issuer org is not seeded");
  return platform;
}

export const onboardUserKind: ProposalKindHandler = {
  kind: "onboard-user",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as OnboardUserPayload;
    // Re-check the email — it may have been taken since propose (race ⇒ failed proposal).
    if (await deps.users.findByEmail(pl.email)) throw coded(409, "EMAIL_TAKEN", "email already registered");
    let accountId: string | null = null;
    if (pl.walletAddress) accountId = (await deps.accounts.upsert(pl.walletAddress, pl.email)).id;
    const created = await deps.users.create({
      email: pl.email, passwordHash: pl.passwordHash, role: pl.role, useCaseKey: pl.useCaseKey,
      accountId, active: true, kycStatus: "pending", kyc: pl.kyc ?? null,
    });
    try {
      // Mint the custodial DID (same custody as org members: encrypted Ed25519 seed).
      const seed = deps.keystore.newSeed();
      const didSeedEncrypted = deps.keystore.encryptSeed(seed);
      const did = didKeyFromSeed(seed).did;
      await deps.users.update(created.id, { did, didSeedEncrypted });
      if (pl.kyc) {
        const issuerOrg = await resolveIssuerOrg(deps, pl.useCaseKey);
        const cred = await issueCredentialFor(deps, {
          issuerOrg, subjectDid: did, type: "KycCredential",
          claims: { legalName: pl.kyc.legalName, country: pl.kyc.country },
          proposalId: p.id,
        });
        await deps.users.update(created.id, {
          kycStatus: "approved",
          kyc: { ...pl.kyc, issuerDid: issuerOrg.did, credentialId: cred.id, verifiedAt: new Date().toISOString() },
        });
      }
      await deps.audit.append({
        actorId: proposer.id, action: "user-onboarded" as LifecycleAction,
        payload: { userId: created.id, email: pl.email, role: pl.role, did, kyc: pl.kyc ? { country: pl.kyc.country } : null },
      });
    } catch (err) {
      // DID mint failed ⇒ no user row survives (mirrors the org-member rollback).
      // A credential failure AFTER the DID mint keeps the user pending — but to
      // keep the proposal contract simple we roll back entirely here too: the
      // proposal is `failed`, the operator re-proposes.
      await deps.users.remove(created.id).catch(() => undefined);
      throw err;
    }
  },
};

export interface RevokeUserIdentityPayload {
  userId: string;
  reason: string;
}

export const revokeUserIdentityKind: ProposalKindHandler = {
  kind: "revoke-user-identity",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as RevokeUserIdentityPayload;
    const user = await deps.users.findById(pl.userId);
    if (!user) throw coded(404, "NOT_FOUND", "user missing");
    const at = new Date().toISOString();
    if (user.did) {
      // Chain-first per credential; any on-chain failure fails the proposal
      // BEFORE the DB flip — the DB is never "more revoked" than the chain.
      const held = (await deps.credentials.listByHolder(user.did)).filter((c) => !c.revoked);
      for (const c of held) {
        await revokeCredentialById(deps, c.id, { reason: pl.reason, by: p.proposerId, at });
      }
    }
    await deps.users.update(user.id, {
      kycStatus: "rejected",
      kyc: { ...(user.kyc ?? {}), revokedAt: at, revokeReason: pl.reason },
    });
    await deps.audit.append({
      actorId: proposer.id, action: "user-identity-revoked" as LifecycleAction,
      payload: { userId: user.id, reason: pl.reason },
    });
  },
};
```

Check `CredentialRepository` in `persistence/types.ts` for the by-holder listing method name (`listByHolder(holderDid)` is used by `GET /me/credentials` — grep `listByHolder` and use the exact name; if it takes a status filter, pass none and filter `!revoked` in code as above).

- [ ] **Step 2: Register the kinds** — at the bottom of `apps/api/src/proposal-kinds.ts`, next to the credential-kind registrations:

```ts
import { onboardUserKind, revokeUserIdentityKind } from "./user-kinds.js";
// ...
registerProposalKind(onboardUserKind);
registerProposalKind(revokeUserIdentityKind);
```

(Keep the import at the top of the file with the other imports; `user-kinds.ts` imports only the `ProposalKindHandler` type from `proposal-kinds.ts`, so there is no runtime cycle — same pattern as `credential-kinds.ts`.)

- [ ] **Step 3: Typecheck + full api suite still green** — `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api test`

- [ ] **Step 4: Commit** — `git commit -am "feat(api): onboard-user + revoke-user-identity proposal kinds"`

---

### Task 5: API — routes: gate POST /users (non-org path); add revoke-identity

**Files:**
- Modify: `apps/api/src/http/routes.ts` (the `POST /users` handler; add `POST /users/:id/revoke-identity`)
- Modify: `apps/api/src/http/schemas.ts`

- [ ] **Step 1: Rewrite `POST /users`.** Keep the guard block (`canCreateUser`, email check) and the **org branch exactly as it is today** (a creator with `claims.orgId` still creates directly + mints membership — org onboarding is out of scope). Replace only the non-org tail:

```ts
app.post("/users", { schema: S.createUser, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails };
  const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey ?? null) : claims.useCaseKey;
  if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey)) {
    return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that user" });
  }
  if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });

  if (claims.orgId) {
    // Org-member onboarding stays DIRECT (sub-DID + membership VC) — unchanged.
    // <the existing accountId/create/mintMembership/201 block, verbatim>
  }

  // Use-case user management is maker-checker: hash the password NOW (plaintext
  // never enters the proposal store) and park everything in an onboard-user
  // proposal for a second user-manager to approve.
  const kyc = b.kyc && b.kyc.legalName && b.kyc.country ? b.kyc : null;
  const proposal = await deps.proposals.create({
    useCaseKey: targetUseCaseKey, orgId: null, assetId: null, kind: "onboard-user",
    payload: {
      email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS),
      role: b.role, useCaseKey: targetUseCaseKey, walletAddress: b.walletAddress ?? null, kyc,
    },
    proposerId: claims.id, proposerLabel: claims.email, required: 1,
  });
  return reply.code(202).send({ proposal });
});
```

Note the KYC block is treated as present only when `legalName` **and** `country` are set (the web form always sends the object; empty strings must not mint a credential).

- [ ] **Step 2: Add the revoke route** (place it next to the other `/users/:id/...` routes):

```ts
app.post("/users/:id/revoke-identity", { schema: S.revokeUserIdentity, ...auth }, async (request, reply) => {
  const claims = request.user as TokenClaims;
  const { id } = request.params as { id: string };
  const { reason } = request.body as { reason: string };
  const target = await deps.users.findById(id);
  if (!target) return notFound(reply, "user not found");
  const sameScope = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
  if (!sameScope) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to revoke that user's identity" });
  const pending = await deps.proposals.list(target.useCaseKey ?? undefined, "pending");
  if (pending.some((p) => p.kind === "revoke-user-identity" && p.payload.userId === id)) {
    return reply.code(409).send({ error: "ALREADY_PENDING", message: "a revoke proposal for this user is already pending" });
  }
  const proposal = await deps.proposals.create({
    useCaseKey: target.useCaseKey, orgId: null, assetId: null, kind: "revoke-user-identity",
    payload: { userId: id, reason },
    proposerId: claims.id, proposerLabel: claims.email, required: 1,
  });
  return reply.code(202).send({ proposal });
});
```

- [ ] **Step 3: Schemas** (`apps/api/src/http/schemas.ts`).
  - `createUser`: add a `202` response — copy the exact `202: { proposal }` response object from `S.requestCredential` (same `$ref` name) and extend its `errs(...)` with `403`.
  - Add `revokeUserIdentity`: params `{ id: string }`, body `{ reason: string, minLength 1, required }`, response `202` same proposal shape, plus `errs(400, 403, 404, 409)`. Mirror the structure of `S.revokeCredential` verbatim, adjusting names.

- [ ] **Step 4: Typecheck** — `pnpm --filter @tokenlayer/api exec tsc --noEmit`. Then run the full api suite: **expect failures** in any existing test that called `POST /users` and asserted `201` for non-org creators — fix those tests to follow propose→approve (helpers may add a convenience `onboardUser(app, managerToken, approverToken, body)` in `test/helpers.ts` that proposes then approves and returns the created user id via `GET /users`). Update `apps/api/src/e2e-*.ts` harness scripts and `apps/api/src/demo.ts` the same way IF they create users through HTTP; those that seed via repositories directly are unaffected.

- [ ] **Step 5: Commit** — `git commit -am "feat(api): gate POST /users behind onboard-user; gated revoke-identity route"`

---

### Task 6: API — the behavioural test suite

**Files:**
- Modify: `apps/api/test/onboarding.test.ts` (extend the file from Task 3)
- Modify (if needed): `apps/api/test/helpers.ts` (the `onboardUser` convenience + a registry test double import — reuse the double from the registry tests, grep `registry` in `apps/api/test/*.ts` for its constructor)

Write all tests below, run each to fail where the behaviour is new, then confirm the suite passes. Use the file's `loginAs` helper; seeded credentials: `admin@tokenlayer.dev/admin123` (PlatformAdmin), `carbon.admin@tokenlayer.dev/carbon123` and the other `<prefix>.admin` UseCaseAdmins (see `apps/api/src/seed.ts`).

- [ ] **Step 1: Happy path** — UseCaseAdmin (carbon) proposes a Buyer with wallet + KYC `{legalName:"Asha", country:"IN"}` → `202` with `kind: "onboard-user"`; PlatformAdmin approves via `POST /proposals/:id/approve` → proposal `executed`; `GET /users` shows the user `kycStatus: "approved"` with `kyc.credentialId`; the user can log in; `GET /me/credentials` as that user returns one `KycCredential`; and the login response/user record carries a `did:key`.
- [ ] **Step 2: SoD** — the proposer approving their own proposal → the registry's `SELF_APPROVAL` error (409/403 per existing proposal tests — assert the same code the credential tests assert). A UseCaseAdmin of a DIFFERENT use case cannot even see it (`GET /proposals` filtered) nor approve (403/404).
- [ ] **Step 3: Reject** — propose, then `POST /proposals/:id/reject` → no user row, `GET /users` unchanged, login fails.
- [ ] **Step 4: Duplicate email** — existing email at propose → `400 EMAIL_TAKEN`. Race: propose A, propose B (different proposals, same email — requires proposing before either executes), approve A (executes), approve B → proposal B `failed` with `EMAIL_TAKEN`, exactly one user exists.
- [ ] **Step 5: No-KYC onboarding** — propose without the kyc block → approve → user `pending`, has a DID, `GET /me/credentials` empty; then the existing identity-verify flow (`identity/challenge` + dev mint + `identity/verify`, as in `identity.test.ts`) flips them to approved.
- [ ] **Step 6: Revoke** — onboard with KYC, then `POST /users/:id/revoke-identity {reason:"exit"}` → 202; second manager approves → credential `revoked: true` (via `GET /credentials/:id/status`), user `kycStatus: "rejected"`, user can STILL log in, and `POST /assets/:id/actions/allow` for their wallet now fails `KYC_NOT_APPROVED`. Duplicate pending revoke → `409 ALREADY_PENDING`.
- [ ] **Step 7: Chain-first ordering** — build the app with the registry test double; make the double's `revokeCredential` throw once → approval leaves the proposal `failed` AND the credential row still `revoked: false`. With a recording double, assert `revokeCredential` was called before any DB flip (order array).
- [ ] **Step 8: Issuer resolution** — (a) use case with `ownerOrgId` set (create an org + a use case owned by it, as the org tests do) → the issued VC's `issuerDid` equals the org's DID; (b) without owner → equals the platform org's DID; (c) `ensurePlatformIssuerOrg` called twice creates one org (idempotent).
- [ ] **Step 9: Full suite green** — `pnpm --filter @tokenlayer/api test` → everything passes, including the untouched credential tests.
- [ ] **Step 10: Commit** — `git commit -am "test(api): gated onboarding + identity revoke behavioural suite"`

---

### Task 7: Update live-E2E harness scripts that create users

**Files:**
- Modify: `scripts/identity-vc-e2e.mjs`, `scripts/verification-e2e.mjs`, `scripts/invoice-didvc-e2e.mjs`, `scripts/invoice-50-e2e.mjs`, `scripts/investor-portal-e2e.mjs`, `scripts/gold-egr-e2e.mjs`, `scripts/multi-dlt-e2e.mjs`, `scripts/erp-import.mjs`, `scripts/audit-tamper-e2e.mjs` — ONLY where they `POST /users` as a non-org caller.

- [ ] **Step 1:** Add one shared helper (copy into each script that needs it — scripts are self-contained by convention):

```js
// Gated onboarding: POST /users now 202s a proposal; a second manager approves.
async function onboardUser(makerTok, approverTok, body) {
  const r = await call("POST", "/users", body, makerTok);
  if (r.status === 201) return r.json;               // org-path callers still 201
  if (r.status !== 202) return r.json;               // let callers assert failures
  await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, approverTok);
  const list = await call("GET", "/users", null, approverTok);
  return (list.json ?? []).find((u) => u.email === body.email);
}
```

- [ ] **Step 2:** Replace each direct `POST /users` (+ any following `PATCH kycStatus: approved` — now redundant when KYC data is supplied) with `onboardUser(uca, platform, {...})`, passing KYC `{legalName, country: "IN"}` where the script previously PATCH-approved. `scripts/org-identity-e2e.mjs` and org-member creations are untouched.

- [ ] **Step 3:** Sanity-run whichever scripts run without live chains (none run in CI; a compile/lint pass via `node --check scripts/*.mjs` is enough here — live runs happen in Task 10).

- [ ] **Step 4: Commit** — `git commit -am "test(e2e): harness scripts onboard via propose→approve"`

---

### Task 8: Web — Add-User 202 flow, gated revoke, inbox summaries

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/components/UserManagement.tsx`, `apps/web/src/components/ApprovalsPanel.tsx`

- [ ] **Step 1: `api.ts`** — change `createUser`'s return type to `{ proposal: Proposal }` and add:

```ts
revokeUserIdentity: (token: string, id: string, reason: string) =>
  request<{ proposal: Proposal }>(`/users/${encodeURIComponent(id)}/revoke-identity`, token, { method: "POST", body: JSON.stringify({ reason }) }),
```

(import `Proposal` from `./types.js` where the file already does.)

- [ ] **Step 2: `UserManagement.tsx`.**
  - `ROLE_OPTIONS.PlatformAdmin` → `["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]` (mirrors Task 1).
  - `AddUser.create`: capture the 202 — replace the `onAdded()` tail with a success state:
    ```tsx
    const r = await api.createUser(token!, { ... });            // unchanged args
    setNotice(`Onboarding proposal submitted (${r.proposal.id.slice(0, 8)}…) — a second user-manager must approve it in Approvals.`);
    // clear the fields as today; do NOT switch to Manage (the user won't exist yet)
    ```
    with `const [notice, setNotice] = useState<string | null>(null)` rendered as a green note above the submit button. Only send the `kyc` object when `legalName && country` are non-empty (`kyc: legalName && country ? { legalName, country, idType, idNumber, documentRef } : undefined`). Show the wallet input for every role (not just Buyer): `const needsWallet = true` → just always render it, keep it optional.
  - `ManageUsers` actions: **remove** the one-click `Approve`/`Reject` kycStatus buttons; rename the active-toggle label from `Revoke`/`Reactivate` to `Suspend`/`Reactivate` (it stays direct — deactivation is deliberately manual); add a gated action:
    ```tsx
    {u.kycStatus !== "rejected" && (
      <button onClick={() => { const reason = window.prompt("Reason for revoking this user's identity?"); if (reason) void act(() => api.revokeUserIdentity(token!, u.id, reason)); }}
        className="text-xs text-red-500 hover:text-red-700">Revoke identity</button>
    )}
    ```
    and surface the 202 as a notice ("Revoke proposal submitted — pending approval") instead of `onChanged()` refreshing to no visible change: `act` may keep working as-is, plus a `setError(null)`-style `notice` line mirroring AddUser.
  - Keep `Verify identity (DID/VC)` for `pending` users exactly as is.
- [ ] **Step 3: `ApprovalsPanel.tsx`** — extend the summary function (top of file, the `if (p.kind === ...)` chain):

```ts
if (p.kind === "onboard-user") return `onboard ${String(pl.role ?? "user")} ${String(pl.email ?? "")}${(pl.kyc as Record<string, unknown> | null)?.country ? ` (KYC: ${String((pl.kyc as Record<string, unknown>).country)})` : ""}`;
if (p.kind === "revoke-user-identity") return `revoke a user's identity — ${String(pl.reason ?? "no reason given")}`;
```

- [ ] **Step 4: Build** — `pnpm --filter @tokenlayer/web build` → clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): gated Add-User + Revoke-identity + inbox summaries"`

---

### Task 9: Web — holder Sell + My listings in the portal

**Files:**
- Modify: `apps/web/src/components/InvestorPortal.tsx`

- [ ] **Step 1: Sell panel.** In `InvestorPortfolio`, add state `const [selling, setSelling] = useState<Holding | null>(null)` and an Actions column: each holding row gets `<button onClick={() => setSelling(h)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Sell</button>`. Below the table render:

```tsx
{selling && <SellPanel holding={selling} onDone={() => { setSelling(null); reload(); }} onClose={() => setSelling(null)} />}
```

where `reload` refetches `mePortfolio` (extract the existing effect body into a `reload` function used by both). New component in the same file:

```tsx
function SellPanel({ holding, onDone, onClose }: { holding: Holding; onDone: () => void; onClose: () => void }): JSX.Element {
  const { token } = useAuth();
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState(holding.unitPrice ?? "");
  const [currency, setCurrency] = useState(holding.currency ?? "CBDC-INR");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function sell(): Promise<void> {
    setError(null); setBusy(true);
    try {
      await api.createListing(token!, holding.assetId, { quantity, unitPrice, currency });
      onDone();
    } catch (err) { setError(err instanceof ApiError ? err.message : "Listing failed"); }
    finally { setBusy(false); }
  }
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">Sell — {holding.name}</h3>
        <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <input className="input" type="number" placeholder={`quantity (≤ ${holding.units})`} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input className="input" type="number" placeholder="unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {["CBDC-INR", "USDC", "e-GBP"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <button onClick={() => void sell()} disabled={busy || !quantity || !unitPrice}
        className="mt-3 rounded-lg bg-brand-600 text-white px-4 py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40">List for sale</button>
    </Card>
  );
}
```

- [ ] **Step 2: My listings.** New component rendered under the holdings table:

```tsx
function MyListings({ wallet, holdings, refreshKey }: { wallet: string; holdings: Holding[]; refreshKey: number }): JSX.Element | null {
  const { token } = useAuth();
  const [mine, setMine] = useState<Array<Listing & { assetName: string; assetId: string }>>([]);
  useEffect(() => {
    if (!token) return;
    void Promise.all(holdings.map(async (h) => (await api.listings(token, h.assetId).catch(() => []))
      .filter((l) => l.seller.toLowerCase() === wallet.toLowerCase() && (l.status ?? "open") === "open")
      .map((l) => ({ ...l, assetName: h.name, assetId: h.assetId }))))
      .then((groups) => setMine(groups.flat()));
  }, [token, wallet, holdings, refreshKey]);
  if (mine.length === 0) return null;
  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-900 mb-2">My listings</h3>
      {mine.map((l) => (
        <div key={l.id} className="flex items-center justify-between py-1.5 border-t border-slate-100 text-sm">
          <span>{l.assetName} · {l.quantity} @ {l.unitPrice} {l.currency}</span>
          <button onClick={() => void api.cancelListing(token!, l.id).then(() => setMine((m) => m.filter((x) => x.id !== l.id)))}
            className="text-xs text-red-500 hover:text-red-700">Cancel</button>
        </div>
      ))}
    </Card>
  );
}
```

Wire it with a `refreshKey` counter bumped by `onDone`. Import `Listing` from `../types.js`; note the seller wallet is `pf.wallet`. **Caveat honoured:** selling escrows units immediately — the portfolio reload after listing shows the reduced balance.

- [ ] **Step 3: Build** — `pnpm --filter @tokenlayer/web build` → clean.
- [ ] **Step 4: Commit** — `git commit -am "feat(web): holder Sell + My listings in the investor portal"`

---

### Task 10: Verify — full suite, live Besu E2E, browser, finish

**Files:**
- Create: `scripts/onboarding-e2e.mjs`

- [ ] **Step 1: Full suite + builds** — `pnpm -r test && pnpm --filter @tokenlayer/web build` → everything green.

- [ ] **Step 2: Write `scripts/onboarding-e2e.mjs`** (same self-contained `call/ok/login` conventions as `scripts/verification-e2e.mjs` — copy its helper block):
  flow: platform login → UseCaseAdmin (carbon) proposes a Buyer with wallet + KYC(IN) → assert `202 pending` → **proposer self-approve is refused** → platform admin approves → user exists, approved, has DID → `GET /me/credentials` as the user shows the KycCredential → **independent proof:** raw `eth_call` `statusOf` on the VcRegistry shows the anchor exists (copy the eth_call helper from `scripts/onchain-registry-e2e.mjs`) → fund + allowlist + buy succeeds → `POST /users/:id/revoke-identity` → approve → status endpoint reports revoked with `source:"chain"` → `allow` for a fresh asset now fails `KYC_NOT_APPROVED` → the user can still log in. Exit non-zero on any failed check.

- [ ] **Step 3: Run it live** — `make besu-up`, fresh scratch DB, boot the API with the standard live env (`BESU_RPC_URL`, `BESU_OPERATOR_KEY`, `REGISTRY_CHAIN_ID=besu`, `LOGIN_RATE_LIMIT_MAX=1000`, `DEV_KYC_ISSUER_SEED`, `TRUSTED_KYC_ISSUERS` — see `docs/superpowers/plans/2026-07-17-verifier-presentation.md` Task 8 for the exact recipe), then `node scripts/onboarding-e2e.mjs` → all checks pass. Also re-run `scripts/verification-e2e.mjs` and `scripts/identity-vc-e2e.mjs` to prove the Task-7 migrations work live.

- [ ] **Step 4: Browser verification** (preview servers per `.claude/launch.json`): as PlatformAdmin — Add User (Buyer + wallet + KYC) → pending note → Approvals shows `onboard-user` summary; approve as a second manager → user active/approved in Manage Users; Revoke identity → proposal → approve → KYC rejected. As the onboarded Buyer — portfolio → Sell a holding → listing appears in My listings → Cancel works. Screenshot proof.

- [ ] **Step 5: Teardown + finish** — `make besu-down`, remove scratch DBs, then use superpowers:finishing-a-development-branch.

---

## Self-review notes

- **Spec coverage:** §1 onboarding kind → Tasks 4–6; §2 issuer/platform org → Tasks 3, 4 (`resolveIssuerOrg`), 6.8; §3 revoke kind → Tasks 4–6; §4 shared helpers → Task 2; §5 web → Tasks 8–9; §6 API table → Task 5; error handling → Tasks 4 (rollback), 6.4/6.7; testing section → Tasks 6 and 10. One deliberate deviation, recorded in the code comment in Task 4: a credential failure after the DID mint rolls the user back entirely (proposal `failed`, operator re-proposes) instead of leaving a pending user — simpler contract, still fail-closed; the spec's "never a half-approved KYC" invariant holds either way.
- **Type consistency:** `OnboardUserPayload`/`RevokeUserIdentityPayload` (Task 4) match the payloads built in Task 5 and read in Task 8's summaries; `issueCredentialFor`/`revokeCredentialById` signatures (Task 2) match their call sites (Tasks 2 and 4); `revokeUserIdentity` client (Task 8) matches the route (Task 5).
- **Known verify-points for the implementer** (exact names to confirm on first touch, flagged inline): the credentials by-holder method name (Task 4), the `organizations.create` input shape (Task 3), and the proposal `$ref` name in schemas (Task 5).
