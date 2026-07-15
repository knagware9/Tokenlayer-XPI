# Organizations + User Management + Identity Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Organizations the top tenant — each org and every user gets a custodial did:key, and each member gets an org-issued OrganizationMembership Verifiable Credential.

**Architecture:** Reuse `packages/core/src/identity.ts` (did:key + Ed25519 VC-JWT) unchanged except for one backward-compatible `type` parameter on `issueCredential`. A new API-layer keystore custodies each DID's 32-byte Ed25519 seed encrypted at rest (AES-256-GCM under `DID_MASTER_KEY`) and signs membership VCs on the org's behalf. New `Organization` and `Credential` repos (Prisma + Memory) sit beside the existing ones; `User` gains `orgId`/`didSeedEncrypted` and `UseCase` gains `ownerOrgId`. Org-scoped routes create orgs (parent DID), add members (sub-DID + membership VC), and expose credentials + W3C DID documents. The web dashboard gains an Organizations admin area (org card + Members table) and a "My identity" view.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm monorepo, Fastify + `@fastify/jwt`, Prisma + SQLite, Vitest, React + Vite + Tailwind, `node:crypto` (AES-256-GCM + Ed25519).

**Reference spec:** `docs/superpowers/specs/2026-07-11-organizations-identity-design.md`

---

## File Structure

**Create:**
- `apps/api/src/keystore.ts` — custodial seed encryption + membership-VC issuance.
- `apps/api/test/keystore.test.ts` — keystore unit tests.
- `apps/api/test/organizations.test.ts` — org/member/credential/DID-document API tests.
- `scripts/org-identity-e2e.mjs` — live end-to-end script.
- `apps/web/src/components/Organizations.tsx` — org list/create + Members table.
- `apps/web/src/components/MyIdentity.tsx` — caller's DID document + held credentials.

**Modify (core):**
- `packages/core/src/types.ts` — add `"OrgAdmin"` to `Role`/`ROLES`; add `ownerOrgId?` to `UseCaseDefinition`.
- `packages/core/src/rbac.ts` — add `OrgAdmin` to the RBAC matrix (`read` only).
- `packages/core/src/user-policy.ts` — `assignableRoles`/`canManageUsers` for `OrgAdmin`; new `canCreateOrgMember`.
- `packages/core/src/identity.ts` — `issueCredential` gains optional `type?: string[]`.
- `packages/core/src/validation.ts` — `normalizeUseCaseDefinition` round-trips `ownerOrgId`.

**Modify (api):**
- `apps/api/prisma/schema.prisma` — `Organization` + `Credential` models; `User.orgId`/`User.didSeedEncrypted`; `UseCase.ownerOrgId`.
- `apps/api/src/persistence/types.ts` — `OrganizationRecord`/`CredentialRecord` + repo interfaces; widen `UserRecord` + `UserRepository`.
- `apps/api/src/persistence/memory.ts` — memory Organization/Credential repos; widen user repo.
- `apps/api/src/persistence/prisma.ts` — prisma Organization/Credential repos; widen user repo + use-case `ownerOrgId`.
- `apps/api/src/env.ts` — `DID_MASTER_KEY` (real-or-dev) + `didMasterConfigured`.
- `apps/api/src/context.ts` — `AppDeps` gains `organizations`, `credentials`, `keystore`, `didMasterConfigured`.
- `apps/api/src/server.ts` + `apps/api/test/helpers.ts` — construct + inject the new deps.
- `apps/api/src/http/support.ts` — `TokenClaims` gains `orgId`/`did`; `requireUser` refreshes them.
- `apps/api/src/http/routes.ts` — org/member/credential/DID routes; `orgId`/`did` in login claims; `/use-cases` org filter; org-aware `POST /users`.
- `apps/api/src/http/schemas.ts` — schemas for the new routes.

**Modify (web):**
- `apps/web/src/types.ts` — `Organization`, `OrgMember`, `HeldCredential`, `DidDocument`; add `"OrgAdmin"` to `Role`; `SessionUser.orgId`/`did`.
- `apps/web/src/api.ts` — `orgs`, `createOrg`, `org`, `orgMembers`, `createMember`, `myCredentials`, `didDocument`.
- `apps/web/src/rbac.ts` — treat `OrgAdmin` as a user-manager.
- `apps/web/src/App.tsx` — Organizations + My identity nav sections.

---

## Task 1: Core — OrgAdmin role, RBAC, user-policy, issueCredential type, ownerOrgId

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/rbac.ts`
- Modify: `packages/core/src/user-policy.ts`
- Modify: `packages/core/src/identity.ts`
- Modify: `packages/core/src/validation.ts`
- Test: `packages/core/src/user-policy.test.ts` (create) and `packages/core/src/rbac.test.ts` (create if absent — see step 1)

- [ ] **Step 1: Write failing tests for the new role + policy**

Create `packages/core/src/user-policy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { RbacPolicy } from "./rbac.js";
import { assignableRoles, canCreateOrgMember, canManageUsers } from "./user-policy.js";
import { ROLES } from "./types.js";

describe("OrgAdmin role", () => {
  it("is a known role", () => {
    expect(ROLES).toContain("OrgAdmin");
  });

  it("has only read authority in the RBAC matrix", () => {
    const rbac = new RbacPolicy();
    expect(rbac.can("OrgAdmin", "read")).toBe(true);
    for (const action of ["issue", "mint", "transfer", "burn", "freeze", "unfreeze", "allow", "disallow", "buy", "list", "cancel-listing"] as const) {
      expect(rbac.can("OrgAdmin", action)).toBe(false);
    }
  });

  it("can manage users and assign org-internal roles", () => {
    expect(canManageUsers("OrgAdmin")).toBe(true);
    expect(assignableRoles("OrgAdmin")).toEqual(["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"]);
  });
});

