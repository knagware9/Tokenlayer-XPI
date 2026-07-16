# Richer VC Issuance + Maker-Checker Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orgs issue a catalog of real credential types (KycCredential, AccreditedInvestor, AuthorizedSignatory) to subjects, gated by per-type maker-checker approval, and revoke them with a reason.

**Architecture:** A declarative credential-type registry in core supplies each type's claim schema (validated by the *existing* `validateMetadata`), its allowed issuer orgTypes, and its approval depth. The existing Proposal system is refactored — not duplicated — into a registry of `ProposalKindHandler`s (`canView`/`canApprove`/`execute`/`compensate`), which decouples it from token operations so a credential request is just a Proposal of kind `issue-credential`. The keystore's membership signer generalizes to any org-issued credential type and adds a `credentialStatus` pointer.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm monorepo, Fastify, Prisma + SQLite, Vitest, React + Vite + Tailwind, `node:crypto` (Ed25519).

**Reference spec:** `docs/superpowers/specs/2026-07-16-credential-issuance-design.md`

---

## ⚠️ Two hazards this plan exists to avoid

Read these before Task 2. They are the whole reason the refactor is sequenced the way it is.

**1. `scopedToCaller` becomes a cross-org leak when `useCaseKey` is nullable.**
`support.ts:76-78` is:
```typescript
export function scopedToCaller(claims: TokenClaims, useCaseKey: string): boolean {
  return claims.role === "PlatformAdmin" || claims.useCaseKey === useCaseKey;
}
```
An OrgAdmin has `useCaseKey: null`. A credential proposal has `useCaseKey: null`. So `null === null` → **true**, and *every* OrgAdmin of *every* org could view and approve *every other* org's credential proposals. `scopedProposal` and `GET /proposals` MUST route through the kind registry's `canView`, never through `scopedToCaller`, for org-scoped kinds. Task 6 has an explicit test for this.

**2. The refactor must be behaviour-preserving.** `apps/api/test/approvals.test.ts` must pass **unchanged** after Task 2. Do not edit that file to accommodate the refactor. If it goes red, the refactor is wrong.

---

## File Structure

**Create:**
- `packages/core/src/credential-types.ts` — the credential catalog + per-type lookup.
- `packages/core/test/credential-types.test.ts`
- `apps/api/src/proposal-kinds.ts` — the `ProposalKindHandler` registry + the token handlers.
- `apps/api/src/credential-kinds.ts` — the `issue-credential` / `revoke-credential` handlers.
- `apps/api/test/credential-issuance.test.ts`
- `scripts/credential-issuance-e2e.mjs`
- `apps/web/src/components/CredentialsPanel.tsx` — issue + revoke, org-scoped.

**Modify (core):** `types.ts` (move `OrgType` in), `index.ts` (export the registry).
**Modify (api):** `prisma/schema.prisma`, `persistence/types.ts`, `persistence/memory.ts`, `persistence/prisma.ts`, `keystore.ts`, `context.ts`, `http/routes.ts`, `http/schemas.ts`.
**Modify (web):** `types.ts`, `api.ts`, `components/ApprovalsPanel.tsx`, `components/Organizations.tsx`, `components/MyIdentity.tsx`, `App.tsx`, `components/PlatformHome.tsx`.

---

## Task 1: Core — OrgType + the credential-type registry

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/credential-types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/api/src/persistence/types.ts` (re-export `OrgType`)
- Test: `packages/core/test/credential-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/credential-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CREDENTIAL_TYPES, credentialTypeDef, validateMetadata, PolicyError } from "../src/index.js";

describe("credential type registry", () => {
  it("declares the three compliance types", () => {
    expect(Object.keys(CREDENTIAL_TYPES).sort()).toEqual(["AccreditedInvestor", "AuthorizedSignatory", "KycCredential"]);
  });

  it("every type has a usable schema, >=1 approvals, and at least one permitted issuer", () => {
    for (const def of Object.values(CREDENTIAL_TYPES)) {
      expect(def.requiredApprovals).toBeGreaterThanOrEqual(1);
      expect(def.validityDays).toBeGreaterThan(0);
      expect(def.allowedIssuerOrgTypes.length).toBeGreaterThan(0);
      expect(def.claimSchema.type).toBe("object");
      expect(Object.keys(def.claimSchema.properties).length).toBeGreaterThan(0);
    }
  });

  it("AuthorizedSignatory needs two approvals and is self-issued only", () => {
    const def = credentialTypeDef("AuthorizedSignatory");
    expect(def.requiredApprovals).toBe(2);
    expect(def.selfIssuedOnly).toBe(true);
  });

  it("throws a coded PolicyError on an unknown type", () => {
    expect(() => credentialTypeDef("NopeCredential")).toThrow(PolicyError);
    try {
      credentialTypeDef("NopeCredential");
    } catch (e) {
      expect((e as PolicyError).code).toBe("UNKNOWN_CREDENTIAL_TYPE");
    }
  });
});