describe("canCreateOrgMember", () => {
  it("lets PlatformAdmin create an OrgAdmin but OrgAdmin cannot", () => {
    expect(canCreateOrgMember("PlatformAdmin", "OrgAdmin")).toBe(true);
    expect(canCreateOrgMember("OrgAdmin", "OrgAdmin")).toBe(false);
  });
  it("lets both admins create org-internal roles", () => {
    for (const r of ["PlatformAdmin", "OrgAdmin"] as const) {
      expect(canCreateOrgMember(r, "Issuer")).toBe(true);
      expect(canCreateOrgMember(r, "Buyer")).toBe(true);
    }
  });
  it("never allows creating a PlatformAdmin", () => {
    expect(canCreateOrgMember("PlatformAdmin", "PlatformAdmin")).toBe(false);
    expect(canCreateOrgMember("OrgAdmin", "PlatformAdmin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tokenlayer/core exec vitest run src/user-policy.test.ts`
Expected: FAIL — `assignableRoles("OrgAdmin")` returns `[]`, `canCreateOrgMember` is not exported, `rbac.can("OrgAdmin", ...)` returns `false` for read.

- [ ] **Step 3: Add `OrgAdmin` to the Role union + ROLES**

In `packages/core/src/types.ts`, replace the `Role` type and `ROLES` (lines 10–12):

```typescript
/** Roles recognised by the platform's access-control policy. */
export type Role = "PlatformAdmin" | "OrgAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

export const ROLES: readonly Role[] = ["PlatformAdmin", "OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];
```

- [ ] **Step 4: Add `OrgAdmin` to the RBAC matrix**

In `packages/core/src/rbac.ts`, add one line to `MATRIX` (after the `UseCaseAdmin` entry):

```typescript
const MATRIX: Record<Role, ReadonlySet<LifecycleAction>> = {
  PlatformAdmin: new Set<LifecycleAction>(FULL),
  OrgAdmin: new Set<LifecycleAction>(["read"]),
  UseCaseAdmin: new Set<LifecycleAction>(FULL),
  Issuer: new Set<LifecycleAction>(["issue", "mint", "allow", "disallow", "freeze", "unfreeze", "read"]),
  Trader: new Set<LifecycleAction>(["transfer", "burn", "buy", "list", "cancel-listing", "read"]),
  Buyer: new Set<LifecycleAction>(["buy", "list", "cancel-listing", "read"]),
  Auditor: new Set<LifecycleAction>(["read"]),
};
```

- [ ] **Step 5: Extend user-policy for OrgAdmin**

In `packages/core/src/user-policy.ts`, replace `canManageUsers` and `assignableRoles` and append `canCreateOrgMember`:

```typescript
/** Org-internal roles an OrgAdmin (or PlatformAdmin) may assign to a member. */
const ORG_INTERNAL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

/** Roles allowed to provision other users. */
export function canManageUsers(role: Role): boolean {
  return role === "PlatformAdmin" || role === "OrgAdmin" || role === "UseCaseAdmin";
}

/** Which roles a given manager may assign to a new user. */
export function assignableRoles(role: Role): Role[] {
  if (role === "PlatformAdmin") return ["UseCaseAdmin"];
  if (role === "OrgAdmin") return [...ORG_INTERNAL_ROLES];
  if (role === "UseCaseAdmin") return ["Issuer", "Buyer", "Auditor"];
  return [];
}

/**
 * May a manager create an ORG member with `targetRole`? Org membership is scoped
 * by organization (not use case), so the org route enforces org-scope separately;
 * this only governs which target roles each manager may mint.
 * - PlatformAdmin: any org-internal role, plus an OrgAdmin.
 * - OrgAdmin: any org-internal role, but never another OrgAdmin or a PlatformAdmin.
 */
export function canCreateOrgMember(managerRole: Role, targetRole: Role): boolean {
  if (targetRole === "PlatformAdmin") return false;
  if (targetRole === "OrgAdmin") return managerRole === "PlatformAdmin";
  if (ORG_INTERNAL_ROLES.includes(targetRole)) return managerRole === "PlatformAdmin" || managerRole === "OrgAdmin";
  return false;
}
```

Leave the existing `canCreateUser` (use-case-scoped) exactly as-is — it still governs the legacy `POST /users` role/use-case matrix.

- [ ] **Step 6: Run the policy tests to verify they pass**

Run: `pnpm --filter @tokenlayer/core exec vitest run src/user-policy.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 7: Add optional `type` to issueCredential**

In `packages/core/src/identity.ts`, replace the `IssueInput` interface and `issueCredential` (lines 83–92):

```typescript
export interface IssueInput { issuerDid: string; issuerKey: KeyObject; subjectDid: string; claims: Record<string, unknown>; expiresAt: number; now: number; type?: string[]; }
/** Mint a VC-JWT (dev/test helper). credentialSubject.id = subjectDid; jti = credential id. Defaults to a KycCredential type. */
export function issueCredential(i: IssueInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${i.issuerDid}#0` },
    { iss: i.issuerDid, sub: i.subjectDid, jti: `urn:uuid:${randomUUID()}`, iat: i.now, nbf: i.now, exp: i.expiresAt,
      vc: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: i.type ?? ["VerifiableCredential", "KycCredential"], credentialSubject: { id: i.subjectDid, ...i.claims } } },
    i.issuerKey,
  );
}
```

- [ ] **Step 8: Round-trip ownerOrgId on the use-case definition**

In `packages/core/src/types.ts`, add one field to `UseCaseDefinition` (immediately after the `key`/`name`/`description` block near line 154):

```typescript
  /** Owning organization id (null/undefined for legacy platform-owned use cases). */
  ownerOrgId?: string;
```

In `packages/core/src/validation.ts`, find `normalizeUseCaseDefinition` and ensure the returned object passes `ownerOrgId` through unchanged. Read the function first; add `ownerOrgId: def.ownerOrgId` to the normalized object it returns (alongside `key`, `name`, etc.). If the function spreads the input (`...def`) then no change is needed — verify by reading it and only edit if fields are explicitly enumerated.

- [ ] **Step 9: Build core and run the full core suite**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/core exec vitest run`
Expected: PASS — core compiles; existing tests plus the new `user-policy.test.ts` are green.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/rbac.ts packages/core/src/user-policy.ts packages/core/src/user-policy.test.ts packages/core/src/identity.ts packages/core/src/validation.ts
git commit -m "feat(core): OrgAdmin role + org-member policy + credential type + ownerOrgId"
```

---

## Task 2: API keystore — encrypted seed custody + membership VC

**Files:**
- Create: `apps/api/src/keystore.ts`
- Modify: `apps/api/src/env.ts`
- Test: `apps/api/test/keystore.test.ts`

- [ ] **Step 1: Write the failing keystore test**

Create `apps/api/test/keystore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
import { createKeystore } from "../src/keystore.js";

const MASTER = "11".repeat(32); // 32 bytes of 0x11, hex

describe("keystore", () => {
  it("round-trips an encrypted seed and yields a stable DID", () => {
    const ks = createKeystore(MASTER);
    const seed = ks.newSeed();
    const enc = ks.encryptSeed(seed);
    expect(ks.decryptSeed(enc).equals(seed)).toBe(true);
    expect(ks.keyOf(enc).did).toBe(ks.keyOf(enc).did); // deterministic
    expect(ks.keyOf(enc).did.startsWith("did:key:z")).toBe(true);
  });

  it("produces distinct ciphertexts for the same seed (random IV)", () => {
    const ks = createKeystore(MASTER);
    const seed = ks.newSeed();
    expect(ks.encryptSeed(seed)).not.toBe(ks.encryptSeed(seed));
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const ks = createKeystore(MASTER);
    const enc = ks.encryptSeed(ks.newSeed());
    const buf = Buffer.from(enc, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => ks.decryptSeed(buf.toString("base64"))).toThrow();
  });

  it("issues a membership VC signed by the org DID and bound to the member", () => {
    const ks = createKeystore(MASTER);
    const orgEnc = ks.encryptSeed(ks.newSeed());
    const org = ks.keyOf(orgEnc);
    const member = ks.keyOf(ks.encryptSeed(ks.newSeed()));
    const now = 1_800_000_000;
    const { vcJwt, expiresAt } = ks.issueMembershipCredential({
      orgEncSeed: orgEnc, orgDid: org.did, userDid: member.did,
      claims: { organization: "Acme Bank", orgId: "org_1", role: "Issuer", memberSince: "2026-07-11" }, now,
    });
    expect(verifyJwtSignature(vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    const { payload } = decodeJwt(vcJwt);
    const vc = payload.vc as { type: string[]; credentialSubject: { id: string; role: string } };
    expect(vc.type).toContain("OrganizationMembership");
    expect(vc.credentialSubject.id).toBe(member.did);
    expect(vc.credentialSubject.role).toBe("Issuer");
    expect(expiresAt).toBe(now + 365 * 24 * 3600);
  });

  it("throws on a master key that is not 32 bytes", () => {
    expect(() => createKeystore("abcd")).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/keystore.test.ts`
Expected: FAIL — `../src/keystore.js` does not exist.

- [ ] **Step 3: Implement the keystore module**

Create `apps/api/src/keystore.ts`:

```typescript
/**
 * Custodial key management. The platform holds each DID's 32-byte Ed25519 seed
 * encrypted at rest (AES-256-GCM under DID_MASTER_KEY) and reconstructs the
 * keypair on demand via `didKeyFromSeed` — no KeyObject is ever serialized.
 * The org's key signs OrganizationMembership VCs on its behalf.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { didKeyFromSeed, issueCredential, type DidKey } from "@tokenlayer/core";

const IV_LEN = 12; // AES-GCM standard nonce length
const TAG_LEN = 16;
const MEMBERSHIP_TTL_SECONDS = 365 * 24 * 3600;

export interface MembershipInput {
  orgEncSeed: string;
  orgDid: string;
  userDid: string;
  /** { organization, orgId, role, memberSince } — merged into credentialSubject. */
  claims: Record<string, unknown>;
  /** Unix seconds. */
  now: number;
}

export interface Keystore {
  newSeed(): Buffer;
  encryptSeed(seed: Buffer): string;
  decryptSeed(enc: string): Buffer;
  keyOf(enc: string): DidKey;
  issueMembershipCredential(input: MembershipInput): { vcJwt: string; expiresAt: number };
}

/** Build a keystore bound to a 32-byte master key (hex, 64 chars). */
export function createKeystore(masterKeyHex: string): Keystore {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("DID master key must be 32 bytes (64 hex chars)");

  const newSeed = (): Buffer => randomBytes(32);

  const encryptSeed = (seed: Buffer): string => {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  };

  const decryptSeed = (enc: string): Buffer => {
    const buf = Buffer.from(enc, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  };

  const keyOf = (enc: string): DidKey => didKeyFromSeed(decryptSeed(enc));

  const issueMembershipCredential = ({ orgEncSeed, orgDid, userDid, claims, now }: MembershipInput): { vcJwt: string; expiresAt: number } => {
    const orgKey = keyOf(orgEncSeed);
    const expiresAt = now + MEMBERSHIP_TTL_SECONDS;
    const vcJwt = issueCredential({
      issuerDid: orgDid, issuerKey: orgKey.privateKey, subjectDid: userDid,
      claims, expiresAt, now, type: ["VerifiableCredential", "OrganizationMembership"],
    });
    return { vcJwt, expiresAt };
  };

  return { newSeed, encryptSeed, decryptSeed, keyOf, issueMembershipCredential };
}
```

- [ ] **Step 4: Run the keystore test to verify it passes**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/keystore.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Wire DID_MASTER_KEY into env**

In `apps/api/src/env.ts`, after the `DEMO_MARKET_ESCROW_ACCOUNT` constant (line 51) add:

```typescript
/**
 * Fixed DEV DID master key used only when DID_MASTER_KEY is unset — enables the
 * custodial keystore out of the box for local/demo runs. NEVER use in production;
 * a real deployment MUST set DID_MASTER_KEY (32 bytes hex, e.g. `openssl rand -hex 32`).
 */
export const DEV_DID_MASTER_KEY = "0".repeat(64);
```

In the `Env` interface, add:

```typescript
  /** 32-byte hex master key encrypting custodial DID seeds (real or dev default). */
  didMasterKey: string;
  /** True iff DID_MASTER_KEY was explicitly set (production must set it). */
  didMasterConfigured: boolean;
```

In the `env` object literal, add:

```typescript
  didMasterKey: process.env.DID_MASTER_KEY ?? DEV_DID_MASTER_KEY,
  didMasterConfigured: !!process.env.DID_MASTER_KEY,
```

At the very end of the file (after the `env` export), add the one-time warning:

```typescript
if (!env.didMasterConfigured) {
  console.warn(
    "[keystore] DID_MASTER_KEY is not set — using an INSECURE dev key to encrypt custodial DID seeds. " +
      "Set DID_MASTER_KEY (openssl rand -hex 32) before any production use.",
  );
}
```

- [ ] **Step 6: Typecheck the API package**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: PASS — no type errors (keystore + env compile).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/keystore.ts apps/api/test/keystore.test.ts apps/api/src/env.ts
git commit -m "feat(api): custodial keystore (AES-256-GCM seed) + membership VC + DID_MASTER_KEY"
```

---

## Task 3: Persistence schema + types — Organization, Credential, widened User/UseCase

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/types.ts`

- [ ] **Step 1: Add Prisma models + columns**

In `apps/api/prisma/schema.prisma`, extend the `User` model (add two fields before `createdAt`):

```prisma
  orgId            String?  // owning organization id (null for legacy/platform users)
  didSeedEncrypted String?  // AES-256-GCM encrypted Ed25519 seed for this user's sub-DID
```

Extend the `UseCase` model (add before `createdAt`):

```prisma
  ownerOrgId      String?  // owning organization id (null = legacy platform-owned)
```

Add two new models at the end of the file:

```prisma
// A tenant organization. Its parent did:key is custodial: didSeedEncrypted holds
// the AES-256-GCM encrypted Ed25519 seed the platform signs membership VCs with.
model Organization {
  id               String   @id @default(cuid())
  name             String   @unique
  orgType          String // bank | corporate | msme | government | verifier
  registrationId   String?
  jurisdiction     String?
  did              String   @unique
  didSeedEncrypted String
  status           String   @default("active") // active | suspended
  verified         Boolean  @default(false)
  verifiedAt       DateTime?
  createdAt        DateTime @default(now())

  @@index([status])
}

// A stored Verifiable Credential (VC-JWT) held by a subject DID. subjectClaims is
// the decoded credentialSubject (JSON) for quick display without re-decoding.
model Credential {
  id            String   @id @default(cuid())
  holderDid     String
  issuerDid     String
  type          String // e.g. "OrganizationMembership"
  vcJwt         String
  subjectClaims String // JSON-encoded credentialSubject
  issuedAt      DateTime @default(now())
  expiresAt     DateTime?
  revoked       Boolean  @default(false)

  @@index([holderDid])
}
```

- [ ] **Step 2: Push the schema to the dev database + regenerate the client**

Run: `pnpm --filter @tokenlayer/api exec prisma db push`
Expected: succeeds; prints "Your database is now in sync with your Prisma schema" and regenerates the client (so `prisma.organization` / `prisma.credential` and the new `User`/`UseCase` fields exist).

- [ ] **Step 3: Add record types + repo interfaces + widen UserRepository**

In `apps/api/src/persistence/types.ts`:

Add `orgId` and `didSeedEncrypted` to `UserRecord` (after `did?`):

```typescript
  orgId?: string | null;
  didSeedEncrypted?: string | null;
```

Widen `UserRepository`: add `listByOrg` and include `orgId`/`didSeedEncrypted` in the `create` input (already covered by `Omit<UserRecord, "id" | "createdAt">`) and in the `update` patch pick:

```typescript
export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: Omit<UserRecord, "id" | "createdAt">): Promise<UserRecord>;
  list(useCaseKey?: string): Promise<UserRecord[]>;
  listByOrg(orgId: string): Promise<UserRecord[]>;
  update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord>;
  remove(id: string): Promise<void>;
}
```

Append the new records + repo interfaces at the end of the file:

```typescript
export type OrgType = "bank" | "corporate" | "msme" | "government" | "verifier";
export type OrgStatus = "active" | "suspended";

export interface OrganizationRecord {
  id: string;
  name: string;
  orgType: OrgType;
  registrationId: string | null;
  jurisdiction: string | null;
  did: string;
  didSeedEncrypted: string;
  status: OrgStatus;
  verified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export interface OrganizationRepository {
  create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord>;
  get(id: string): Promise<OrganizationRecord | null>;
  findByName(name: string): Promise<OrganizationRecord | null>;
  findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null>;
  list(): Promise<OrganizationRecord[]>;
  setVerified(id: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord>;
  setStatus(id: string, status: OrgStatus): Promise<OrganizationRecord>;
}

export interface CredentialRecord {
  id: string;
  holderDid: string;
  issuerDid: string;
  type: string;
  vcJwt: string;
  subjectClaims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
}

export interface CredentialRepository {
  create(input: Omit<CredentialRecord, "id">): Promise<CredentialRecord>;
  listByHolder(holderDid: string): Promise<CredentialRecord[]>;
  get(id: string): Promise<CredentialRecord | null>;
  setRevoked(id: string, revoked: boolean): Promise<CredentialRecord>;
}
```

- [ ] **Step 4: Commit (schema + types compile as a unit with Task 4/5 repos; no standalone test yet)**

Note: `tsc` will now flag the memory/prisma repos as not implementing the widened `UserRepository` (missing `listByOrg`). That is expected and fixed in Tasks 4–5. Do NOT run a package typecheck here; commit the schema + interface changes:

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts
git commit -m "feat(api): Organization + Credential schema/types; User.orgId + listByOrg"
```

---

## Task 4: Memory repos — Organization, Credential, widened user repo

**Files:**
- Modify: `apps/api/src/persistence/memory.ts`
- Test: `apps/api/test/organizations-repo.test.ts` (create)

- [ ] **Step 1: Write a failing memory-repo test**

Create `apps/api/test/organizations-repo.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository, MemoryOrganizationRepository, MemoryUserRepository } from "../src/persistence/memory.js";

describe("MemoryOrganizationRepository", () => {
  it("creates, finds, lists, and updates status/verified", async () => {
    const repo = new MemoryOrganizationRepository();
    const org = await repo.create({
      name: "Acme Bank", orgType: "bank", registrationId: "REG-1", jurisdiction: "IN",
      did: "did:key:zOrg", didSeedEncrypted: "enc", status: "active", verified: true, verifiedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(org.id).toBeTruthy();
    expect((await repo.get(org.id))?.name).toBe("Acme Bank");
    expect((await repo.findByName("Acme Bank"))?.id).toBe(org.id);
    expect((await repo.findByRegistrationId("REG-1"))?.id).toBe(org.id);
    expect(await repo.list()).toHaveLength(1);
    expect((await repo.setStatus(org.id, "suspended")).status).toBe("suspended");
    expect((await repo.setVerified(org.id, false, null)).verified).toBe(false);
  });
});

describe("MemoryCredentialRepository", () => {
  it("stores and lists credentials by holder", async () => {
    const repo = new MemoryCredentialRepository();
    const c = await repo.create({
      holderDid: "did:key:zH", issuerDid: "did:key:zI", type: "OrganizationMembership",
      vcJwt: "a.b.c", subjectClaims: { role: "Issuer" }, issuedAt: "2026-07-11T00:00:00.000Z", expiresAt: null, revoked: false,
    });
    expect(await repo.listByHolder("did:key:zH")).toHaveLength(1);
    expect(await repo.listByHolder("did:key:zX")).toHaveLength(0);
    expect((await repo.setRevoked(c.id, true)).revoked).toBe(true);
  });
});

describe("MemoryUserRepository org fields", () => {
  it("persists orgId and lists by org", async () => {
    const repo = new MemoryUserRepository();
    const u = await repo.create({
      email: "a@x.io", passwordHash: "h", role: "Issuer", useCaseKey: null, accountId: null,
      active: true, kycStatus: "approved", kyc: null, orgId: "org_1", didSeedEncrypted: "enc", did: "did:key:zU",
    });
    expect(u.orgId).toBe("org_1");
    expect(await repo.listByOrg("org_1")).toHaveLength(1);
    expect(await repo.listByOrg("org_2")).toHaveLength(0);
    expect((await repo.update(u.id, { orgId: "org_2" })).orgId).toBe("org_2");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations-repo.test.ts`
Expected: FAIL — `MemoryOrganizationRepository` / `MemoryCredentialRepository` / `listByOrg` not exported.

- [ ] **Step 3: Widen MemoryUserRepository + add the two repos**

In `apps/api/src/persistence/memory.ts`:

Add `listByOrg` to `MemoryUserRepository` (after `list`) and widen the `update` patch type to match the interface:

```typescript
  async listByOrg(orgId: string): Promise<UserRecord[]> {
    return [...this.byId.values()].filter((u) => u.orgId === orgId);
  }
  async update(userId: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord> {
    const rec = this.byId.get(userId);
    if (!rec) throw new Error(`unknown user '${userId}'`);
    Object.assign(rec, patch);
    return rec;
  }
```

Add the imports `CredentialRecord, CredentialRepository, OrganizationRecord, OrganizationRepository, OrgStatus` to the existing type import block at the top of the file.

Append the two repos at the end of the file:

```typescript
export class MemoryOrganizationRepository implements OrganizationRepository {
  private readonly byId = new Map<string, OrganizationRecord>();
  async create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord> {
    const rec: OrganizationRecord = { ...input, id: id("org"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(orgId: string): Promise<OrganizationRecord | null> {
    return this.byId.get(orgId) ?? null;
  }
  async findByName(name: string): Promise<OrganizationRecord | null> {
    return [...this.byId.values()].find((o) => o.name === name) ?? null;
  }
  async findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null> {
    return [...this.byId.values()].find((o) => o.registrationId === registrationId) ?? null;
  }
  async list(): Promise<OrganizationRecord[]> {
    return [...this.byId.values()];
  }
  async setVerified(orgId: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    rec.verified = verified;
    rec.verifiedAt = verifiedAt;
    return rec;
  }
  async setStatus(orgId: string, status: OrgStatus): Promise<OrganizationRecord> {
    const rec = this.byId.get(orgId);
    if (!rec) throw new Error(`unknown org '${orgId}'`);
    rec.status = status;
    return rec;
  }
}

export class MemoryCredentialRepository implements CredentialRepository {
  private readonly byId = new Map<string, CredentialRecord>();
  async create(input: Omit<CredentialRecord, "id">): Promise<CredentialRecord> {
    const rec: CredentialRecord = { ...input, id: id("cred") };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async listByHolder(holderDid: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.holderDid === holderDid);
  }
  async get(credId: string): Promise<CredentialRecord | null> {
    return this.byId.get(credId) ?? null;
  }
  async setRevoked(credId: string, revoked: boolean): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.revoked = revoked;
    return rec;
  }
}
```

- [ ] **Step 4: Run the memory-repo test to verify it passes**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/persistence/memory.ts apps/api/test/organizations-repo.test.ts
git commit -m "feat(api): memory Organization + Credential repos; user org fields"
```

---

## Task 5: Prisma repos — Organization, Credential, widened user + use-case ownerOrgId

**Files:**
- Modify: `apps/api/src/persistence/prisma.ts`

- [ ] **Step 1: Widen the Prisma user repo**

In `apps/api/src/persistence/prisma.ts`:

Update the `toUser` mapper input type and body to include the new columns (add `orgId: string | null;` and `didSeedEncrypted: string | null;` to the parameter type, and `orgId: r.orgId ?? null,` + `didSeedEncrypted: r.didSeedEncrypted ?? null,` to the returned object).

Add `listByOrg` to `PrismaUserRepository` (after `list`) and widen `update`'s patch type:

```typescript
  async listByOrg(orgId: string): Promise<UserRecord[]> {
    return (await prisma.user.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } })).map(toUser);
  }
  async update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc" | "orgId" | "didSeedEncrypted">>): Promise<UserRecord> {
    const { kyc, ...rest } = patch;
    return toUser(await prisma.user.update({ where: { id }, data: { ...rest, ...(kyc !== undefined ? { kyc: kyc ? JSON.stringify(kyc) : null } : {}) } }));
  }
```

Note: `create` already spreads `input`, so `orgId`/`didSeedEncrypted` flow through unchanged.

- [ ] **Step 2: Round-trip ownerOrgId on the prisma use-case repo**

Read `rowToUseCase` (near line 337) and `useCaseToData` (near line 368). In `rowToUseCase`, add `ownerOrgId: r.ownerOrgId ?? undefined,` to the returned definition. In `useCaseToData`, add `ownerOrgId: def.ownerOrgId ?? null,` to the persisted data object. (Match the surrounding field style exactly.)

- [ ] **Step 3: Add the Prisma Organization + Credential repos**

Add imports `CredentialRecord, CredentialRepository, OrganizationRecord, OrganizationRepository, OrgStatus, OrgType` to the type import block.

Append at the end of `apps/api/src/persistence/prisma.ts`:

```typescript
const toOrg = (r: {
  id: string; name: string; orgType: string; registrationId: string | null; jurisdiction: string | null;
  did: string; didSeedEncrypted: string; status: string; verified: boolean; verifiedAt: Date | null; createdAt: Date;
}): OrganizationRecord => ({
  id: r.id, name: r.name, orgType: r.orgType as OrgType, registrationId: r.registrationId, jurisdiction: r.jurisdiction,
  did: r.did, didSeedEncrypted: r.didSeedEncrypted, status: r.status as OrgStatus, verified: r.verified,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
});

export class PrismaOrganizationRepository implements OrganizationRepository {
  async create(input: Omit<OrganizationRecord, "id" | "createdAt">): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.create({ data: { ...input, verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null } }));
  }
  async get(id: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findUnique({ where: { id } });
    return r ? toOrg(r) : null;
  }
  async findByName(name: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findUnique({ where: { name } });
    return r ? toOrg(r) : null;
  }
  async findByRegistrationId(registrationId: string): Promise<OrganizationRecord | null> {
    const r = await prisma.organization.findFirst({ where: { registrationId } });
    return r ? toOrg(r) : null;
  }
  async list(): Promise<OrganizationRecord[]> {
    return (await prisma.organization.findMany({ orderBy: { createdAt: "asc" } })).map(toOrg);
  }
  async setVerified(id: string, verified: boolean, verifiedAt: string | null): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.update({ where: { id }, data: { verified, verifiedAt: verifiedAt ? new Date(verifiedAt) : null } }));
  }
  async setStatus(id: string, status: OrgStatus): Promise<OrganizationRecord> {
    return toOrg(await prisma.organization.update({ where: { id }, data: { status } }));
  }
}

const toCredential = (r: {
  id: string; holderDid: string; issuerDid: string; type: string; vcJwt: string;
  subjectClaims: string; issuedAt: Date; expiresAt: Date | null; revoked: boolean;
}): CredentialRecord => ({
  id: r.id, holderDid: r.holderDid, issuerDid: r.issuerDid, type: r.type, vcJwt: r.vcJwt,
  subjectClaims: JSON.parse(r.subjectClaims) as Record<string, unknown>,
  issuedAt: r.issuedAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, revoked: r.revoked,
});

export class PrismaCredentialRepository implements CredentialRepository {
  async create(input: Omit<CredentialRecord, "id">): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.create({
      data: {
        holderDid: input.holderDid, issuerDid: input.issuerDid, type: input.type, vcJwt: input.vcJwt,
        subjectClaims: JSON.stringify(input.subjectClaims),
        issuedAt: new Date(input.issuedAt), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, revoked: input.revoked,
      },
    }));
  }
  async listByHolder(holderDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { holderDid }, orderBy: { issuedAt: "asc" } })).map(toCredential);
  }
  async get(id: string): Promise<CredentialRecord | null> {
    const r = await prisma.credential.findUnique({ where: { id } });
    return r ? toCredential(r) : null;
  }
  async setRevoked(id: string, revoked: boolean): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({ where: { id }, data: { revoked } }));
  }
}
```

- [ ] **Step 4: Typecheck the API package**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: PASS — all repos implement their interfaces (memory + prisma). No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/persistence/prisma.ts
git commit -m "feat(api): prisma Organization + Credential repos; user org fields; use-case ownerOrgId"
```