describe("per-type claim validation (reuses validateMetadata)", () => {
  it("accepts a good KycCredential claim set", () => {
    expect(() => validateMetadata({ legalName: "Priya R", country: "IN" }, credentialTypeDef("KycCredential").claimSchema)).not.toThrow();
  });

  it("rejects a KycCredential missing a required claim", () => {
    expect(() => validateMetadata({ legalName: "Priya R" }, credentialTypeDef("KycCredential").claimSchema)).toThrow();
  });

  it("rejects a bad country code (pattern) and a bad enum", () => {
    expect(() => validateMetadata({ legalName: "X", country: "INDIA" }, credentialTypeDef("KycCredential").claimSchema)).toThrow();
    expect(() => validateMetadata({ basis: "vibes", jurisdiction: "IN" }, credentialTypeDef("AccreditedInvestor").claimSchema)).toThrow();
  });

  it("accepts a good AccreditedInvestor claim set", () => {
    expect(() => validateMetadata({ basis: "net-worth", jurisdiction: "IN" }, credentialTypeDef("AccreditedInvestor").claimSchema)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/credential-types.test.ts`
Expected: FAIL — `CREDENTIAL_TYPES` / `credentialTypeDef` are not exported.

- [ ] **Step 3: Move `OrgType` into core**

In `packages/core/src/types.ts`, add near the `Role` declarations (top of file):

```typescript
/** The kind of tenant an organization is. */
export type OrgType = "bank" | "corporate" | "msme" | "government" | "verifier";

export const ORG_TYPES: readonly OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];
```

In `apps/api/src/persistence/types.ts`, DELETE the local `export type OrgType = ...` line and instead re-export core's (so every existing import site keeps working unchanged). Add to the existing `import type { ... } from "@tokenlayer/core"` at the top: `OrgType`, then add near it:

```typescript
export type { OrgType };
```

- [ ] **Step 4: Create the registry**

Create `packages/core/src/credential-types.ts`:

```typescript
/**
 * The credential catalog: every type the platform can issue, with the claim
 * schema it must satisfy, who may issue it, and how many approvals it needs.
 *
 * This is deliberately a closed, typed registry. Claims are validated against
 * `claimSchema` with the same `validateMetadata` used for use-case issuance
 * metadata — an unvalidated claim set must never reach a signed credential.
 */
import { PolicyError } from "./errors.js";
import type { MetadataSchema, OrgType } from "./types.js";

export type CredentialType = "KycCredential" | "AccreditedInvestor" | "AuthorizedSignatory";

export interface CredentialTypeDefinition {
  type: CredentialType;
  description: string;
  /** orgTypes permitted to issue this credential. */
  allowedIssuerOrgTypes: OrgType[];
  /** Approvals required before issuance or revocation takes effect. Always >= 1. */
  requiredApprovals: number;
  /** Claim shape the request must satisfy (validated via validateMetadata). */
  claimSchema: MetadataSchema;
  validityDays: number;
  /** When true, the issuing org must be the subject's own org. */
  selfIssuedOnly?: boolean;
}

export const CREDENTIAL_TYPES: Record<CredentialType, CredentialTypeDefinition> = {
  KycCredential: {
    type: "KycCredential",
    description: "Know-your-customer verification of a natural or legal person.",
    allowedIssuerOrgTypes: ["verifier", "bank", "government"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["legalName", "country"],
      properties: {
        legalName: { type: "string", description: "Verified legal name" },
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code", pattern: "^[A-Z]{2}$" },
        idType: { type: "string", description: "Identity document type", enum: ["passport", "national-id", "driving-licence"] },
        idNumber: { type: "string", description: "Identity document number" },
      },
    },
  },
  AccreditedInvestor: {
    type: "AccreditedInvestor",
    description: "Attests the subject qualifies as an accredited/professional investor.",
    allowedIssuerOrgTypes: ["verifier", "bank"],
    requiredApprovals: 1,
    validityDays: 365,
    claimSchema: {
      type: "object",
      required: ["basis", "jurisdiction"],
      properties: {
        basis: { type: "string", description: "Basis of accreditation", enum: ["income", "net-worth", "professional"] },
        jurisdiction: { type: "string", description: "Jurisdiction the accreditation is asserted under", pattern: "^[A-Z]{2}$" },
      },
    },
  },
  AuthorizedSignatory: {
    type: "AuthorizedSignatory",
    description: "Declares that the subject may act for the issuing organization.",
    // Any org may declare its own signatories — but only its own (selfIssuedOnly).
    allowedIssuerOrgTypes: ["bank", "corporate", "msme", "government", "verifier"],
    // Two approvals: this credential confers authority to act for the org, the
    // highest-stakes claim in the catalog.
    requiredApprovals: 2,
    validityDays: 365,
    selfIssuedOnly: true,
    claimSchema: {
      type: "object",
      required: ["role", "scope"],
      properties: {
        role: { type: "string", description: "Title the signatory holds" },
        scope: { type: "string", description: "What they may authorize", enum: ["issuance", "treasury", "all"] },
      },
    },
  },
};

/** The definition for `type`, or a coded PolicyError (→ HTTP 400) if unknown. */
export function credentialTypeDef(type: string): CredentialTypeDefinition {
  const def = CREDENTIAL_TYPES[type as CredentialType];
  if (!def) {
    throw new PolicyError("UNKNOWN_CREDENTIAL_TYPE", `unknown credential type '${type}'`, { type, known: Object.keys(CREDENTIAL_TYPES) });
  }
  return def;
}
```

- [ ] **Step 5: Export it from core**

In `packages/core/src/index.ts`, add after the `user-policy.js` export line:

```typescript
export * from "./credential-types.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/credential-types.test.ts`
Expected: PASS (8 tests).

Note: `validateMetadata` (`validation.ts:283`) already enforces `required`, `enum`, and `pattern`. If the pattern/enum assertions fail, READ `validateMetadata` and adapt the *schema* to its real semantics — do not weaken the test and do not modify `validateMetadata` (it is load-bearing for use-case issuance).

- [ ] **Step 7: Build core + full core suite**

Run: `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/core exec vitest run`
Expected: PASS — 141 existing + 8 new. Then `pnpm --filter @tokenlayer/api exec tsc --noEmit` to confirm the `OrgType` move broke no API import site.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/credential-types.ts packages/core/src/index.ts packages/core/test/credential-types.test.ts apps/api/src/persistence/types.ts
git commit -m "feat(core): credential-type registry with per-type claim schemas + approval depth

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Refactor Proposal into a kind registry (behaviour-preserving)

**This task adds NO features.** It extracts four seams so Task 5 can add credential kinds. The gate is that `apps/api/test/approvals.test.ts` passes **unchanged**.

**Files:**
- Create: `apps/api/src/proposal-kinds.ts`
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Confirm the baseline is green (this is the reference behaviour)**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/approvals.test.ts`
Expected: PASS. Note the test count — it must be identical at Step 6.

- [ ] **Step 2: Create the registry with the token handlers**

Create `apps/api/src/proposal-kinds.ts`. The four seams, extracted verbatim from `routes.ts`:

```typescript
/**
 * Proposal kinds: the per-kind policy + side effects behind the generic
 * maker-checker machinery. The concurrency core (CAS claimDecided, optimistic
 * addApproval, the SELF_APPROVAL rule, execution under the proposer's identity)
 * stays in the routes and is kind-agnostic; everything that differs per kind
 * lives here.
 *
 * Scoping is a per-kind strategy: token kinds are use-case scoped, credential
 * kinds are org scoped. `canView` is a SECURITY boundary — never fall back to
 * scopedToCaller for a kind whose useCaseKey is null (null === null would match
 * every unscoped user).
 */
import type { Actor, LifecycleAction } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded, executeCashflowCore, executeIssueActivation, runGatedAction } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import { scopedToCaller } from "./http/support.js";
import type { ProposalRecord } from "./persistence/types.js";

/** Minimal logger shape (a Fastify request.log). */
export interface KindLogger {
  error(obj: unknown, msg: string): void;
}

export interface KindContext {
  deps: AppDeps;
  log: KindLogger;
}

export interface ProposalKindHandler {
  kind: string;
  /** May this caller SEE this proposal? Security boundary. */
  canView(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** May this caller decide it? (Already known to not be the proposer.) */
  canApprove(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** Side effect once the approval threshold is reached. Runs as `proposer`. */
  execute(ctx: KindContext, proposer: Actor, p: ProposalRecord): Promise<void>;
  /** Undo/compensate when the proposal will never execute. */
  compensate?(ctx: KindContext, p: ProposalRecord, reason: "rejected" | "failed"): Promise<void>;
}

// Maker-checker capability an approver must hold for each gated token op. Every
// op maps to itself except cashflow-execute, which mirrors its route gate (issue).
const CAPABILITY_FOR: Record<string, LifecycleAction> = {
  issue: "issue", mint: "mint", transfer: "transfer", burn: "burn",
  freeze: "freeze", unfreeze: "unfreeze", "cashflow-execute": "issue",
};

const tokenCanView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  p.useCaseKey !== null && scopedToCaller(claims, p.useCaseKey);

const tokenCanApprove = async (deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> => {
  const capability = CAPABILITY_FOR[p.kind];
  return !!capability && deps.rbac.can(claims.role, capability);
};

/**
 * Refund an issuance fee captured at propose time (best-effort). Shared by
 * rejection and failed activation so a gated issue never keeps a fee for an
 * asset that never activated.
 */
async function refundIssuanceFee(ctx: KindContext, p: ProposalRecord): Promise<void> {
  const fee = p.payload.issuanceFee as { amount: string; currency: string; payer?: string } | undefined;
  if (fee?.payer && ctx.deps.platformFeeAccount) {
    await ctx.deps.cash.transfer(fee.currency, ctx.deps.platformFeeAccount, fee.payer, fee.amount).catch((refundErr) =>
      ctx.log.error({ refundErr, proposalId: p.id }, "issuance fee refund failed — manual reconciliation required"));
  }
}

/** Load the proposal's asset, or throw the same coded errors the old dispatch did. */
async function assetOf(ctx: KindContext, p: ProposalRecord, missing: string) {
  const asset = p.assetId ? await ctx.deps.assets.get(p.assetId) : null;
  if (!asset) throw coded(404, "NOT_FOUND", missing);
  return asset;
}

const issueKind: ProposalKindHandler = {
  kind: "issue",
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "pending asset missing");
    // Re-assert the asset is still awaiting approval (not rejected/decided elsewhere).
    if (asset.status !== "pending_approval") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    await executeIssueActivation(ctx.deps, proposer, asset, p.payload as Parameters<typeof executeIssueActivation>[3]);
  },
  async compensate(ctx, p, reason) {
    if (reason === "rejected" && p.assetId) await ctx.deps.assets.setStatus(p.assetId, "rejected");
    await refundIssuanceFee(ctx, p);
  },
};

const cashflowKind: ProposalKindHandler = {
  kind: "cashflow-execute",
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "asset missing");
    // Re-check the asset is live at approval time — it may have matured/frozen since propose.
    if (asset.status !== "active") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    const cf = await ctx.deps.cashflows.get(String(p.payload.cfId));
    if (!cf || cf.assetId !== asset.id) throw coded(404, "NOT_FOUND", "cashflow missing");
    await executeCashflowCore(ctx.deps, proposer, asset, cf, String(p.payload.from), ctx.log);
  },
};

/** mint | transfer | burn | freeze | unfreeze — the five direct lifecycle actions. */
const actionKind = (kind: string): ProposalKindHandler => ({
  kind,
  canView: tokenCanView,
  canApprove: tokenCanApprove,
  async execute(ctx, proposer, p) {
    const asset = await assetOf(ctx, p, "asset missing");
    // The direct action route rejects non-active assets before gating; the
    // approval path must re-assert it (the asset may have matured/frozen since
    // propose), or a gated mint/transfer could mutate a redeemed instrument.
    if (asset.status !== "active") throw coded(409, "ASSET_NOT_ACTIVE", `asset is ${asset.status}`);
    await runGatedAction(ctx.deps, proposer, asset, p.kind, (p.payload.body ?? {}) as Record<string, string>);
  },
});

const HANDLERS = new Map<string, ProposalKindHandler>();
export function registerProposalKind(h: ProposalKindHandler): void {
  HANDLERS.set(h.kind, h);
}
for (const h of [issueKind, cashflowKind, ...["mint", "transfer", "burn", "freeze", "unfreeze"].map(actionKind)]) {
  registerProposalKind(h);
}

/** The handler for `kind`. Throws (rather than falling through to a token branch) on an unknown kind. */
export function proposalKind(kind: string): ProposalKindHandler {
  const h = HANDLERS.get(kind);
  if (!h) throw coded(400, "UNKNOWN_PROPOSAL_KIND", `unknown proposal kind '${kind}'`);
  return h;
}

/** Every registered kind — used by GET /proposals to filter by visibility. */
export function allProposalKinds(): ProposalKindHandler[] {
  return [...HANDLERS.values()];
}
```

- [ ] **Step 3: Rewire routes.ts onto the registry**

In `apps/api/src/http/routes.ts`:

(a) Add the import:
```typescript
import { proposalKind } from "../proposal-kinds.js";
```

(b) DELETE the module-level `CAPABILITY_FOR` map (it moved into `proposal-kinds.ts`). Verify with `grep -n "CAPABILITY_FOR" apps/api/src/http/routes.ts` that no reference remains.

(c) Replace `scopedProposal` so visibility is kind-aware:
```typescript
  async function scopedProposal(request: FastifyRequest, reply: FastifyReply): Promise<ProposalRecord | null> {
    const { id } = request.params as { id: string };
    const p = await deps.proposals.get(id);
    // Visibility is per-kind: token kinds are use-case scoped, credential kinds
    // org scoped. Never scopedToCaller here — a null useCaseKey would match every
    // unscoped user (null === null) and leak across orgs.
    if (!p || !(await proposalKind(p.kind).canView(deps, request.user as TokenClaims, p))) {
      notFound(reply, "proposal not found");
      return null;
    }
    return p;
  }
```

(d) Replace the whole `executeProposal` function with:
```typescript
  // Run the finalized proposal's operation as the PROPOSER's identity (RBAC +
  // engine compliance re-apply to the proposer at execution time).
  async function executeProposal(request: FastifyRequest, p: ProposalRecord, proposer: Actor): Promise<void> {
    await proposalKind(p.kind).execute({ deps, log: request.log }, proposer, p);
  }
```

(e) In `decide`, replace the capability check:
```typescript
    if (!(await proposalKind(p.kind).canApprove(deps, claims, p))) {
      return reply.code(403).send({ error: "NOT_ELIGIBLE", message: `role '${claims.role}' may not decide '${p.kind}' proposals` });
    }
```

(f) In `decide`, DELETE the local `refundIssuanceFee` closure and route the three compensation sites through the handler:
- reject branch — replace `if (p.kind === "issue" && p.assetId) { await deps.assets.setStatus(p.assetId, "rejected"); await refundIssuanceFee(); }` with:
```typescript
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "rejected");
```
- proposer-inactive branch — replace `if (p.kind === "issue") await refundIssuanceFee();` with:
```typescript
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "failed");
```
- execute-failure branch — replace `if (p.kind === "issue") await refundIssuanceFee();` with:
```typescript
      await proposalKind(p.kind).compensate?.({ deps, log: request.log }, p, "failed");
```

Everything else in `decide` (the CAS `claimDecided`, `addApproval` + `ALREADY_APPROVED`, the `SELF_APPROVAL` rule, the threshold check, `setStatus`) is untouched.

- [ ] **Step 4: Verify the extraction is faithful — the reject path**

The old reject branch did `setStatus(asset,"rejected")` **then** `refundIssuanceFee()`, only when `p.kind === "issue" && p.assetId`. The new `issueKind.compensate(_, _, "rejected")` does exactly that in the same order, guarded by `p.assetId`. Confirm by reading both. If they differ, fix the handler — not the test.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: THE GATE — approvals tests unchanged**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/approvals.test.ts`
Expected: PASS, same count as Step 1, with **zero edits to that file**. Then the full suite:
`pnpm --filter @tokenlayer/api exec vitest run` → 173 passing, unchanged.

If anything is red: the refactor diverged. Debug the handler; do not touch the test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/proposal-kinds.ts apps/api/src/http/routes.ts
git commit -m "refactor(api): extract proposal kinds into a scope-agnostic registry

No behaviour change: token proposal tests pass unchanged. Decouples the
maker-checker core from token operations so non-token kinds can register.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Persistence — nullable useCaseKey, orgId, credential revocation

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/persistence/types.ts`
- Modify: `apps/api/src/persistence/memory.ts`
- Modify: `apps/api/src/persistence/prisma.ts`

- [ ] **Step 1: Schema**

In `apps/api/prisma/schema.prisma`, `Proposal` model: change `useCaseKey String` → `useCaseKey String?`, add `orgId String?` after it, and add a second index so org queries are indexed:

```prisma
  useCaseKey    String?                // null for non-token (e.g. credential) proposals
  orgId         String?                // set for org-scoped kinds; null for token kinds
```
and alongside the existing `@@index([useCaseKey, status])` add:
```prisma
  @@index([orgId, status])
```

`Credential` model — add revocation provenance before `@@index([holderDid])`:
```prisma
  revokedAt     DateTime?
  revokedReason String?
  revokedBy     String? // user id that proposed the revocation
  proposalId    String? // the approved request that produced this credential
```

- [ ] **Step 2: Push the schema**

Run: `pnpm --filter @tokenlayer/api exec prisma db push`
Expected: in sync + client regenerated. If it reports drift from a pre-existing `Asset` unique index, re-run with `--accept-data-loss` (that constraint predates this work; the changes here are additive nullable columns).

- [ ] **Step 3: Types**

In `apps/api/src/persistence/types.ts`:

`ProposalRecord.useCaseKey` → `string | null`; add `orgId: string | null;` after it.

`ProposalRepository` — add an org lister:
```typescript
  /** Newest first, scoped to one org, optionally by status. */
  listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]>;
```

`CredentialRecord` — add:
```typescript
  revokedAt: string | null;
  revokedReason: string | null;
  revokedBy: string | null;
  proposalId: string | null;
```

`CredentialRepository` — accept an explicit id and add revoke + an issuer lister:
```typescript
export interface CredentialRepository {
  /** `id` is supplied by the caller: the VC embeds it in `jti` + credentialStatus before signing. */
  create(input: CredentialRecord): Promise<CredentialRecord>;
  listByHolder(holderDid: string): Promise<CredentialRecord[]>;
  listByIssuer(issuerDid: string): Promise<CredentialRecord[]>;
  get(id: string): Promise<CredentialRecord | null>;
  setRevoked(id: string, revoked: boolean): Promise<CredentialRecord>;
  revoke(id: string, input: { reason: string; by: string; at: string }): Promise<CredentialRecord>;
}
```

Note `create` now takes the full `CredentialRecord` (id included) instead of `Omit<..., "id">`.

- [ ] **Step 4: Memory repos**

In `apps/api/src/persistence/memory.ts`:

`MemoryProposalRepository` — add:
```typescript
  async listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]> {
    return [...this.byId.values()].filter((p) => p.orgId === orgId && (!status || p.status === status)).reverse();
  }
```
(Match the ordering of the existing `list` — read it first; if it sorts newest-first by another means, mirror that.)

`MemoryCredentialRepository` — change `create` to use the supplied id and add the two methods:
```typescript
  async create(input: CredentialRecord): Promise<CredentialRecord> {
    const rec: CredentialRecord = { ...input };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async listByIssuer(issuerDid: string): Promise<CredentialRecord[]> {
    return [...this.byId.values()].filter((c) => c.issuerDid === issuerDid);
  }
  async revoke(credId: string, input: { reason: string; by: string; at: string }): Promise<CredentialRecord> {
    const rec = this.byId.get(credId);
    if (!rec) throw new Error(`unknown credential '${credId}'`);
    rec.revoked = true;
    rec.revokedReason = input.reason;
    rec.revokedBy = input.by;
    rec.revokedAt = input.at;
    return rec;
  }
```

- [ ] **Step 5: Prisma repos**

In `apps/api/src/persistence/prisma.ts`:

`toProposal` mapper — add `orgId: r.orgId ?? null` and make `useCaseKey` pass through as nullable (read the existing mapper and match its style).

`PrismaProposalRepository` — add:
```typescript
  async listByOrg(orgId: string, status?: string): Promise<ProposalRecord[]> {
    return (await prisma.proposal.findMany({ where: { orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toProposal);
  }
```
(Match the existing `list`'s `orderBy`.)

`toCredential` — add `revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, revokedReason: r.revokedReason, revokedBy: r.revokedBy, proposalId: r.proposalId`.

`PrismaCredentialRepository` — `create` uses the supplied id; add the two methods:
```typescript
  async create(input: CredentialRecord): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.create({
      data: {
        id: input.id,
        holderDid: input.holderDid, issuerDid: input.issuerDid, type: input.type, vcJwt: input.vcJwt,
        subjectClaims: JSON.stringify(input.subjectClaims),
        issuedAt: new Date(input.issuedAt), expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        revoked: input.revoked, proposalId: input.proposalId,
      },
    }));
  }
  async listByIssuer(issuerDid: string): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany({ where: { issuerDid }, orderBy: { issuedAt: "desc" } })).map(toCredential);
  }
  async revoke(id: string, input: { reason: string; by: string; at: string }): Promise<CredentialRecord> {
    return toCredential(await prisma.credential.update({
      where: { id },
      data: { revoked: true, revokedReason: input.reason, revokedBy: input.by, revokedAt: new Date(input.at) },
    }));
  }
```

- [ ] **Step 6: Fix the `mintMembership` call site**

`CredentialRepository.create` now requires an `id`. In `apps/api/src/http/routes.ts`, `mintMembership` calls `deps.credentials.create({...})` without one. Add `randomUUID()` (already imported in routes.ts from `node:crypto`) plus the new null fields:
```typescript
    await deps.credentials.create({
      id: randomUUID(),
      holderDid: did, issuerDid: org.did, type: "OrganizationMembership", vcJwt,
      subjectClaims: { id: did, organization: org.name, orgId: org.id, role, memberSince },
      issuedAt: new Date(now * 1000).toISOString(), expiresAt: new Date(expiresAt * 1000).toISOString(),
      revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
    });