---

## Task 6: Wire deps — AppDeps, construction sites, JWT claims

**Files:**
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/helpers.ts`
- Modify: `apps/api/src/http/support.ts`
- Modify: `apps/api/src/http/routes.ts` (login claims only in this task)

- [ ] **Step 1: Add the new deps to AppDeps**

In `apps/api/src/context.ts`, add to the type imports from `./persistence/types.js`: `CredentialRepository`, `OrganizationRepository`. Import the `Keystore` type: `import type { Keystore } from "./keystore.js";`. Add to the `AppDeps` interface:

```typescript
  organizations: OrganizationRepository;
  credentials: CredentialRepository;
  keystore: Keystore;
  /** True iff DID_MASTER_KEY was explicitly configured (production must set it). */
  didMasterConfigured: boolean;
```

- [ ] **Step 2: Construct + inject in server.ts**

In `apps/api/src/server.ts`:

Add imports:

```typescript
import { createKeystore } from "./keystore.js";
```

and add `PrismaCredentialRepository, PrismaOrganizationRepository` to the persistence import block.

After the other repo constructions (near line 39), add:

```typescript
  const organizations = new PrismaOrganizationRepository();
  const credentials = new PrismaCredentialRepository();
  const keystore = createKeystore(env.didMasterKey);
```

In the `buildApp({ ... })` call, add these to the deps object:

```typescript
    organizations,
    credentials,
    keystore,
    didMasterConfigured: env.didMasterConfigured,