```

- [ ] **Step 7: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; 173 passing (the org/membership tests from #1 exercise the changed `create`).

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/src/http/routes.ts
git commit -m "feat(api): org-scoped proposals + credential revocation columns + explicit credential id

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Keystore — issueOrgCredential + credentialStatus

**Files:**
- Modify: `apps/api/src/keystore.ts`
- Test: `apps/api/test/keystore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/keystore.test.ts` (inside the existing `describe("keystore", ...)`):

```typescript
  it("issues an arbitrary org credential type with a status pointer and the given id", () => {
    const ks = createKeystore(MASTER);
    const orgEnc = ks.encryptSeed(ks.newSeed());
    const org = ks.keyOf(orgEnc);
    const subject = ks.keyOf(ks.encryptSeed(ks.newSeed()));
    const now = 1_800_000_000;
    const { vcJwt, expiresAt } = ks.issueOrgCredential({
      orgEncSeed: orgEnc, orgDid: org.did, subjectDid: subject.did,
      type: "KycCredential", claims: { legalName: "Priya R", country: "IN" },
      credentialId: "cred-123", statusUrl: "https://api.example/credentials/cred-123/status",
      validityDays: 365, now,
    });
    expect(verifyJwtSignature(vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    const { payload } = decodeJwt(vcJwt);
    const vc = payload.vc as { type: string[]; credentialSubject: { id: string; country: string }; credentialStatus: { id: string; type: string } };
    expect(vc.type).toEqual(["VerifiableCredential", "KycCredential"]);
    expect(vc.credentialSubject.id).toBe(subject.did);
    expect(vc.credentialSubject.country).toBe("IN");
    expect(vc.credentialStatus.id).toBe("https://api.example/credentials/cred-123/status");
    expect(vc.credentialStatus.type).toBe("SimpleRevocationStatus2024");
    expect(payload.jti).toBe("cred-123");
    expect(expiresAt).toBe(now + 365 * 24 * 3600);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/keystore.test.ts`
Expected: FAIL — `ks.issueOrgCredential is not a function`.

- [ ] **Step 3: Implement**

`issueCredential` in core sets `jti: urn:uuid:randomUUID()` and takes no `credentialStatus`, so `issueOrgCredential` builds the VC-JWT directly via core's `signJwt` (already exported). In `apps/api/src/keystore.ts`:

Change the core import to:
```typescript
import { didKeyFromSeed, issueCredential, signJwt, type DidKey } from "@tokenlayer/core";
```

Add above `Keystore`:
```typescript
/**
 * OUR OWN revocation-status type — deliberately NOT named StatusList2021, which
 * this is not. It resolves to `{ revoked, revokedAt, reason }` over HTTP.
 * Sub-project #4 replaces it with a real on-chain status list.
 */
export const REVOCATION_STATUS_TYPE = "SimpleRevocationStatus2024";

export interface OrgCredentialInput {
  orgEncSeed: string;
  orgDid: string;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  /** Generated by the caller BEFORE signing: the VC embeds it in jti + credentialStatus. */
  credentialId: string;
  statusUrl: string;
  validityDays: number;
  /** Unix seconds. */
  now: number;
}
```

Add to the `Keystore` interface:
```typescript
  issueOrgCredential(input: OrgCredentialInput): { vcJwt: string; expiresAt: number };
```

Inside `createKeystore`, add before `issueMembershipCredential` and include it in the returned object:
```typescript
  const issueOrgCredential = ({ orgEncSeed, orgDid, subjectDid, type, claims, credentialId, statusUrl, validityDays, now }: OrgCredentialInput): { vcJwt: string; expiresAt: number } => {
    const orgKey = keyOf(orgEncSeed);
    const expiresAt = now + validityDays * 24 * 3600;
    const vcJwt = signJwt(
      { alg: "EdDSA", typ: "JWT", kid: `${orgDid}#0` },
      {
        iss: orgDid, sub: subjectDid, jti: credentialId, iat: now, nbf: now, exp: expiresAt,
        vc: {
          "@context": ["https://www.w3.org/2018/credentials/v1"],
          type: ["VerifiableCredential", type],
          credentialSubject: { id: subjectDid, ...claims },
          credentialStatus: { id: statusUrl, type: REVOCATION_STATUS_TYPE },
        },
      },
      orgKey.privateKey,
    );
    return { vcJwt, expiresAt };
  };
```
and update the return: `return { newSeed, encryptSeed, decryptSeed, keyOf, issueOrgCredential, issueMembershipCredential };`

Leave `issueMembershipCredential` exactly as-is (it keeps using `issueCredential`, no status pointer, 365d) so #1's behaviour and tests are untouched.

- [ ] **Step 4: Run the keystore tests**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/keystore.test.ts`
Expected: PASS — 5 existing + 1 new.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/keystore.ts apps/api/test/keystore.test.ts
git commit -m "feat(api): keystore.issueOrgCredential with an honest credentialStatus pointer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: The credential proposal kinds

**Files:**
- Create: `apps/api/src/credential-kinds.ts`
- Modify: `apps/api/src/context.ts`
- Modify: `apps/api/src/proposal-kinds.ts` (register them)

- [ ] **Step 1: Add the public API base URL to AppDeps**

`credentialStatus.id` must be an absolute, resolvable URL. In `apps/api/src/context.ts` add to `AppDeps`:
```typescript
  /** Public base URL of this API (e.g. "http://localhost:4000/api/v1"), used to build resolvable credentialStatus URLs. */
  publicApiUrl: string;
```
In `apps/api/src/env.ts`, add to `Env` and the `env` literal:
```typescript
  publicApiUrl: string;
```
```typescript
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}/api/v1`,
```
Pass `publicApiUrl: env.publicApiUrl` in `apps/api/src/server.ts`'s `buildApp({...})`, and `publicApiUrl: "http://test.local/api/v1"` in `apps/api/test/helpers.ts`'s `buildApp({...})`. Also add it to the 5 harness scripts that construct `buildApp` directly (`demo.ts`, `e2e-buy.ts`, `e2e-carbon.ts`, `e2e-tenancy.ts`, `e2e-usecases.ts`) — use `"http://localhost:4000/api/v1"` there. Confirm the full set with `grep -rln "buildApp({" apps/api/src apps/api/test`.

- [ ] **Step 2: Create the credential kinds**

Create `apps/api/src/credential-kinds.ts`:

```typescript
/**
 * Credential proposal kinds: issuing and revoking a Verifiable Credential, both
 * gated by the credential type's own maker-checker depth. These are ORG scoped —
 * unlike token kinds, which are use-case scoped.
 */
import { randomUUID } from "node:crypto";
import { credentialTypeDef, type Actor } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

/** PlatformAdmin, or an OrgAdmin of the proposal's own org. Never null-matches. */
const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export interface IssueCredentialPayload {
  type: string;
  subjectDid: string;
  subjectUserId: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}

export const issueCredentialKind: ProposalKindHandler = {
  kind: "issue-credential",
  canView: orgScopedView,
  // Anyone who may view it may decide it (the routes already exclude the
  // proposer via SELF_APPROVAL). Viewing is limited to PlatformAdmin + the
  // org's own OrgAdmins, which is exactly the approver set.
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueCredentialPayload;
    const def = credentialTypeDef(pl.type);
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");

    // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
    const credentialId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const statusUrl = `${ctx.deps.publicApiUrl}/credentials/${credentialId}/status`;
    const { vcJwt, expiresAt } = ctx.deps.keystore.issueOrgCredential({
      orgEncSeed: org.didSeedEncrypted, orgDid: org.did, subjectDid: pl.subjectDid,
      type: pl.type, claims: pl.claims, credentialId, statusUrl, validityDays: def.validityDays, now,
    });
    await ctx.deps.credentials.create({
      id: credentialId,
      holderDid: pl.subjectDid,
      issuerDid: org.did,
      type: pl.type,
      vcJwt,
      subjectClaims: { id: pl.subjectDid, ...pl.claims },
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: p.id,
    });
  },
};

export interface RevokeCredentialPayload {
  credentialId: string;
  reason: string;
}

export const revokeCredentialKind: ProposalKindHandler = {
  kind: "revoke-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as RevokeCredentialPayload;
    const cred = await ctx.deps.credentials.get(pl.credentialId);
    if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
    if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
    await ctx.deps.credentials.revoke(cred.id, { reason: pl.reason, by: p.proposerId, at: new Date().toISOString() });
  },
};
```

- [ ] **Step 3: Register them**

In `apps/api/src/proposal-kinds.ts`, at the bottom (after the token registrations), add:
```typescript
import { issueCredentialKind, revokeCredentialKind } from "./credential-kinds.js";
registerProposalKind(issueCredentialKind);
registerProposalKind(revokeCredentialKind);
```
If this creates an import cycle (`credential-kinds` imports the `ProposalKindHandler` *type* from `proposal-kinds`), it is type-only and erased at runtime — keep `import type`. Verify with `pnpm --filter @tokenlayer/api exec tsc --noEmit`. If a runtime cycle appears, move the two `registerProposalKind` calls into a small `apps/api/src/register-kinds.ts` imported once from `app.ts`, and report that you did.

- [ ] **Step 4: Typecheck + full suite (no behaviour change yet — no routes create these kinds)**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; 173 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/credential-kinds.ts apps/api/src/proposal-kinds.ts apps/api/src/context.ts apps/api/src/env.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-buy.ts apps/api/src/e2e-carbon.ts apps/api/src/e2e-tenancy.ts apps/api/src/e2e-usecases.ts
git commit -m "feat(api): issue-credential + revoke-credential proposal kinds (org-scoped)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Routes — request, revoke, public status, catalog, org-aware proposals

**Files:**
- Modify: `apps/api/src/http/schemas.ts`
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Schemas**

In `apps/api/src/http/schemas.ts`, add to the `S` object:
```typescript
  credentialTypes: { tags: ["Credentials"], summary: "The credential-type catalog", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  requestCredential: {
    tags: ["Credentials"], summary: "Request a credential (gated by the type's approval depth)", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["type", "subjectUserId", "claims"],
      properties: {
        type: { type: "string" },
        subjectUserId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
        issuerOrgId: { type: "string" },
      },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  revokeCredential: {
    tags: ["Credentials"], summary: "Revoke a credential (gated; reason required)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 1 } } },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409) },
  },
  credentialStatus: {
    tags: ["Credentials"], summary: "Public revocation status of a credential (no auth — verifiers must resolve it)",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(404) },
  },
  orgCredentials: {
    tags: ["Credentials"], summary: "Credentials issued by an organization", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },
```

- [ ] **Step 2: Routes**

In `apps/api/src/http/routes.ts`, add `CREDENTIAL_TYPES`, `credentialTypeDef` and `validateMetadata` to the `@tokenlayer/core` import, and add this section after the organizations section:

```typescript
  // --- credentials ---------------------------------------------------------
  app.get("/credential-types", { schema: S.credentialTypes, ...auth }, async () =>
    Object.values(CREDENTIAL_TYPES).map((d) => ({
      type: d.type, description: d.description, allowedIssuerOrgTypes: d.allowedIssuerOrgTypes,
      requiredApprovals: d.requiredApprovals, validityDays: d.validityDays,
      selfIssuedOnly: !!d.selfIssuedOnly, claimSchema: d.claimSchema,
    })));

  app.post("/credentials/requests", { schema: S.requestCredential, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { type: string; subjectUserId: string; claims: Record<string, unknown>; issuerOrgId?: string };
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only a Platform Admin or an Org Admin may request credentials" });
    }
    // An OrgAdmin may only ever issue as their OWN org — any issuerOrgId in the
    // body is ignored, never honoured (it would be a privilege escalation).
    const issuerOrgId = claims.role === "OrgAdmin" ? claims.orgId : b.issuerOrgId;
    if (!issuerOrgId) return reply.code(400).send({ error: "ISSUER_ORG_REQUIRED", message: "issuerOrgId is required" });
    const org = await deps.organizations.get(issuerOrgId);
    if (!org) return notFound(reply, "issuing organization not found");

    const def = credentialTypeDef(b.type); // throws UNKNOWN_CREDENTIAL_TYPE → 400
    if (!def.allowedIssuerOrgTypes.includes(org.orgType)) {
      return reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: `an org of type '${org.orgType}' may not issue '${def.type}'` });
    }
    const subject = await deps.users.findById(b.subjectUserId);
    if (!subject) return notFound(reply, "subject user not found");
    if (def.selfIssuedOnly && subject.orgId !== org.id) {
      return reply.code(403).send({ error: "SELF_ISSUED_ONLY", message: `'${def.type}' may only be issued to the issuing org's own members` });
    }
    if (!subject.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject has no decentralized identifier" });
    validateMetadata(b.claims, def.claimSchema); // throws PolicyError INVALID_METADATA (with { problems }) → 400

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: org.id, assetId: null, kind: "issue-credential",
      payload: { type: def.type, subjectDid: subject.did, subjectUserId: subject.id, claims: b.claims, issuerOrgId: org.id },
      proposerId: claims.id, proposerLabel: claims.email, required: def.requiredApprovals,
    });
    return reply.code(202).send({ proposal });
  });

  app.post("/credentials/:id/revoke", { schema: S.revokeCredential, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    if (cred.revoked) return reply.code(409).send({ error: "ALREADY_REVOKED", message: "credential is already revoked" });
    // Only the ISSUING org may revoke: find the org whose parent DID signed it.
    const issuer = (await deps.organizations.list()).find((o) => o.did === cred.issuerDid);
    if (!issuer) return notFound(reply, "issuing organization not found");
    if (!orgScoped(claims, issuer.id)) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the issuing organization may revoke this credential" });
    }
    // Depth comes from the credential's OWN type — revoking an AuthorizedSignatory
    // costs the same approvals that issuing it did.
    const def = credentialTypeDef(cred.type);
    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuer.id, assetId: null, kind: "revoke-credential",
      payload: { credentialId: cred.id, reason },
      proposerId: claims.id, proposerLabel: claims.email, required: def.requiredApprovals,
    });
    return reply.code(202).send({ proposal });
  });

  // PUBLIC — a verifier holding only the VC must be able to resolve its status.
  // Returns revocation state ONLY: no claims, no holder, no VC.
  app.get("/credentials/:id/status", { schema: S.credentialStatus }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    return { id: cred.id, revoked: cred.revoked, revokedAt: cred.revokedAt, reason: cred.revokedReason };
  });

  app.get("/orgs/:id/credentials", { schema: S.orgCredentials, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's credentials" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return (await deps.credentials.listByIssuer(org.did)).map((c) => ({
      id: c.id, type: c.type, holderDid: c.holderDid, claims: c.subjectClaims,
      issuedAt: c.issuedAt, expiresAt: c.expiresAt, revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason,
    }));
  });
```

Note `deps.proposals.create` now needs `orgId` — its input type is `Omit<ProposalRecord, "id"|"approvals"|"status"|"error"|"createdAt"|"decidedAt">`, so `orgId` is required at the 3 existing token call sites too. Add `orgId: null` to `proposeIfGated`'s `deps.proposals.create({...})` call (`routes.ts` ~line 107). That is the only token change needed.

- [ ] **Step 3: Make GET /proposals org-aware**

Replace the `GET /proposals` handler:
```typescript
  app.get("/proposals", { schema: S.listProposals, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    const q = request.query as { status?: string; useCaseKey?: string };
    if (claims.role === "PlatformAdmin") return deps.proposals.list(q.useCaseKey, q.status);
    // A caller sees their use-case proposals AND their org's proposals. Both are
    // indexed; the __none__ sentinel keeps an unscoped user from matching every
    // null-useCaseKey (credential) proposal.
    const byUseCase = await deps.proposals.list(claims.useCaseKey ?? NO_USE_CASE, q.status);
    const byOrg = claims.orgId ? await deps.proposals.listByOrg(claims.orgId, q.status) : [];
    const seen = new Set(byUseCase.map((p) => p.id));
    return [...byUseCase, ...byOrg.filter((p) => !seen.has(p.id))];
  });
```

- [ ] **Step 4: Add /me/credentials revocation fields**

In the existing `GET /me/credentials` handler, extend the projection with `revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason` (keep the rest as-is).

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; 173 passing — the token proposal tests must still be green after the `orgId: null` addition.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/api/src/http/routes.ts
git commit -m "feat(api): credential request/revoke routes, public status endpoint, org-aware proposals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: API tests

**Files:**
- Test: `apps/api/test/credential-issuance.test.ts`

- [ ] **Step 1: Write the tests**

Create `apps/api/test/credential-issuance.test.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
let admin: string;
beforeAll(async () => {
  app = await buildTestApp();
  admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
});
afterAll(async () => { await app.close(); });

const createOrg = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: body });
const addMember = (orgId: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: body });
const request = (token: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(token), payload: body });
const approve = (token: string, id: string) =>
  app.inject({ method: "POST", url: `${V1}/proposals/${id}/approve`, headers: auth(token), payload: {} });

/** A verifier org + an OrgAdmin who can request, and a second admin who can approve. */
async function verifierOrg(tag: string) {
  const org = (await createOrg({ name: `Verifier ${tag}`, orgType: "verifier" })).json();
  const a1 = `oa1.${tag}@v.dev`, a2 = `oa2.${tag}@v.dev`;
  const m1 = (await addMember(org.id, { email: a1, password: "orgadmin1", role: "OrgAdmin" })).json();
  const m2 = (await addMember(org.id, { email: a2, password: "orgadmin2", role: "OrgAdmin" })).json();
  const subject = (await addMember(org.id, { email: `subj.${tag}@v.dev`, password: "subject1", role: "Buyer" })).json();
  return { org, m1, m2, subject, t1: await loginAs(app, a1, "orgadmin1"), t2: await loginAs(app, a2, "orgadmin2") };
}