```

- [ ] **Step 3: Construct + inject in the test helper**

In `apps/api/test/helpers.ts`:

Add `createKeystore` import: `import { createKeystore } from "../src/keystore.js";`
Add `MemoryCredentialRepository, MemoryOrganizationRepository` to the memory import block.

After the other memory repos (near line 40) add:

```typescript
  const organizations = new MemoryOrganizationRepository();
  const credentials = new MemoryCredentialRepository();
  const keystore = createKeystore("11".repeat(32));
```

In the `buildApp({ ... })` call add:

```typescript
    organizations, credentials, keystore, didMasterConfigured: opts.didMasterConfigured ?? true,
```

Extend the `buildTestApp` opts type with `didMasterConfigured?: boolean;` so a test can simulate an unconfigured production keystore.

- [ ] **Step 4: Add orgId + did to TokenClaims and refresh them**

In `apps/api/src/http/support.ts`:

Extend `TokenClaims`:

```typescript
export interface TokenClaims {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  orgId?: string | null;
  did?: string | null;
}
```

In `requireUser`, replace the final claim reconstruction line so it carries the fresh `orgId`/`did`:

```typescript
    request.user = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null } satisfies TokenClaims;
```

- [ ] **Step 5: Put orgId + did into the login token**

In `apps/api/src/http/routes.ts`, in `POST /auth/login` (line 123), replace the `claims` construction:

```typescript
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null };
```

- [ ] **Step 6: Typecheck + run the existing suite (no behavior change yet)**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: PASS — everything compiles and all existing tests stay green (new deps are wired but unused so far).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/http/support.ts apps/api/src/http/routes.ts
git commit -m "feat(api): wire keystore + org/credential repos into AppDeps; orgId/did in JWT claims"
```

---

## Task 7: Org routes — create org, list, get + schemas + scope guard

**Files:**
- Modify: `apps/api/src/http/schemas.ts`
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/organizations.test.ts` (create; grown across Tasks 7–9)

- [ ] **Step 1: Write failing tests for org create/list/get**

Create `apps/api/test/organizations.test.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicKeyFromDidKey } from "@tokenlayer/core";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
let admin: string;
beforeAll(async () => {
  app = await buildTestApp();
  admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
});
afterAll(async () => { await app.close(); });

async function createOrg(token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(token), payload: body });
}

describe("POST /orgs", () => {
  it("mints a resolvable parent DID (PlatformAdmin)", async () => {
    const res = await createOrg(admin, { name: "Acme Bank", orgType: "bank", registrationId: "REG-ACME", jurisdiction: "IN" });
    expect(res.statusCode).toBe(201);
    const org = res.json();
    expect(org.did.startsWith("did:key:z")).toBe(true);
    expect(org.verified).toBe(true);
    expect(() => publicKeyFromDidKey(org.did)).not.toThrow();
  });

  it("rejects a non-PlatformAdmin", async () => {
    const uca = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await createOrg(uca, { name: "Nope Inc", orgType: "corporate" });
    expect(res.statusCode).toBe(403);
  });

  it("409s a duplicate name", async () => {
    await createOrg(admin, { name: "Dup Org", orgType: "corporate" });
    const res = await createOrg(admin, { name: "Dup Org", orgType: "corporate" });
    expect(res.statusCode).toBe(409);
  });

  it("503s when the keystore is unconfigured in production", async () => {
    const prod = await buildTestApp({ isProduction: true, didMasterConfigured: false });
    const t = await loginAs(prod, "admin@tokenlayer.dev", "admin123");
    const res = await prod.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(t), payload: { name: "P", orgType: "bank" } });
    expect(res.statusCode).toBe(503);
    await prod.close();
  });
});

describe("GET /orgs, GET /orgs/:id", () => {
  it("PlatformAdmin lists all and reads one", async () => {
    const created = (await createOrg(admin, { name: "ReadMe Org", orgType: "msme" })).json();
    const list = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((o: { id: string }) => o.id === created.id)).toBe(true);
    const one = await app.inject({ method: "GET", url: `${V1}/orgs/${created.id}`, headers: auth(admin) });
    expect(one.statusCode).toBe(200);
    expect(one.json().name).toBe("ReadMe Org");
  });
});
```

Seed logins: confirm the seeded UseCaseAdmin email/password by reading `apps/api/src/seed.ts` (`DEFAULT_USERS`). If `carbon.admin@tokenlayer.dev` / `carbon123` differ, use the actual seeded UseCaseAdmin credentials in the "non-PlatformAdmin" test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: FAIL — `/orgs` routes return 404 (not registered).

- [ ] **Step 3: Add org schemas**

In `apps/api/src/http/schemas.ts`, add these entries to the `S` object (near the Users section):

```typescript
  createOrg: {
    tags: ["Organizations"], summary: "Create an organization + parent DID (PlatformAdmin)", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["name", "orgType"],
      properties: {
        name: { type: "string", minLength: 1 },
        orgType: { type: "string", enum: ["bank", "corporate", "msme", "government", "verifier"] },
        registrationId: { type: "string" },
        jurisdiction: { type: "string" },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 409, 503) },
  },
  listOrgs: { tags: ["Organizations"], summary: "List organizations in scope", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403) } },
  getOrg: {
    tags: ["Organizations"], summary: "Get an organization by id", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404) },
  },
  createMember: {
    tags: ["Organizations"], summary: "Add a member (sub-DID + membership VC)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["email", "password", "role"],
      properties: {
        email: { type: "string" },
        password: { type: "string", minLength: 6 },
        role: { type: "string", enum: ["OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"] },
        useCaseKey: { type: "string" },
        walletAddress: { type: "string" },
        kyc: { type: "object", additionalProperties: false, properties: { legalName: { type: "string" }, country: { type: "string" }, idType: { type: "string" }, idNumber: { type: "string" }, documentRef: { type: "string" } } },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  listMembers: {
    tags: ["Organizations"], summary: "List an organization's members", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },
  myCredentials: { tags: ["Identity"], summary: "Credentials held by the caller", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  didDocument: {
    tags: ["Identity"], summary: "Resolve a did:key into a W3C DID document", security: bearer,
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401) },
  },
```

Confirm the `errs(...)` helper supports 409 and 503 (read its definition near the top of `schemas.ts`); if it maps only a fixed set of codes, extend it to include `409` and `503` with standard messages.

- [ ] **Step 4: Add the org scope guard + create/list/get routes**

In `apps/api/src/http/routes.ts`, add `canCreateOrgMember` to the `@tokenlayer/core` import on line 6, and add a helper + the routes. Place a new section after the users section (after line ~1153, before the identity section). First, near the top of `registerRoutes` (after the `proposeIfGated` helper, ~line 108) add the scope guard:

```typescript
  // Org scope: PlatformAdmin acts on any org; an OrgAdmin only on their own.
  function orgScoped(claims: TokenClaims, orgId: string): boolean {
    return claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && claims.orgId === orgId);
  }
```

Then add the routes (new "// --- organizations ---" section):

```typescript
  // --- organizations -------------------------------------------------------
  app.post("/orgs", { schema: S.createOrg, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    if (claims.role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "only the Platform Admin may create organizations" });
    if (!deps.didMasterConfigured && deps.isProduction) return reply.code(503).send({ error: "DID_KEYSTORE_UNCONFIGURED", message: "DID_MASTER_KEY must be set to create organizations" });
    const b = request.body as { name: string; orgType: "bank" | "corporate" | "msme" | "government" | "verifier"; registrationId?: string; jurisdiction?: string };
    if (await deps.organizations.findByName(b.name)) return reply.code(409).send({ error: "NAME_TAKEN", message: "an organization with that name already exists" });
    if (b.registrationId && (await deps.organizations.findByRegistrationId(b.registrationId))) return reply.code(409).send({ error: "REGISTRATION_TAKEN", message: "an organization with that registration id already exists" });
    const seed = deps.keystore.newSeed();
    const didSeedEncrypted = deps.keystore.encryptSeed(seed);
    const did = deps.keystore.keyOf(didSeedEncrypted).did;
    const org = await deps.organizations.create({
      name: b.name, orgType: b.orgType, registrationId: b.registrationId ?? null, jurisdiction: b.jurisdiction ?? null,
      did, didSeedEncrypted, status: "active", verified: true, verifiedAt: new Date().toISOString(),
    });
    await deps.audit.append({ actorId: claims.id, action: "org-created" as LifecycleAction, payload: { orgId: org.id, name: org.name, did: org.did } });
    return reply.code(201).send({ id: org.id, name: org.name, did: org.did, orgType: org.orgType, registrationId: org.registrationId, jurisdiction: org.jurisdiction, verified: org.verified, status: org.status });
  });

  app.get("/orgs", { schema: S.listOrgs, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    let rows;
    if (claims.role === "PlatformAdmin") rows = await deps.organizations.list();
    else if (claims.role === "OrgAdmin" && claims.orgId) { const o = await deps.organizations.get(claims.orgId); rows = o ? [o] : []; }
    else return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to list organizations" });
    return rows.map(orgView);
  });

  app.get("/orgs/:id", { schema: S.getOrg, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return orgView(org);
  });
```

Add a small view helper near the top of the file (module scope, before `registerRoutes`), so the org's encrypted seed is never serialized:

```typescript
import type { OrganizationRecord } from "../persistence/types.js";
// Public projection of an org — NEVER includes didSeedEncrypted.
function orgView(o: OrganizationRecord) {
  return { id: o.id, name: o.name, orgType: o.orgType, registrationId: o.registrationId, jurisdiction: o.jurisdiction, did: o.did, verified: o.verified, status: o.status, createdAt: o.createdAt };
}
```

Note: `"org-created"` is not a `LifecycleAction`; the `as LifecycleAction` cast at the append boundary matches the existing `"kyc-verified"` precedent (asset-less audit rows the folds ignore).

- [ ] **Step 5: Run the org tests to verify they pass**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: PASS for the create/list/get + 403 + 409 + 503 cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/api/src/http/routes.ts apps/api/test/organizations.test.ts
git commit -m "feat(api): POST/GET /orgs with parent DID + org scope guard"
```

---

## Task 8: Member routes — add member (sub-DID + membership VC), list members

**Files:**
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/organizations.test.ts` (extend)

- [ ] **Step 1: Extend the test with member creation + membership VC**

Append to `apps/api/test/organizations.test.ts`:

```typescript
import { verifyJwtSignature, decodeJwt } from "@tokenlayer/core";