describe("GET /credential-types", () => {
  it("returns the catalog with schemas and approval depth", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credential-types`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const types = res.json() as { type: string; requiredApprovals: number; claimSchema: unknown }[];
    expect(types.map((t) => t.type).sort()).toEqual(["AccreditedInvestor", "AuthorizedSignatory", "KycCredential"]);
    expect(types.find((t) => t.type === "AuthorizedSignatory")!.requiredApprovals).toBe(2);
    expect(types.find((t) => t.type === "KycCredential")!.claimSchema).toBeTruthy();
  });
});

describe("issue a credential through the approval chain", () => {
  it("request → approve → a VC that verifies against the ISSUER ORG's DID", async () => {
    const { org, subject, t1, t2 } = await verifierOrg("iss");
    const req = await request(t1, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya R", country: "IN" } });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal;
    expect(proposal.kind).toBe("issue-credential");
    expect(proposal.required).toBe(1);

    const ok = await approve(t2, proposal.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().proposal.status).toBe("executed");

    const subjToken = await loginAs(app, subject.email, "subject1");
    const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjToken) })).json();
    const kyc = creds.find((c: { type: string[] }) => c.type.includes("KycCredential"));
    expect(kyc).toBeTruthy();
    expect(kyc.revoked).toBe(false);

    // The VC verifies against the org's parent DID, derived from the DID string alone.
    expect(verifyJwtSignature(kyc.vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    const { payload } = decodeJwt(kyc.vcJwt);
    const vc = payload.vc as { type: string[]; credentialSubject: { id: string; country: string }; credentialStatus: { id: string; type: string } };
    expect(payload.iss).toBe(org.did);
    expect(vc.credentialSubject.id).toBe(subject.did);
    expect(vc.credentialSubject.country).toBe("IN");
    expect(payload.jti).toBe(kyc.id);                       // jti === the credential id
    expect(vc.credentialStatus.id).toContain(`/credentials/${kyc.id}/status`);
    expect(vc.credentialStatus.type).toBe("SimpleRevocationStatus2024");
  });

  it("AuthorizedSignatory needs TWO distinct approvers", async () => {
    const { org, t1, t2 } = await verifierOrg("two");
    const subject = (await addMember(org.id, { email: `sig.two@v.dev`, password: "subject1", role: "Issuer" })).json();
    const proposal = (await request(t1, { type: "AuthorizedSignatory", subjectUserId: subject.id, claims: { role: "CFO", scope: "treasury" } })).json().proposal;
    expect(proposal.required).toBe(2);

    const first = await approve(t2, proposal.id);
    expect(first.statusCode).toBe(200);
    expect(first.json().proposal.status).toBe("pending"); // one approval is not enough

    const second = await approve(admin, proposal.id);      // PlatformAdmin is the 2nd
    expect(second.json().proposal.status).toBe("executed");
  });

  it("the proposer may not approve their own request", async () => {
    const { subject, t1 } = await verifierOrg("self");
    const proposal = (await request(t1, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "A", country: "IN" } })).json().proposal;
    const res = await approve(t1, proposal.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SELF_APPROVAL");
  });
});

describe("issuance guards", () => {
  it("403s an org whose orgType may not issue the type", async () => {
    const org = (await createOrg({ name: "Corp NoIssue", orgType: "corporate" })).json();
    const email = "oa.corp@c.dev";
    const subject = (await addMember(org.id, { email: "s.corp@c.dev", password: "subject1", role: "Buyer" })).json();
    await addMember(org.id, { email, password: "orgadmin1", role: "OrgAdmin" });
    const t = await loginAs(app, email, "orgadmin1");
    const res = await request(t, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "A", country: "IN" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ISSUER_NOT_PERMITTED");
  });

  it("400s claims that fail the type's schema", async () => {
    const { subject, t1 } = await verifierOrg("bad");
    const missing = await request(t1, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "A" } });
    expect(missing.statusCode).toBe(400);
    const badPattern = await request(t1, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "A", country: "INDIA" } });
    expect(badPattern.statusCode).toBe(400);
  });

  it("400s an unknown credential type", async () => {
    const { subject, t1 } = await verifierOrg("unk");
    const res = await request(t1, { type: "NopeCredential", subjectUserId: subject.id, claims: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_CREDENTIAL_TYPE");
  });
});

describe("cross-org isolation (the null-useCaseKey trap)", () => {
  it("an OrgAdmin of another org can neither see nor approve the proposal", async () => {
    const a = await verifierOrg("orgA");
    const b = await verifierOrg("orgB");
    const proposal = (await request(a.t1, { type: "KycCredential", subjectUserId: a.subject.id, claims: { legalName: "A", country: "IN" } })).json().proposal;

    // Org B's admin also has useCaseKey === null — must NOT match org A's proposal.
    const list = (await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(b.t1) })).json();
    expect(list.some((p: { id: string }) => p.id === proposal.id)).toBe(false);

    const res = await approve(b.t1, proposal.id);
    expect(res.statusCode).toBe(404); // not even acknowledged as existing
  });
});

describe("revocation", () => {
  it("revoke is gated, requires a reason, and flips the public status endpoint", async () => {
    const { subject, t1, t2 } = await verifierOrg("rev");
    const proposal = (await request(t1, { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "A", country: "IN" } })).json().proposal;
    await approve(t2, proposal.id);
    const subjToken = await loginAs(app, subject.email, "subject1");
    const cred = ((await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjToken) })).json() as { id: string; type: string[] }[])
      .find((c) => c.type.includes("KycCredential"))!;

    // Public status BEFORE revocation — reachable with NO token.
    const before = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` });
    expect(before.statusCode).toBe(200);
    expect(before.json().revoked).toBe(false);

    const noReason = await app.inject({ method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(t1), payload: {} });
    expect(noReason.statusCode).toBe(400);

    const rev = await app.inject({ method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(t1), payload: { reason: "document expired" } });
    expect(rev.statusCode).toBe(202);
    const done = await approve(t2, rev.json().proposal.id);
    expect(done.json().proposal.status).toBe("executed");

    const after = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` });
    expect(after.json().revoked).toBe(true);
    expect(after.json().reason).toBe("document expired");
    // The public status endpoint leaks nothing but revocation state.
    expect(after.json().claims).toBeUndefined();
    expect(after.json().vcJwt).toBeUndefined();
  });

  it("404s the status of an unknown credential", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/nope/status` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/credential-issuance.test.ts`
Expected: PASS (12 tests). Debug the implementation, not the test, if any fail.

Note: `verifierOrg` returns `subject` from `POST /orgs/:id/users`, whose response includes `email` and `did` (see #1's member route). If `subject.email` is absent, use the literal address you passed in.

- [ ] **Step 3: THE GATE — full suite, token tests unchanged**

Run: `pnpm --filter @tokenlayer/api exec vitest run`
Expected: 173 + 12 = 185 passing, with `approvals.test.ts` still untouched.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/credential-issuance.test.ts
git commit -m "test(api): credential issuance, approval depth, isolation + revocation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Web — approvals inbox + issuance/revocation UI

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Modify: `apps/web/src/components/ApprovalsPanel.tsx`
- Create: `apps/web/src/components/CredentialsPanel.tsx`
- Modify: `apps/web/src/components/Organizations.tsx`, `apps/web/src/components/MyIdentity.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/PlatformHome.tsx`

**MANDATORY PREP:** read `apps/web/src/components/ui.tsx` for the REAL primitives before writing any component. They are `Pill` (tones `"ok" | "warn" | "danger" | "info" | "muted"`), `Card` (`{title?, description?, actions?, className?, children}`), `SectionHeader` (`{title, description?, actions?}`), `EmptyState` (`{icon?, title, hint?, action?}`), `Skeleton`. **There is no `Button`** — the codebase uses plain `<button className="rounded-lg bg-brand-600 …">` and `className="input"` / `"select"` form controls. Do not invent primitives.

- [ ] **Step 1: Types**

In `apps/web/src/types.ts`:
- `Proposal.useCaseKey` → `string | null`; add `orgId?: string | null`.
- `HeldCredential` — add `revoked: boolean; revokedAt: string | null; revokedReason: string | null;` (if `revoked` is already present, add the other two).
- Append:
```typescript
export interface CredentialTypeInfo {
  type: string;
  description: string;
  allowedIssuerOrgTypes: string[];
  requiredApprovals: number;
  validityDays: number;
  selfIssuedOnly: boolean;
  claimSchema: { type: "object"; required?: string[]; properties: Record<string, { type: string; description?: string; enum?: string[]; pattern?: string; min?: number; max?: number }> };
}
export interface IssuedCredential {
  id: string;
  type: string;
  holderDid: string;
  claims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
}
```

- [ ] **Step 2: Client**

In `apps/web/src/api.ts`, import the new types and add to the `api` object:
```typescript
  credentialTypes: (token: string) => request<CredentialTypeInfo[]>("/credential-types", token),
  requestCredential: (token: string, body: { type: string; subjectUserId: string; claims: Record<string, unknown>; issuerOrgId?: string }) =>
    request<{ proposal: Proposal }>("/credentials/requests", token, { method: "POST", body: JSON.stringify(body) }),
  orgCredentials: (token: string, orgId: string) => request<IssuedCredential[]>(`/orgs/${encodeURIComponent(orgId)}/credentials`, token),
  revokeCredential: (token: string, id: string, reason: string) =>
    request<{ proposal: Proposal }>(`/credentials/${encodeURIComponent(id)}/revoke`, token, { method: "POST", body: JSON.stringify({ reason }) }),
```

- [ ] **Step 3: Make ApprovalsPanel scope-agnostic and mount it**

In `apps/web/src/components/ApprovalsPanel.tsx`:
- Change the signature to `export function ApprovalsPanel({ onChanged }: { onChanged?: () => void }): JSX.Element` — drop the `useCase` prop and the `UseCase` import, and change the effect dep from `[reload, useCase.key]` to `[reload]`.
- Add credential arms at the TOP of `summarize()` (before the `issue` arm):
```typescript
  if (p.kind === "issue-credential") return `issue a ${String(pl.type ?? "credential")} to ${String((pl.claims as Record<string, unknown>)?.legalName ?? pl.subjectDid ?? "a subject")}`;
  if (p.kind === "revoke-credential") return `revoke a credential — ${String(pl.reason ?? "no reason given")}`;
```
- Guard the optional callback: replace `onChanged()` calls with `onChanged?.()`.

Mount it in both consoles:
- `apps/web/src/App.tsx`: add `"approvals"` to the `Section` union, an `{ id: "approvals", label: "Approvals" }` nav entry, and the branch `{section === "approvals" && <ApprovalsPanel />}` (import it).
- `apps/web/src/components/PlatformHome.tsx`: add `"approvals"` to its `Tab` union, a tab entry after Organizations, and `{tab === "approvals" && <ApprovalsPanel />}`.

- [ ] **Step 4: CredentialsPanel**

Create `apps/web/src/components/CredentialsPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { CredentialTypeInfo, IssuedCredential, Organization, OrgMember } from "../types.js";
import { Card, Pill } from "./ui.js";

/** Issue + revoke credentials for one org. Claim inputs render from the type's schema. */
export function CredentialsPanel({ org, members }: { org: Organization; members: OrgMember[] }): JSX.Element {
  const { token } = useAuth();
  const [types, setTypes] = useState<CredentialTypeInfo[]>([]);
  const [issued, setIssued] = useState<IssuedCredential[]>([]);
  const [type, setType] = useState("");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.orgCredentials(token, org.id).then(setIssued).catch((e) => setErr(e.message)); };
  useEffect(() => { if (token) void api.credentialTypes(token).then(setTypes).catch(() => setTypes([])); }, [token]);
  useEffect(reload, [token, org.id]);

  // Only types this org's orgType may actually issue.
  const issuable = types.filter((t) => t.allowedIssuerOrgTypes.includes(org.orgType));
  const selected = issuable.find((t) => t.type === type) ?? null;

  async function submit(): Promise<void> {
    if (!token || !selected || !subjectUserId) { setErr("pick a credential type and a subject"); return; }
    setErr(null); setNotice(null);
    try {
      const res = await api.requestCredential(token, { type: selected.type, subjectUserId, claims, issuerOrgId: org.id });
      setNotice(`Requested — ${res.proposal.required} approval(s) needed before it is issued.`);
      setClaims({}); setSubjectUserId("");
      reload();
    } catch (e) { setErr((e as Error).message); }
  }

  async function revoke(c: IssuedCredential): Promise<void> {
    const reason = window.prompt("Reason for revoking this credential?");
    if (!token || !reason) return;
    setErr(null); setNotice(null);
    try {
      const res = await api.revokeCredential(token, c.id, reason);
      setNotice(`Revocation requested — ${res.proposal.required} approval(s) needed.`);
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="space-y-5">
      <Card title="Issue a credential" description="Issued by this organization's DID once approved.">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        {notice && <div className="text-sm text-emerald-600 mb-2">{notice}</div>}
        {issuable.length === 0 && <div className="text-sm text-slate-500">An organization of type “{org.orgType}” may not issue any credential type.</div>}
        {issuable.length > 0 && (
          <>
            <div className="grid gap-2 md:grid-cols-2">
              <select className="select" value={type} onChange={(e) => { setType(e.target.value); setClaims({}); }}>
                <option value="">Select a credential type…</option>
                {issuable.map((t) => <option key={t.type} value={t.type}>{t.type} · {t.requiredApprovals} approval(s)</option>)}
              </select>
              <select className="select" value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)}>
                <option value="">Select a subject…</option>
                {members.filter((m) => m.did).map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select>
            </div>
            {selected && (
              <>
                <div className="text-xs text-slate-500 mt-2">{selected.description}</div>
                <div className="grid gap-2 md:grid-cols-2 mt-3">
                  {Object.entries(selected.claimSchema.properties).map(([field, spec]) => {
                    const required = selected.claimSchema.required?.includes(field);
                    return spec.enum ? (
                      <select key={field} className="select" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })}>
                        <option value="">{field}{required ? " *" : ""}</option>
                        {spec.enum.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input key={field} className="input" placeholder={`${field}${required ? " *" : ""} — ${spec.description ?? ""}`}
                        value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })} />
                    );
                  })}
                </div>
                <button className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white" onClick={submit}>Request credential</button>
              </>
            )}
          </>
        )}
      </Card>

      <Card title="Issued credentials" description="Credentials this organization has issued.">
        {issued.length === 0 && <div className="text-sm text-slate-500">None issued yet.</div>}
        <div className="space-y-2">
          {issued.map((c) => (
            <div key={c.id} className="flex items-center justify-between border border-slate-100 rounded-lg p-3">
              <div>
                <div className="font-medium">{c.type}</div>
                <div className="text-xs font-mono text-slate-400" title={c.holderDid}>{c.holderDid.slice(0, 18)}…</div>
                <div className="text-xs text-slate-500">
                  Issued {c.issuedAt.slice(0, 10)}{c.revokedReason ? ` · revoked: ${c.revokedReason}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={c.revoked ? "muted" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
                {!c.revoked && <button className="text-sm text-rose-600" onClick={() => revoke(c)}>Revoke</button>}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
```

If `ui.tsx`'s `Card` does not accept `title`/`description`, render those as plain markup instead — match the file's real API.

- [ ] **Step 5: Wire CredentialsPanel into Organizations**

In `apps/web/src/components/Organizations.tsx`, import `CredentialsPanel` and render it under the Members table for the selected org, passing the org and the already-loaded members. The `Members` sub-component owns the member list, so lift `members` into a state the panel can share, or render `<CredentialsPanel org={current} members={members} />` from inside `Members` beneath its table — whichever the file's real structure makes cleaner. Read it first.

- [ ] **Step 6: MyIdentity revoked state**

In `apps/web/src/components/MyIdentity.tsx`, the credential pill already renders `c.revoked ? "revoked" : "valid"`. Add the reason under the dates when present:
```tsx
              {c.revokedReason && <div className="text-xs text-rose-600 mt-0.5">Revoked: {c.revokedReason}</div>}
```

- [ ] **Step 7: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): approvals inbox mounted + credential issuance/revocation UI

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Verify — full suite, live E2E, browser, merge

**Files:**
- Create: `scripts/credential-issuance-e2e.mjs`

- [ ] **Step 1: Write the E2E**

Create `scripts/credential-issuance-e2e.mjs`:

```javascript
// End-to-end: a verifier org issues a KycCredential to a member through the real
// maker-checker chain; a 2-approval AuthorizedSignatory; the VC is verified
// INDEPENDENTLY against the issuer's DID; revocation flips the public status
// endpoint; cross-org isolation and self-approval are enforced.
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

console.log("== 1) A verifier org with two OrgAdmins + a subject ==");
const org = (await call("POST", "/orgs", { name: `KYC Verifier ${runId}`, orgType: "verifier" }, platform)).json;
const mk = async (email, role, pw) => (await call("POST", `/orgs/${org.id}/users`, { email, password: pw, role }, platform)).json;
const a1 = `oa1.${runId}@kv.dev`, a2 = `oa2.${runId}@kv.dev`, sub = `subject.${runId}@kv.dev`;
await mk(a1, "OrgAdmin", "orgadmin1"); await mk(a2, "OrgAdmin", "orgadmin2");
const subject = await mk(sub, "Buyer", "subject1");
const t1 = await login(a1, "orgadmin1"), t2 = await login(a2, "orgadmin2");
ok(org?.did && subject?.did && t1 && t2, `verifier org ${org?.did?.slice(0, 20)}… with 2 admins + a subject`, { org: org?.did });

console.log("\n== 2) Request a KycCredential (maker) ==");
const req = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya Raman", country: "IN" } }, t1);
ok(req.status === 202 && req.json?.proposal?.kind === "issue-credential", "request captured as a gated proposal (202)", req.json);
const selfApprove = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t1);
ok(selfApprove.status === 403, "the maker cannot approve their own request (403 SELF_APPROVAL)", selfApprove.json);

console.log("\n== 3) Approve (checker) → the VC is issued ==");
const done = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t2);
ok(done.json?.proposal?.status === "executed", "second admin approved → executed", done.json);
const subjTok = await login(sub, "subject1");
const creds = (await call("GET", "/me/credentials", null, subjTok)).json ?? [];
const kyc = creds.find((c) => c.type.includes("KycCredential"));
ok(kyc && kyc.claims.country === "IN", "subject holds the KycCredential", creds);
ok(kyc?.issuerDid === org.did, "issued BY the verifier org's parent DID", { iss: kyc?.issuerDid });

console.log("\n== 4) AuthorizedSignatory needs TWO approvals ==");
const sig = await call("POST", "/credentials/requests", { type: "AuthorizedSignatory", subjectUserId: subject.id, claims: { role: "CFO", scope: "treasury" } }, t1);
ok(sig.json?.proposal?.required === 2, "AuthorizedSignatory requires 2 approvals", sig.json?.proposal);
const one = await call("POST", `/proposals/${sig.json.proposal.id}/approve`, {}, t2);
ok(one.json?.proposal?.status === "pending", "one approval is NOT enough — still pending", one.json?.proposal);
const two = await call("POST", `/proposals/${sig.json.proposal.id}/approve`, {}, platform);
ok(two.json?.proposal?.status === "executed", "second approval issued it", two.json?.proposal);

console.log("\n== 5) Public status + revocation ==");
const before = await call("GET", `/credentials/${kyc.id}/status`, null, null); // NO token
ok(before.status === 200 && before.json?.revoked === false, "status endpoint is public and reports not-revoked", before.json);
const noReason = await call("POST", `/credentials/${kyc.id}/revoke`, {}, t1);
ok(noReason.status === 400, "revocation without a reason is rejected (400)", noReason.json);
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "document expired" }, t1);
ok(rev.status === 202, "revocation captured as a gated proposal (202)", rev.json);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, t2);
const after = await call("GET", `/credentials/${kyc.id}/status`, null, null);
ok(after.json?.revoked === true && after.json?.reason === "document expired", "status flipped to revoked with the reason", after.json);
ok(after.json?.claims === undefined && after.json?.vcJwt === undefined, "the public status leaks no claims and no VC");

console.log("\n== 6) Cross-org isolation ==");
const orgB = (await call("POST", "/orgs", { name: `Rival ${runId}`, orgType: "verifier" }, platform)).json;
const bEmail = `oab.${runId}@rival.dev`;
// NB: `mk` closes over org A — create org B's admin against orgB.id explicitly.
await call("POST", `/orgs/${orgB.id}/users`, { email: bEmail, password: "orgadmin1", role: "OrgAdmin" }, platform);
const tB = await login(bEmail, "orgadmin1");
const req2 = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "X", country: "IN" } }, t1);
const listB = (await call("GET", "/proposals", null, tB)).json ?? [];
ok(!listB.some((p) => p.id === req2.json.proposal.id), "a rival OrgAdmin cannot SEE org A's credential proposal (the null-useCaseKey trap)", listB.map((p) => p.id));
const approveB = await call("POST", `/proposals/${req2.json.proposal.id}/approve`, {}, tB);
ok(approveB.status === 404, "a rival OrgAdmin cannot approve it (404)", approveB.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ CREDENTIAL ISSUANCE END-TO-END PASSED — gated issuance, per-type depth, SoD, public status, revocation, cross-org isolation"}`);
process.exit(fails ? 1 : 0);
```

Note: `mk` is a helper bound to org A, so org B's admin is created with an explicit `POST /orgs/${orgB.id}/users` — don't reuse `mk` there.

- [ ] **Step 2: Full monorepo build + test**

Run: `pnpm -r build && pnpm -r test`
Expected: core 141+8=149, adapters 42, contracts 20, api 185. All green.

- [ ] **Step 3: Boot + run the live E2E**

```bash
pkill -f "tsx watch src/server.ts"; rm -f apps/api/cred-e2e.db
# The scratch DB must be pushed BEFORE boot or the server dies with P2021 (no tables).
DATABASE_URL="file:./cred-e2e.db" pnpm --filter @tokenlayer/api exec prisma db push --skip-generate
# LOGIN_RATE_LIMIT_MAX: the default throttle is 10 logins/IP/15min and this E2E makes
# ~6 (plus re-runs), which is close enough to fail intermittently. Raise it for the run.
DATABASE_URL="file:./cred-e2e.db" JWT_SECRET="dev-secret-cred-e2e-testing" PORT=4000 \
  NODE_ENV=development CHAIN_STRICT=0 LOGIN_RATE_LIMIT_MAX=1000 pnpm api:dev &
sleep 25
node scripts/credential-issuance-e2e.mjs
```
Expected: `✅ CREDENTIAL ISSUANCE END-TO-END PASSED`. If you see `429 TOO_MANY_REQUESTS`, the throttle env var didn't take — restart the API (the counter is in-memory, per instance).

- [ ] **Step 4: Independent verification proof**

Prove a third party can verify an issued VC using only the org's public DID — copy this into `apps/api/` (which resolves `@tokenlayer/core`) and run it with `pnpm exec tsx`, then delete it:
```typescript
import { publicKeyFromDidKey, verifyJwtSignature, decodeJwt } from "@tokenlayer/core";
const API = "http://localhost:4000/api/v1";
const call = async (m, p, b, t) => { const r = await fetch(API+p,{method:m,headers:{...(b?{"Content-Type":"application/json"}:{}),...(t?{Authorization:`Bearer ${t}`}:{})},body:b?JSON.stringify(b):undefined}); return {status:r.status,json:await r.json().catch(()=>null)}; };
const login = async (e,p) => (await call("POST","/auth/login",{email:e,password:p})).json?.token;
const platform = await login("admin@tokenlayer.dev","admin123");
const id = String(Date.now()).slice(-6);
const org = (await call("POST","/orgs",{name:`ProofV ${id}`,orgType:"verifier"},platform)).json;
const a1 = `p1.${id}@v.io`, a2 = `p2.${id}@v.io`, s = `ps.${id}@v.io`;
await call("POST",`/orgs/${org.id}/users`,{email:a1,password:"orgadmin1",role:"OrgAdmin"},platform);
await call("POST",`/orgs/${org.id}/users`,{email:a2,password:"orgadmin2",role:"OrgAdmin"},platform);
const subject = (await call("POST",`/orgs/${org.id}/users`,{email:s,password:"subject1",role:"Buyer"},platform)).json;
const t1 = await login(a1,"orgadmin1"), t2 = await login(a2,"orgadmin2");
const req = (await call("POST","/credentials/requests",{type:"KycCredential",subjectUserId:subject.id,claims:{legalName:"Proof P",country:"IN"}},t1)).json;
await call("POST",`/proposals/${req.proposal.id}/approve`,{},t2);
const vc = ((await call("GET","/me/credentials",null,await login(s,"subject1"))).json ?? []).find((c) => c.type.includes("KycCredential"));
const pub = publicKeyFromDidKey(org.did);                       // from the DID string ALONE
const { payload } = decodeJwt(vc.vcJwt);
console.log("sig verifies against issuer DID:", verifyJwtSignature(vc.vcJwt, pub));
console.log("iss === org parent DID        :", payload.iss === org.did);
console.log("subject bound                 :", payload.vc.credentialSubject.id === subject.did);
console.log("jti === credential id         :", payload.jti === vc.id);
console.log("tamper rejected               :", !verifyJwtSignature(vc.vcJwt.slice(0,-4)+"AAAA", pub));
const st = await fetch(`${API}/credentials/${vc.id}/status`).then((r) => r.json());
console.log("public status resolves        :", st.revoked === false);
```
All six lines must print `true`.

- [ ] **Step 5: Browser pass**

`preview_start` the `web` config, sign in as `admin@tokenlayer.dev`/`admin123`. On the platform landing page: **Organizations** → create/select a verifier org → add two OrgAdmins + a subject → issue a KycCredential (the claim form renders from the schema) → the **Approvals** tab shows it with a readable summary → approve as the other admin → it executes. Open the subject's **My identity** and see the credential. Revoke it and see the pill flip. Screenshot as proof.

- [ ] **Step 6: Cleanup + merge**

```bash
pkill -f "tsx watch src/server.ts"; rm -f apps/api/cred-e2e.db
git status --short   # must be clean apart from the E2E script
git add scripts/credential-issuance-e2e.mjs
git commit -m "test(e2e): live credential issuance, approval depth + revocation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Then use the **superpowers:finishing-a-development-branch** skill. Confirm the merge with the user.

---

## Self-Review

**1. Spec coverage:**
- Registry (3 types, claim schemas, allowedIssuerOrgTypes, requiredApprovals, validityDays, selfIssuedOnly) → Task 1. ✓
- `OrgType` moved to core → Task 1 Step 3. ✓
- Proposal refactor (canView/canApprove/execute + the **compensate** seam the spec missed) → Task 2. ✓
- `useCaseKey` nullable + `orgId` + `listByOrg` + indexes → Task 3. ✓
- Credential revocation columns + explicit id + `revoke`/`listByIssuer` → Task 3. ✓
- `issueOrgCredential` + honest `SimpleRevocationStatus2024` + membership wrapper untouched → Task 4. ✓
- id-before-signing (jti + status URL) → Task 4 + Task 5's executor. ✓
- Credential kinds, org-scoped → Task 5. ✓
- Routes: `/credential-types`, `POST /credentials/requests` (with the full guard order + the ignored-issuerOrgId rule), `POST /credentials/:id/revoke` (issuing org only, depth from the credential's own type), **public** `GET /credentials/:id/status`, `GET /orgs/:id/credentials`, org-aware `GET /proposals`, `/me/credentials` revocation fields → Task 6. ✓
- Tests incl. the regression gate → Tasks 2, 7. ✓ E2E + browser → Task 9. ✓
- Web: ApprovalsPanel mounted + scope-agnostic, issuance form from schema, revoke, MyIdentity → Task 8. ✓
- Out-of-scope items (compliance consumption, on-chain, #3 flows) → no tasks, correctly. ✓

**2. Placeholder scan:** No TBD/TODO. Steps that say "read the file first" (memory `list` ordering, prisma mappers, `ui.tsx` primitives, `Organizations.tsx` structure) are read-then-edit instructions with the exact change specified, not deferrals. Every code block is intended to be copied as-is.

**3. Type consistency:** `ProposalKindHandler`/`KindContext`/`KindLogger` (Task 2) match their use in `credential-kinds.ts` (Task 5). `proposalKind()`/`registerProposalKind()`/`allProposalKinds()` named consistently. `credentialTypeDef`/`CREDENTIAL_TYPES`/`CredentialTypeDefinition` (Task 1) match Tasks 5–6. `OrgCredentialInput` fields (`orgEncSeed`, `orgDid`, `subjectDid`, `type`, `claims`, `credentialId`, `statusUrl`, `validityDays`, `now`) are identical in Task 4's interface, Task 4's test, and Task 5's caller. `CredentialRecord.create(input)` takes the full record incl. `id` in Task 3 and is called that way in Tasks 3 (membership) and 5. `publicApiUrl` flows env→AppDeps→executor (Task 5). Web `CredentialTypeInfo`/`IssuedCredential` (Task 8 Step 1) match the client (Step 2) and `CredentialsPanel` (Step 4).

**Known deviation from the spec, recorded deliberately:** the spec's `ProposalKindHandler` had three methods; the real `decide()` also carries issue-specific compensation (`refundIssuanceFee` on reject/inactive/failure, plus flipping the asset to `rejected`). Task 2 therefore adds a fourth `compensate(ctx, p, reason)` seam. Without it that logic could not leave `routes.ts` and the refactor would not be behaviour-preserving.