describe("POST /orgs/:id/users (members)", () => {
  it("mints a sub-DID + a membership VC that verifies against the org DID", async () => {
    const org = (await createOrg(admin, { name: "Member Org", orgType: "bank" })).json();
    const res = await app.inject({
      method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin),
      payload: { email: `issuer.${org.id}@x.io`, password: "secret1", role: "Issuer" },
    });
    expect(res.statusCode).toBe(201);
    const member = res.json();
    expect(member.did.startsWith("did:key:z")).toBe(true);
    expect(member.membershipVc).toBe(true);

    // The membership VC is retrievable and verifies against the org's DID.
    const memberToken = await loginAs(app, `issuer.${org.id}@x.io`, "secret1");
    const creds = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(memberToken) });
    expect(creds.statusCode).toBe(200);
    const list = creds.json();
    expect(list).toHaveLength(1);
    expect(list[0].type).toContain("OrganizationMembership");
    expect(verifyJwtSignature(list[0].vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    expect((decodeJwt(list[0].vcJwt).payload.vc as { credentialSubject: { id: string } }).credentialSubject.id).toBe(member.did);
  });

  it("an OrgAdmin cannot mint a PlatformAdmin and cannot act on another org", async () => {
    const orgA = (await createOrg(admin, { name: "Org A", orgType: "corporate" })).json();
    const orgB = (await createOrg(admin, { name: "Org B", orgType: "corporate" })).json();
    const adminRes = await app.inject({
      method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `orgadmin.${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" },
    });
    expect(adminRes.statusCode).toBe(201);
    const orgAdmin = await loginAs(app, `orgadmin.${orgA.id}@x.io`, "secret1");

    // Cannot create in org B (cross-org).
    const cross = await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(orgAdmin), payload: { email: "x@x.io", password: "secret1", role: "Issuer" } });
    expect(cross.statusCode).toBe(403);
    // Cannot mint a PlatformAdmin in its own org.
    const esc = await app.inject({ method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(orgAdmin), payload: { email: "pa@x.io", password: "secret1", role: "PlatformAdmin" } });
    expect(esc.statusCode).toBe(403);
    // Cannot list org B's members.
    const listB = await app.inject({ method: "GET", url: `${V1}/orgs/${orgB.id}/members`, headers: auth(orgAdmin) });
    expect(listB.statusCode).toBe(403);
  });

  it("lists an org's members", async () => {
    const org = (await createOrg(admin, { name: "Roster Org", orgType: "government" })).json();
    await app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin), payload: { email: `a.${org.id}@x.io`, password: "secret1", role: "Auditor" } });
    const members = await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/members`, headers: auth(admin) });
    expect(members.statusCode).toBe(200);
    expect(members.json().length).toBeGreaterThanOrEqual(1);
    expect(members.json()[0]).toHaveProperty("did");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: FAIL — `POST /orgs/:id/users`, `GET /orgs/:id/members`, `GET /me/credentials` not registered (404).

- [ ] **Step 3: Add a shared membership-minting helper + the member routes**

In `apps/api/src/http/routes.ts`, add a helper inside `registerRoutes` (in the organizations section) that mints a sub-DID + membership VC for an already-created user, then add the two routes. The helper is reused by the org-aware `POST /users` in Task 9.

```typescript
  // Mint a sub-DID + OrganizationMembership VC for `user` under `org`, persisting
  // the encrypted seed on the user and the VC in the credential store. Returns the
  // minted DID. Throws on any failure so the caller can roll back the user row.
  async function mintMembership(org: OrganizationRecord, user: UserRecord, role: Role): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const seed = deps.keystore.newSeed();
    const didSeedEncrypted = deps.keystore.encryptSeed(seed);
    const did = deps.keystore.keyOf(didSeedEncrypted).did;
    const memberSince = new Date(now * 1000).toISOString().slice(0, 10);
    const { vcJwt, expiresAt } = deps.keystore.issueMembershipCredential({
      orgEncSeed: org.didSeedEncrypted, orgDid: org.did, userDid: did,
      claims: { organization: org.name, orgId: org.id, role, memberSince }, now,
    });
    await deps.users.update(user.id, { did, didSeedEncrypted, orgId: org.id });
    await deps.credentials.create({
      holderDid: did, issuerDid: org.did, type: "OrganizationMembership", vcJwt,
      subjectClaims: { id: did, organization: org.name, orgId: org.id, role, memberSince },
      issuedAt: new Date(now * 1000).toISOString(), expiresAt: new Date(expiresAt * 1000).toISOString(), revoked: false,
    });
    return did;
  }

  app.post("/orgs/:id/users", { schema: S.createMember, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const b = request.body as { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to add members to that organization" });
    if (!canCreateOrgMember(claims.role, b.role)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to create that member role" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    if (await deps.users.findByEmail(b.email)) return reply.code(400).send({ error: "EMAIL_TAKEN", message: "email already registered" });
    let accountId: string | null = null;
    if (b.walletAddress) accountId = (await deps.accounts.upsert(b.walletAddress, b.email)).id;
    const created = await deps.users.create({
      email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS), role: b.role,
      useCaseKey: b.useCaseKey ?? null, accountId, active: true, kycStatus: "pending", kyc: b.kyc ?? null, orgId: id,
    });
    let did: string;
    try {
      did = await mintMembership(org, created, b.role);
    } catch (err) {
      await deps.users.remove(created.id); // no orphan user without a DID/VC
      throw err;
    }
    await deps.audit.append({ actorId: claims.id, action: "member-added" as LifecycleAction, payload: { orgId: id, userId: created.id, did, role: b.role } });
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, orgId: id, did, membershipVc: true });
  });

  app.get("/orgs/:id/members", { schema: S.listMembers, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's members" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    const members = await deps.users.listByOrg(id);
    return members.map((u) => ({ id: u.id, email: u.email, role: u.role, useCaseKey: u.useCaseKey, did: u.did ?? null, active: u.active, kycStatus: u.kycStatus }));
  });
```

Ensure `UserRecord` and `Role` and `KycDetails` are imported in routes.ts (they already are via existing imports — verify `UserRecord` is imported from `../persistence/types.js` and add it if missing).

- [ ] **Step 4: Run the member tests to verify they pass**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: PASS — member creation mints a DID + membership VC verified against the org DID; OrgAdmin cross-org + PlatformAdmin-escalation are 403; members list works.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/test/organizations.test.ts
git commit -m "feat(api): add-member route mints sub-DID + membership VC; members list"
```

---

## Task 9: Credential + DID routes, org-aware POST /users, use-case org filter

**Files:**
- Modify: `apps/api/src/http/routes.ts`
- Test: `apps/api/test/organizations.test.ts` (extend)

- [ ] **Step 1: Extend the test with /me/credentials, /dids/:did/document, org-scoped use-cases**

Append to `apps/api/test/organizations.test.ts`:

```typescript
describe("GET /dids/:did/document", () => {
  it("resolves a did:key into a W3C DID document", async () => {
    const org = (await createOrg(admin, { name: "DIDDoc Org", orgType: "verifier" })).json();
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${encodeURIComponent(org.did)}/document`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.id).toBe(org.did);
    expect(doc.verificationMethod[0].type).toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe(org.did.slice("did:key:".length));
    expect(doc.authentication[0]).toBe(`${org.did}#0`);
  });

  it("400s a non-did:key", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${encodeURIComponent("did:web:example.com")}/document`, headers: auth(admin) });
    expect(res.statusCode).toBe(400);
  });
});

describe("back-compat", () => {
  it("a user created with no org gets no DID (legacy POST /users still works)", async () => {
    const uca = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(uca), payload: { email: `legacy.${Date.now()}@x.io`, password: "secret1", role: "Issuer" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().did ?? null).toBeNull();
  });
});
```

(Use the real seeded UseCaseAdmin credentials, matching Task 7.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: FAIL — `/me/credentials` (added in Task 8 tests but not yet implemented → currently 404) and `/dids/:did/document` not registered.

- [ ] **Step 3: Add /me/credentials + /dids/:did/document + org-aware POST /users**

In `apps/api/src/http/routes.ts`, add `publicKeyFromDidKey` to the `@tokenlayer/core` import. Add the identity read routes in the organizations/identity section:

```typescript
  app.get("/me/credentials", { schema: S.myCredentials, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    const rows = await deps.credentials.listByHolder(claims.did);
    return rows.map((c) => ({ id: c.id, type: c.type.split(","), issuerDid: c.issuerDid, holderDid: c.holderDid, claims: c.subjectClaims, issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked, vcJwt: c.vcJwt }));
  });

  app.get("/dids/:did/document", { schema: S.didDocument, ...auth }, async (request, reply) => {
    const { did } = request.params as { did: string };
    try {
      publicKeyFromDidKey(did); // validates it's a resolvable did:key ed25519
    } catch {
      return reply.code(400).send({ error: "UNSUPPORTED_DID", message: "only did:key ed25519 can be resolved" });
    }
    const vm = `${did}#0`;
    return {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      verificationMethod: [{ id: vm, type: "Ed25519VerificationKey2020", controller: did, publicKeyMultibase: did.slice("did:key:".length) }],
      authentication: [vm],
      assertionMethod: [vm],
    };
  });
```

Note: `type` is stored as a comma-joinable string; the membership VC stores `"OrganizationMembership"` (single type). For the `/me/credentials` view, split on `","` so multi-type strings surface as an array; `["OrganizationMembership"]` satisfies `toContain("OrganizationMembership")` in the Task 8 test.

For the org-aware `POST /users`: in the existing `POST /users` handler (line 1105), after the user is created (`const created = await deps.users.create({...})`, line 1115–1124) and before the `return reply.code(201)...`, insert:

```typescript
    // If the creator belongs to an org, the new user joins it with a sub-DID +
    // membership VC (mirrors POST /orgs/:id/users). No org ⇒ behaves as before.
    let mintedDid: string | null = null;
    if (claims.orgId) {
      const org = await deps.organizations.get(claims.orgId);
      if (org) {
        try {
          mintedDid = await mintMembership(org, created, b.role);
        } catch (err) {
          await deps.users.remove(created.id);
          throw err;
        }
      }
    }
```

and change the response to include the DID:

```typescript
    return reply.code(201).send({ id: created.id, email: created.email, role: created.role, useCaseKey: created.useCaseKey, accountId: created.accountId, kycStatus: created.kycStatus, orgId: claims.orgId ?? null, did: mintedDid });
```

- [ ] **Step 4: Filter GET /use-cases for OrgAdmin**

In `apps/api/src/http/routes.ts`, replace the `GET /use-cases` handler body (lines 145–149) so an OrgAdmin sees only their org's use cases:

```typescript
  app.get("/use-cases", { schema: S.listUseCases, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const all = await deps.useCases.list();
    if (claims.role === "PlatformAdmin") return all;
    if (claims.role === "OrgAdmin") return all.filter((u) => u.ownerOrgId != null && u.ownerOrgId === claims.orgId);
    return all.filter((u) => u.key === claims.useCaseKey);
  });
```

- [ ] **Step 5: Run the full org test file**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/organizations.test.ts`
Expected: PASS — credentials, DID document (+400), org-aware users, back-compat all green.

- [ ] **Step 6: Run the ENTIRE api suite (regression)**

Run: `pnpm --filter @tokenlayer/api exec vitest run`
Expected: PASS — all pre-existing tests plus keystore + organizations-repo + organizations remain green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/test/organizations.test.ts
git commit -m "feat(api): /me/credentials + /dids/:did/document; org-aware POST /users; OrgAdmin use-case filter"
```

---

## Task 10: Web — client, Organizations area, My identity, nav

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/rbac.ts`
- Create: `apps/web/src/components/Organizations.tsx`
- Create: `apps/web/src/components/MyIdentity.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Add web types**

In `apps/web/src/types.ts`:

Add `"OrgAdmin"` to the `Role` union. Add `orgId?: string | null;` and `did?: string | null;` to `SessionUser`. Append:

```typescript
export type OrgType = "bank" | "corporate" | "msme" | "government" | "verifier";
export interface Organization {
  id: string;
  name: string;
  orgType: OrgType;
  registrationId: string | null;
  jurisdiction: string | null;
  did: string;
  verified: boolean;
  status: string;
  createdAt?: string;
}
export interface OrgMember {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  did: string | null;
  active: boolean;
  kycStatus: string;
}
export interface HeldCredential {
  id: string;
  type: string[];
  issuerDid: string;
  holderDid: string;
  claims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  vcJwt: string;
}
export interface DidDocument {
  id: string;
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  authentication: string[];
  assertionMethod: string[];
}
```

- [ ] **Step 2: Add api client methods**

In `apps/web/src/api.ts`, add `DidDocument, HeldCredential, Organization, OrgMember, OrgType` to the type import, and add to the `api` object:

```typescript
  orgs: (token: string) => request<Organization[]>("/orgs", token),
  createOrg: (token: string, body: { name: string; orgType: OrgType; registrationId?: string; jurisdiction?: string }) =>
    request<Organization>("/orgs", token, { method: "POST", body: JSON.stringify(body) }),
  org: (token: string, id: string) => request<Organization>(`/orgs/${encodeURIComponent(id)}`, token),
  orgMembers: (token: string, id: string) => request<OrgMember[]>(`/orgs/${encodeURIComponent(id)}/members`, token),
  createMember: (token: string, id: string, body: { email: string; password: string; role: string; useCaseKey?: string; walletAddress?: string }) =>
    request<{ id: string; did: string; membershipVc: boolean }>(`/orgs/${encodeURIComponent(id)}/users`, token, { method: "POST", body: JSON.stringify(body) }),
  myCredentials: (token: string) => request<HeldCredential[]>("/me/credentials", token),
  didDocument: (token: string, did: string) => request<DidDocument>(`/dids/${encodeURIComponent(did)}/document`, token),
```

- [ ] **Step 3: Treat OrgAdmin as a user-manager in web rbac**

Read `apps/web/src/rbac.ts`. Update `canManageUsers` (and any `assignableRoles`/role helpers) so `OrgAdmin` is included, mirroring the core policy: `canManageUsers` returns true for `PlatformAdmin`, `OrgAdmin`, `UseCaseAdmin`. If the file enumerates assignable roles, give `OrgAdmin` `["UseCaseAdmin","Issuer","Trader","Buyer","Auditor"]`.

- [ ] **Step 4: Build the Organizations component**

Create `apps/web/src/components/Organizations.tsx` (uses existing `ui.tsx` primitives — read `apps/web/src/components/ui.tsx` first to import the correct primitive names; the code below assumes `Card`, `Pill`, `Button`, `Field`/`Input`, `Table`-like markup consistent with `UserManagement.tsx`):

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { Organization, OrgMember, OrgType } from "../types.js";
import { Card, Pill, Button } from "./ui.js";

const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];
const MEMBER_ROLES = ["OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

function short(did: string): string {
  return did.length > 20 ? `${did.slice(0, 14)}…${did.slice(-4)}` : did;
}

export function Organizations(): JSX.Element {
  const { token, user } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.orgs(token).then(setOrgs).catch((e) => setError(e.message)); };
  useEffect(reload, [token]);
  useEffect(() => { if (!selected && orgs.length) setSelected(orgs[0].id); }, [orgs, selected]);

  const isPlatform = user?.role === "PlatformAdmin";
  const current = orgs.find((o) => o.id === selected) ?? null;

  return (
    <div className="space-y-5">
      {error && <div className="text-sm text-rose-600">{error}</div>}
      {isPlatform && <CreateOrgForm onCreated={reload} />}
      <div className="grid gap-3 md:grid-cols-3">
        {orgs.map((o) => (
          <Card key={o.id} className={`cursor-pointer ${o.id === selected ? "ring-2 ring-brand-500" : ""}`} onClick={() => setSelected(o.id)}>
            <div className="flex items-center justify-between">
              <div className="font-semibold">{o.name}</div>
              <Pill tone={o.verified ? "green" : "slate"}>{o.verified ? "verified" : "unverified"}</Pill>
            </div>
            <div className="text-xs text-slate-500 mt-1 capitalize">{o.orgType}{o.jurisdiction ? ` · ${o.jurisdiction}` : ""}</div>
            <div className="text-xs font-mono text-slate-400 mt-1" title={o.did}>{short(o.did)}</div>
          </Card>
        ))}
      </div>
      {current && <Members org={current} />}
    </div>
  );
}

function CreateOrgForm({ onCreated }: { onCreated: () => void }): JSX.Element {
  const { token } = useAuth();
  const [name, setName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("bank");
  const [registrationId, setRegistrationId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!token || !name.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.createOrg(token, { name: name.trim(), orgType, registrationId: registrationId.trim() || undefined, jurisdiction: jurisdiction.trim() || undefined });
      setName(""); setRegistrationId(""); setJurisdiction("");
      onCreated();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card>
      <div className="font-semibold mb-3">Onboard an organization</div>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      <div className="grid gap-2 md:grid-cols-4">
        <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Legal name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="border rounded-lg px-3 py-2 text-sm capitalize" value={orgType} onChange={(e) => setOrgType(e.target.value as OrgType)}>
          {ORG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Registration id (optional)" value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} />
        <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Jurisdiction (optional)" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
      </div>
      <div className="mt-3"><Button onClick={submit} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create organization"}</Button></div>
    </Card>
  );
}

function Members({ org }: { org: Organization }): JSX.Element {
  const { token, user } = useAuth();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", role: "Issuer", useCaseKey: "", walletAddress: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.orgMembers(token, org.id).then(setMembers).catch((e) => setErr(e.message)); };
  useEffect(reload, [token, org.id]);

  const roles = user?.role === "PlatformAdmin" ? MEMBER_ROLES : MEMBER_ROLES.filter((r) => r !== "OrgAdmin");

  async function addMember(): Promise<void> {
    if (!token || !form.email || form.password.length < 6) { setErr("email + 6-char password required"); return; }
    setErr(null); setNotice(null);
    try {
      const res = await api.createMember(token, org.id, { email: form.email, password: form.password, role: form.role, useCaseKey: form.useCaseKey || undefined, walletAddress: form.walletAddress || undefined });
      setNotice(`Minted ${res.did} · membership VC issued`);
      setForm({ email: "", password: "", role: "Issuer", useCaseKey: "", walletAddress: "" });
      setAdding(false);
      reload();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold">Members — {org.name}</div>
        <Button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add member"}</Button>
      </div>
      {notice && <div className="text-sm text-emerald-600 mb-2">{notice}</div>}
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      {adding && (
        <div className="grid gap-2 md:grid-cols-5 mb-3">
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="border rounded-lg px-3 py-2 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Use case (optional)" value={form.useCaseKey} onChange={(e) => setForm({ ...form, useCaseKey: e.target.value })} />
          <input className="border rounded-lg px-3 py-2 text-sm" placeholder="Wallet (optional)" value={form.walletAddress} onChange={(e) => setForm({ ...form, walletAddress: e.target.value })} />
          <div className="md:col-span-5"><Button onClick={addMember}>Create member + DID</Button></div>
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500"><th className="py-1">Email</th><th>Role</th><th>Use case</th><th>DID</th><th>KYC</th></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-t border-slate-100">
              <td className="py-1">{m.email}</td>
              <td>{m.role}</td>
              <td>{m.useCaseKey ?? "—"}</td>
              <td className="font-mono text-xs text-slate-400" title={m.did ?? ""}>{m.did ? short(m.did) : "—"}</td>
              <td><Pill tone={m.active ? "green" : "slate"}>{m.kycStatus}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

If `ui.tsx` exposes differently-named primitives (e.g. `Badge` instead of `Pill`, or a `<Button>` with a `variant` prop), adapt the imports/props to the real names — do NOT invent primitives. Fall back to plain Tailwind `<button className="...">` (as `App.tsx` already does) if a named `Button` is absent.

- [ ] **Step 5: Build the My identity component**

Create `apps/web/src/components/MyIdentity.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { DidDocument, HeldCredential } from "../types.js";
import { Card, Pill } from "./ui.js";

export function MyIdentity(): JSX.Element {
  const { token, user } = useAuth();
  const [creds, setCreds] = useState<HeldCredential[]>([]);
  const [doc, setDoc] = useState<DidDocument | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const did = user?.did ?? null;

  useEffect(() => {
    if (!token) return;
    void api.myCredentials(token).then(setCreds).catch((e) => setErr(e.message));
    if (did) void api.didDocument(token, did).then(setDoc).catch(() => setDoc(null));
  }, [token, did]);

  if (!did) return <Card><div className="text-sm text-slate-500">No decentralized identity is associated with this account yet.</div></Card>;

  return (
    <div className="space-y-5">
      {err && <div className="text-sm text-rose-600">{err}</div>}
      <Card>
        <div className="font-semibold mb-2">My DID</div>
        <div className="font-mono text-xs break-all">{did}</div>
        {doc && (
          <pre className="mt-3 bg-slate-900 text-slate-100 rounded-lg p-3 text-xs overflow-x-auto">{JSON.stringify(doc, null, 2)}</pre>
        )}
      </Card>
      <Card>
        <div className="font-semibold mb-3">My credentials</div>
        {creds.length === 0 && <div className="text-sm text-slate-500">No credentials held.</div>}
        <div className="space-y-2">
          {creds.map((c) => (
            <div key={c.id} className="border border-slate-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">{c.type.join(" · ")}</div>
                <Pill tone={c.revoked ? "slate" : "green"}>{c.revoked ? "revoked" : "valid"}</Pill>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Issued by <span className="font-mono">{c.issuerDid.slice(0, 18)}…</span>
                {typeof c.claims.organization === "string" ? ` (${c.claims.organization})` : ""}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                Issued {c.issuedAt.slice(0, 10)}{c.expiresAt ? ` · expires ${c.expiresAt.slice(0, 10)}` : ""}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6: Wire the nav sections in App.tsx**

In `apps/web/src/App.tsx`:

Add imports:

```typescript
import { Organizations } from "./components/Organizations.js";
import { MyIdentity } from "./components/MyIdentity.js";
```

Widen the `Section` type:

```typescript
type Section = "overview" | "assets" | "users" | "organizations" | "identity";
```

Add the two sections to the `sections` array (after the existing entries). Organizations shows for PlatformAdmin + OrgAdmin; "My identity" shows for everyone:

```typescript
  const sections: { id: Section; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "assets", label: "Asset Management" },
    ...(canManageUsers(user.role) ? [{ id: "users" as Section, label: "User Management" }] : []),
    ...(user.role === "PlatformAdmin" || user.role === "OrgAdmin" ? [{ id: "organizations" as Section, label: "Organizations" }] : []),
    { id: "identity" as Section, label: "My identity" },
  ];
```

Add the render branches (after the `section === "users"` branch):

```typescript
        {section === "organizations" && <Organizations />}
        {section === "identity" && <MyIdentity />}
```

Note: PlatformAdmin without an active use case renders `PlatformHome` (early return at line 62) and never reaches these tabs. That is acceptable for this sub-project — Organizations is reachable once a use case is selected. If the reviewer wants Organizations on the platform landing page too, that is a follow-up; keep this task scoped to the tabbed console.

- [ ] **Step 7: Typecheck + build the web app**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: PASS — no type errors; Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/rbac.ts apps/web/src/components/Organizations.tsx apps/web/src/components/MyIdentity.tsx apps/web/src/App.tsx
git commit -m "feat(web): Organizations admin area + My identity view + client"
```

---

## Task 11: Verify — full suite, live E2E, browser, merge

**Files:**
- Create: `scripts/org-identity-e2e.mjs`

- [ ] **Step 1: Write the live E2E script**

Create `scripts/org-identity-e2e.mjs`:

```javascript
// End-to-end: PlatformAdmin onboards an org (parent DID); creates an OrgAdmin
// (sub-DID + membership VC); the OrgAdmin adds an Issuer + a Buyer (each a sub-DID
// + membership VC). Assert every membership VC is retrievable via /me/credentials,
// carries the OrganizationMembership type, and binds to the member's DID; assert
// the DID document resolves; assert cross-org isolation (OrgAdmin A ↛ org B).
const API = process.env.API ?? "http://localhost:4000/api/v1";
const runId = String(Date.now()).slice(-7);

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;

const platform = await login("admin@tokenlayer.dev", "admin123");
if (!platform) { console.error("platform login failed"); process.exit(2); }

console.log("== 1) Onboard organizations ==");
const orgA = (await call("POST", "/orgs", { name: `Acme Bank ${runId}`, orgType: "bank", registrationId: `REG-A-${runId}`, jurisdiction: "IN" }, platform)).json;
const orgB = (await call("POST", "/orgs", { name: `Globex ${runId}`, orgType: "corporate" }, platform)).json;
ok(orgA?.did?.startsWith("did:key:z"), `org A minted parent DID ${orgA?.did?.slice(0, 22)}…`, orgA);
ok(orgB?.did?.startsWith("did:key:z"), "org B minted parent DID", orgB);

const doc = (await call("GET", `/dids/${encodeURIComponent(orgA.did)}/document`, null, platform)).json;
ok(doc?.id === orgA.did && doc?.verificationMethod?.[0]?.type === "Ed25519VerificationKey2020", "org A DID document resolves (W3C)", doc);

console.log("\n== 2) PlatformAdmin creates OrgAdmin for org A ==");
const oaEmail = `orgadmin.${runId}@acme.dev`;
const oa = (await call("POST", `/orgs/${orgA.id}/users`, { email: oaEmail, password: "orgadmin123", role: "OrgAdmin" }, platform)).json;
ok(oa?.did && oa?.membershipVc === true, "OrgAdmin created with sub-DID + membership VC", oa);
const orgAdmin = await login(oaEmail, "orgadmin123");

console.log("\n== 3) OrgAdmin adds Issuer + Buyer ==");
const issuer = (await call("POST", `/orgs/${orgA.id}/users`, { email: `issuer.${runId}@acme.dev`, password: "issuer123", role: "Issuer" }, orgAdmin)).json;
const buyer = (await call("POST", `/orgs/${orgA.id}/users`, { email: `buyer.${runId}@acme.dev`, password: "buyer1234", role: "Buyer" }, orgAdmin)).json;
ok(issuer?.did && buyer?.did, "issuer + buyer each got a sub-DID", { issuer: issuer?.did, buyer: buyer?.did });

console.log("\n== 4) Every member holds a verifiable membership VC ==");
for (const [email, pw] of [[oaEmail, "orgadmin123"], [`issuer.${runId}@acme.dev`, "issuer123"], [`buyer.${runId}@acme.dev`, "buyer1234"]]) {
  const t = await login(email, pw);
  const creds = (await call("GET", "/me/credentials", null, t)).json ?? [];
  const vc = creds.find((c) => c.type.includes("OrganizationMembership"));
  ok(vc && vc.claims.orgId === orgA.id && vc.issuerDid === orgA.did, `${email} holds an OrganizationMembership VC from org A`, creds);
}

console.log("\n== 5) Cross-org isolation ==");
const crossCreate = await call("POST", `/orgs/${orgB.id}/users`, { email: `x.${runId}@globex.dev`, password: "x1234567", role: "Issuer" }, orgAdmin);
ok(crossCreate.status === 403, "OrgAdmin A cannot create members in org B (403)", crossCreate.json);
const crossList = await call("GET", `/orgs/${orgB.id}/members`, null, orgAdmin);
ok(crossList.status === 403, "OrgAdmin A cannot list org B members (403)", crossList.json);
const escalate = await call("POST", `/orgs/${orgA.id}/users`, { email: `pa.${runId}@acme.dev`, password: "pa123456", role: "PlatformAdmin" }, orgAdmin);
ok(escalate.status === 403, "OrgAdmin cannot mint a PlatformAdmin (403)", escalate.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ ORG + IDENTITY END-TO-END PASSED — orgs onboarded, DIDs minted, membership VCs verified, isolation enforced"}`);
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run the full monorepo build + test suite**

Run: `pnpm -r build && pnpm -r test`
Expected: PASS — core, adapters, contracts, api, web all green (api test count increases by the keystore + organizations-repo + organizations suites).

- [ ] **Step 3: Boot the API and run the live E2E**

In one shell: `pnpm --filter @tokenlayer/api dev` (or `DATABASE_URL=file:./org-e2e.db pnpm --filter @tokenlayer/api dev`). It boots with the dev keystore warning (`DID_MASTER_KEY not set`) — that is expected outside production. In another shell: `node scripts/org-identity-e2e.mjs`
Expected: `✅ ORG + IDENTITY END-TO-END PASSED`.

- [ ] **Step 4: Browser verification**

Use the Browser pane (`preview_start` for the web dev server; ensure the API is running). Log in as `admin@tokenlayer.dev` / `admin123`, select a use case to reach the console, open the **Organizations** tab, create an org (see its DID + verified Pill), add a member (see the "Minted did:key… · membership VC issued" notice and the member row with a DID). Then log in as that member and open **My identity** — confirm the DID document JSON renders and the membership credential shows a green "valid" Pill. Capture a screenshot as proof (`computer` screenshot).

- [ ] **Step 5: Full-suite green gate + finish the branch**

Run once more: `pnpm -r test`
Expected: PASS.

Then use the **superpowers:finishing-a-development-branch** skill to review, squash/merge to `main`, and clean up. Confirm the merge with the user before pushing if a remote is configured.

- [ ] **Step 6: Commit the E2E script (if not already committed in Step 5's flow)**

```bash
git add scripts/org-identity-e2e.mjs
git commit -m "test(e2e): org onboarding + custodial DID + membership VC live E2E"
```

---

## Self-Review

**1. Spec coverage:**
- Locked decision 1 (Org owns use cases): `UseCase.ownerOrgId` (Tasks 1/3/5) + OrgAdmin `/use-cases` filter (Task 9). ✓
- Locked decision 2 (reuse identity.ts): only additive `type?` param on `issueCredential` (Task 1); custody via `didKeyFromSeed` (Task 2). ✓
- Locked decision 3 (admin-created onboarding): `POST /orgs` PlatformAdmin-only, `verified:true` (Task 7). ✓
- Locked decision 4 (custodial keys): keystore AES-256-GCM seed custody (Task 2). ✓
- Locked decision 5 (membership VC): `mintMembership` + `issueMembershipCredential` (Tasks 2/8). ✓
- Data model (Organization, Credential, User.orgId/didSeedEncrypted, UseCase.ownerOrgId, memory + prisma): Tasks 3–5. ✓
- Core role + RBAC (OrgAdmin=read): Task 1. ✓
- Keystore surface (newSeed/encryptSeed/decryptSeed/keyOf/issueMembershipCredential + AppDeps injection + didMasterConfigured): Tasks 2/6. ✓
- Routes (POST/GET /orgs, POST /orgs/:id/users, GET /orgs/:id/members, GET /me/credentials, GET /dids/:did/document, orgId in JWT, org-aware POST /users): Tasks 6–9. ✓
- Error handling (503 unconfigured keystore in prod, 403 cross-org, 404 unknown org, 409 duplicate name/registrationId, EMAIL_TAKEN, rollback on mint failure): Tasks 7–8. ✓
- Web (Organizations area + Members + My identity + client): Task 10. ✓
- Testing (organizations.test.ts, org-identity-e2e.mjs, browser): Tasks 7–9, 11. ✓
- Data-flow/trust (self-issued membership VC verifiable via org DID): asserted in Task 8 + E2E Task 11. ✓

**2. Placeholder scan:** No TBD/TODO; each code step carries complete code. Two steps intentionally require reading an existing function before a one-line edit (`normalizeUseCaseDefinition` in Task 1 Step 8; `rowToUseCase`/`useCaseToData` in Task 5 Step 2; `ui.tsx` primitive names in Task 10 Step 4; `rbac.ts` shape in Task 10 Step 3; seed credentials in Task 7 Step 1) — these are read-then-edit instructions with the exact change specified, not placeholders.

**3. Type consistency:** `Keystore`/`MembershipInput` (Task 2) match usage in `mintMembership` (Task 8) and `AppDeps` (Task 6). `OrganizationRecord`/`CredentialRecord`/`OrganizationRepository`/`CredentialRepository` names are identical across types.ts (Task 3), memory.ts (Task 4), prisma.ts (Task 5), context.ts (Task 6). `orgView` strips `didSeedEncrypted` consistently. `TokenClaims.orgId`/`.did` set in login (Task 6 Step 5) + refreshed in `requireUser` (Task 6 Step 4) + read in routes (Tasks 7–9). `canCreateOrgMember(managerRole, targetRole)` signature matches core (Task 1) and route call (Task 8). `didMasterConfigured` flows env→server→AppDeps→route (Tasks 2/6/7) and test helper opt (Task 6). Web `Organization`/`OrgMember`/`HeldCredential`/`DidDocument` (Task 10 Step 1) match api client returns (Step 2) and components (Steps 4–5).
