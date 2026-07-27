# ID-B — Issuer/Holder/Verifier Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ID-A `CredentialUseCase` config *live* — a bound Issuer issues a configured credential type to an eligible Holder (via maker-checker), the Holder holds it, and a bound Verifier requests + verifies it (extending the existing VP flow).

**Architecture:** A config-driven runtime layered on the existing DID/VC primitives — no parallel machinery. Core gains pure resolver/binding predicates + a per-type approval depth; the API gains an issuance route + one new org-scoped proposal kind + an eligible-holders read + a verification-request extension; web gains an "Issue credential" surface (Identity opened to OrgAdmins) + a use-case picker on verification. The runtime resolves the credential type's `claimSchema`/`validityDays`/`requiredApprovals` from the **use case** (not the closed `CREDENTIAL_TYPES` catalog) and enforces the Issuer/Holder/Verifier bindings.

**Tech Stack:** packages/core (pure TS), apps/api (Fastify + Prisma/SQLite + Vitest), apps/web (React + Vite + Tailwind). Spec: `docs/superpowers/specs/2026-07-27-identity-issuer-holder-verifier-runtime-design.md`.

**Branch:** create `feat/identity-issuer-holder-verifier-runtime` off `main` before Task 1.

## Verified contracts (grounded in current code — do not re-derive)

- **Primitive** `issueCredentialFor(deps, { issuerOrg, subjectDid, type, claims, proposalId })` in `apps/api/src/credential-issuance.ts` currently calls `credentialTypeDef(a.type)` for `validityDays` — this THROWS `UNKNOWN_CREDENTIAL_TYPE` for a use-case type absent from the closed catalog. Task 2 generalizes it to take an explicit `validityDays` + optional `credentialUseCaseKey`. Two existing callers: `issueCredentialKind.execute` (`apps/api/src/credential-kinds.ts:32`) and `onboardUserKind.execute` (`apps/api/src/user-kinds.ts:67`).
- **Proposal kind pattern**: a module exports a `ProposalKindHandler`, imported into `apps/api/src/proposal-kinds.ts` and registered via `registerProposalKind(...)` at the bottom. Credential kinds are **org-scoped** (`orgScopedView` = PlatformAdmin || OrgAdmin of `p.orgId`). `ProposalRecord.useCaseKey` and `.orgId` are both `string | null`; the new kind keys off `orgId` (issuer org) and carries the credential-use-case key in the payload (exactly like `issue-credential`).
- **Persistence**: memory repos `create` by spreading `{ ...input }` → a new record field flows automatically. Prisma repos (`toCredential`/`toVerificationRequest` mappers + `create` `data:` blocks in `apps/api/src/persistence/prisma.ts`) list fields individually → each needs the new field added explicitly. The DB uses `prisma db push` (NOT migrations): after editing `schema.prisma`, run `cd apps/api && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`.
- **AppDeps construction sites** that must keep compiling when repos gain no new dependencies (they don't here — only record fields change): `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, plus the harness scripts `apps/api/src/{demo,e2e-buy,e2e-carbon,e2e-tenancy,e2e-usecases}.ts`. These need NO edits in this plan (no new AppDeps field is added).
- **Route prefix**: all routes are under `/api/v1` (registered in `apps/api/src/app.ts`). Tests use `V1` + `auth()` + `loginAs()` from `apps/api/test/helpers.ts`.
- **Platform issuer org**: seeded at boot; read by `deps.organizations.findByName(PLATFORM_ORG_NAME)` (`PLATFORM_ORG_NAME` from `apps/api/src/platform-org.js`). PlatformAdmins have `claims.orgId === null` (tenancy org null) but still operate the platform issuer org.
- **Web claims form**: there is NO shared `MetadataSchema` renderer. `apps/web/src/components/CredentialsPanel.tsx` (the `IssueCredential` sub-component, ~lines 168-195) renders `claimSchema.properties` inline (enum → `<select>`, else `<input>`) — copy that block for the new issue form. The existing subject picker sources DID-holding users from `api.orgMembers`; ID-B adds a purpose-built eligible-holders route instead.
- **Web nav**: `IdentityHome` is rendered for PlatformAdmin via `PlatformHome` (`view === "identity"`). The OrgAdmin/operator-console branch in `App.tsx` (~line 121+) has NO identity entry — Task 5 adds one there (mirroring the `organizations`/`verify` conditional spreads) + an `IdentityHome` panel branch.

## Seed data note
The dev DB may contain ID-A-era credential use cases (`emp-badges`, `contractor-passes`) without `requiredApprovals`. That is fine: `credentialUseCaseType` defaults a missing value to 1, and `validateCredentialUseCase` only runs on create/PATCH (not read). No data backfill is required.

---

## Task 1: Core — approval depth + resolver + binding predicates

**Files:**
- Modify: `packages/core/src/credential-use-cases.ts`
- Test: `packages/core/test/credential-use-cases.test.ts` (append)

- [ ] **Step 1: Write failing tests** — append to `packages/core/test/credential-use-cases.test.ts`:

```ts
import {
  credentialUseCaseType, issuerBindingAllows, holderPolicyAllows, verifierBindingAllows,
  type CredentialUseCaseDefinition,
} from "../src/credential-use-cases.js";

const baseDef: CredentialUseCaseDefinition = {
  key: "kyc", name: "KYC", credentialTypes: [
    { name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 2,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } },
  ],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("credentialUseCaseType", () => {
  it("resolves a type by name", () => {
    expect(credentialUseCaseType(baseDef, "KycCredential").requiredApprovals).toBe(2);
  });
  it("throws UNKNOWN_CREDENTIAL_TYPE for an absent type", () => {
    expect(() => credentialUseCaseType(baseDef, "Nope")).toThrow(/unknown credential type/i);
  });
  it("defaults a missing requiredApprovals to 1", () => {
    const def = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: undefined as unknown as number }] };
    expect(credentialUseCaseType(def, "KycCredential").requiredApprovals).toBe(1);
  });
});

describe("issuerBindingAllows", () => {
  it("lets a PlatformAdmin act as any bound issuer", () => {
    expect(issuerBindingAllows({ kind: "platform" }, { callerOrgId: null, isPlatformAdmin: true })).toBe(true);
    expect(issuerBindingAllows({ kind: "org", orgId: "o1" }, { callerOrgId: null, isPlatformAdmin: true })).toBe(true);
  });
  it("lets an OrgAdmin issue only for their own org binding", () => {
    expect(issuerBindingAllows({ kind: "org", orgId: "o1" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(true);
    expect(issuerBindingAllows({ kind: "org", orgId: "o2" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(false);
    expect(issuerBindingAllows({ kind: "platform" }, { callerOrgId: "o1", isPlatformAdmin: false })).toBe(false);
  });
});

describe("holderPolicyAllows", () => {
  it("any-onboarded accepts anyone including a null org", () => {
    expect(holderPolicyAllows({ who: "any-onboarded" }, null)).toBe(true);
    expect(holderPolicyAllows({ who: "any-onboarded" }, { id: "o1", orgType: "corporate" })).toBe(true);
  });
  it("orgType requires a matching org", () => {
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["corporate"] }, { id: "o1", orgType: "corporate" })).toBe(true);
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["bank"] }, { id: "o1", orgType: "corporate" })).toBe(false);
    expect(holderPolicyAllows({ who: "orgType", orgTypes: ["corporate"] }, null)).toBe(false);
  });
  it("specific requires the org id to be listed", () => {
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o1"] }, { id: "o1", orgType: "corporate" })).toBe(true);
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o2"] }, { id: "o1", orgType: "corporate" })).toBe(false);
    expect(holderPolicyAllows({ who: "specific", orgIds: ["o1"] }, null)).toBe(false);
  });
});

describe("verifierBindingAllows", () => {
  it("any accepts any org; orgs restricts to the list", () => {
    expect(verifierBindingAllows({ kind: "any" }, "vX")).toBe(true);
    expect(verifierBindingAllows({ kind: "orgs", orgIds: ["v1"] }, "v1")).toBe(true);
    expect(verifierBindingAllows({ kind: "orgs", orgIds: ["v1"] }, "v2")).toBe(false);
  });
});

describe("validateCredentialUseCase requiredApprovals", () => {
  it("rejects a present-but-invalid requiredApprovals", () => {
    const bad = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: 0 }] };
    expect(() => validateCredentialUseCase(bad, { orgExists: () => true })).toThrow(/requiredApprovals/i);
  });
  it("accepts a missing requiredApprovals (defaults later)", () => {
    const ok = { ...baseDef, credentialTypes: [{ ...baseDef.credentialTypes[0]!, requiredApprovals: undefined as unknown as number }] };
    expect(() => validateCredentialUseCase(ok, { orgExists: () => true })).not.toThrow();
  });
});
```
(Keep the existing `validateCredentialUseCase` import already at the top of the file; add it to the import if the file doesn't import it yet.)

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/core exec vitest run test/credential-use-cases.test.ts`
Expected: FAIL (`credentialUseCaseType` etc. not exported).

- [ ] **Step 3: Add `requiredApprovals` to the type + the four functions** — edit `packages/core/src/credential-use-cases.ts`.

Add the field to the interface:
```ts
export interface CredentialTypeSpec {
  /** Machine name, unique within the use case, e.g. "MCACredential". */
  name: string;
  /** Human label, e.g. "MCA Company Master". */
  title: string;
  /** Claim shape (same schema the token builder emits for metadataSchema). */
  claimSchema: MetadataSchema;
  /** Days the issued credential remains valid. */
  validityDays: number;
  /** Maker-checker approvals needed to issue this type. Missing ⇒ 1. */
  requiredApprovals: number;
}
```

Set `requiredApprovals: 1` on all five `CREDENTIAL_TEMPLATES` entries (add the field to each object literal).

In `validateCredentialUseCase`, inside the `for (const ct of def.credentialTypes)` loop, after the `validityDays` check, add:
```ts
    if (ct.requiredApprovals !== undefined && !(Number.isInteger(ct.requiredApprovals) && ct.requiredApprovals >= 1))
      fail(`credential type '${ct.name}' has an invalid requiredApprovals (must be an integer >= 1)`);
```

Append the four exports at the end of the file:
```ts
/** Resolve a credential type within a use case by name. Normalises a missing
 *  requiredApprovals to 1. Throws UNKNOWN_CREDENTIAL_TYPE when absent. */
export function credentialUseCaseType(def: CredentialUseCaseDefinition, typeName: string): CredentialTypeSpec {
  const spec = def.credentialTypes.find((t) => t.name === typeName);
  if (!spec) throw new PolicyError("UNKNOWN_CREDENTIAL_TYPE", `unknown credential type '${typeName}' in use case '${def.key}'`);
  const requiredApprovals = Number.isInteger(spec.requiredApprovals) && spec.requiredApprovals >= 1 ? spec.requiredApprovals : 1;
  return { ...spec, requiredApprovals };
}

/** May the caller act as this use case's issuer? A PlatformAdmin may act as any
 *  bound issuer; an OrgAdmin only for an `org` binding to their own org. */
export function issuerBindingAllows(binding: IssuerBinding, ctx: { callerOrgId: string | null; isPlatformAdmin: boolean }): boolean {
  if (ctx.isPlatformAdmin) return true;
  return binding.kind === "org" && !!ctx.callerOrgId && binding.orgId === ctx.callerOrgId;
}

/** May this holder org hold a credential of this use case? */
export function holderPolicyAllows(policy: HolderPolicy, holderOrg: { id: string; orgType: OrgType } | null): boolean {
  switch (policy.who) {
    case "any-onboarded": return true;
    case "orgType": return !!holderOrg && policy.orgTypes.includes(holderOrg.orgType);
    case "specific": return !!holderOrg && policy.orgIds.includes(holderOrg.id);
  }
}

/** May this verifier org request proofs for this use case? */
export function verifierBindingAllows(binding: VerifierBinding, verifierOrgId: string): boolean {
  return binding.kind === "any" || binding.orgIds.includes(verifierOrgId);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/core exec vitest run test/credential-use-cases.test.ts && pnpm --filter @tokenlayer/core exec tsc --noEmit`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Full core suite + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s --filter @tokenlayer/core test`
Expected: all green.
```bash
git add packages/core/src/credential-use-cases.ts packages/core/test/credential-use-cases.test.ts
git commit -m "feat(core): credential-use-case resolver + binding predicates + per-type approval depth"
```

---

## Task 2: Persistence + issuance primitive generalization

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Credential + VerificationRequest models)
- Modify: `apps/api/src/persistence/types.ts` (CredentialRecord + VerificationRequestRecord)
- Modify: `apps/api/src/persistence/prisma.ts` (both mappers + create blocks)
- Modify: `apps/api/src/credential-issuance.ts` (generalize `issueCredentialFor`)
- Modify: `apps/api/src/credential-kinds.ts` (pass validityDays)
- Modify: `apps/api/src/user-kinds.ts` (pass validityDays)
- Test: `apps/api/test/credential-usecase-runtime.test.ts` (new — persistence round-trip)

- [ ] **Step 1: Add the nullable columns to Prisma** — in `apps/api/prisma/schema.prisma`, add to `model Credential` (after `proposalId`):
```prisma
  credentialUseCaseKey String? // the CredentialUseCase this VC was issued under, if any
```
and to `model VerificationRequest` (after `purpose`):
```prisma
  credentialUseCaseKey String? // the CredentialUseCase scoping this request, if any
```

- [ ] **Step 2: Push the schema**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`
Expected: "Your database is now in sync" + client generated.

- [ ] **Step 3: Extend the record types** — in `apps/api/src/persistence/types.ts`:

Add to `CredentialRecord` (after `proposalId: string | null;`):
```ts
  credentialUseCaseKey: string | null;
```
Add to `VerificationRequestRecord` (after `purpose: string;`):
```ts
  credentialUseCaseKey: string | null;
```

- [ ] **Step 4: Update the Prisma mappers** — in `apps/api/src/persistence/prisma.ts`:

`toCredential`: add `credentialUseCaseKey: string | null;` to the destructured param type, and `credentialUseCaseKey: r.credentialUseCaseKey,` to the returned object. In `PrismaCredentialRepository.create`'s `data:` object add `credentialUseCaseKey: input.credentialUseCaseKey,`.

`toVerificationRequest`: add `credentialUseCaseKey: string | null;` to the destructured param type and `credentialUseCaseKey: r.credentialUseCaseKey,` to the returned object. In `PrismaVerificationRequestRepository.create`'s `data:` object add `credentialUseCaseKey: input.credentialUseCaseKey,`.

(Memory repos spread `{ ...input }` — no edit needed.)

- [ ] **Step 5: Generalize `issueCredentialFor`** — in `apps/api/src/credential-issuance.ts`:

Remove the `import { credentialTypeDef } from "@tokenlayer/core";` line (no longer used here). Change `IssueCredentialArgs` and the body:
```ts
export interface IssueCredentialArgs {
  issuerOrg: OrganizationRecord;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  validityDays: number;
  credentialUseCaseKey?: string | null;
  proposalId: string | null;
}

export async function issueCredentialFor(deps: AppDeps, a: IssueCredentialArgs): Promise<CredentialRecord> {
  // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
  const credentialId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statusUrl = `${deps.publicApiUrl}/credentials/${credentialId}/status`;
  const { vcJwt, expiresAt } = deps.keystore.issueOrgCredential({
    orgEncSeed: a.issuerOrg.didSeedEncrypted, orgDid: a.issuerOrg.did, subjectDid: a.subjectDid,
    type: a.type, claims: a.claims, credentialId, statusUrl, validityDays: a.validityDays, now,
  });
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
    credentialUseCaseKey: a.credentialUseCaseKey ?? null,
  });
}
```

- [ ] **Step 6: Fix the two existing callers** —

In `apps/api/src/credential-kinds.ts`: add `import { credentialTypeDef } from "@tokenlayer/core";` at the top, and change the `issueCredentialKind.execute` call:
```ts
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: pl.type, claims: pl.claims,
      validityDays: credentialTypeDef(pl.type).validityDays, proposalId: p.id,
    });
```

In `apps/api/src/user-kinds.ts`: add `credentialTypeDef` to the existing `@tokenlayer/core` import (line 6), and change the call at line 67:
```ts
        const cred = await issueCredentialFor(deps, {
          issuerOrg, subjectDid: did, type: "KycCredential",
          claims: { legalName: pl.kyc.legalName, country: pl.kyc.country },
          validityDays: credentialTypeDef("KycCredential").validityDays, proposalId: p.id,
        });
```

- [ ] **Step 7: Write the persistence round-trip test** — create `apps/api/test/credential-usecase-runtime.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository } from "../src/persistence/memory.js";

describe("credential record carries credentialUseCaseKey", () => {
  it("round-trips the new field through the repo", async () => {
    const repo = new MemoryCredentialRepository();
    const rec = await repo.create({
      id: "c1", holderDid: "did:key:zH", issuerDid: "did:key:zI", type: "MCACredential",
      vcJwt: "jwt", subjectClaims: { id: "did:key:zH" }, issuedAt: new Date().toISOString(),
      expiresAt: null, revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
      proposalId: null, credentialUseCaseKey: "corp-trade-credentials",
    });
    expect(rec.credentialUseCaseKey).toBe("corp-trade-credentials");
    const back = await repo.get("c1");
    expect(back?.credentialUseCaseKey).toBe("corp-trade-credentials");
  });
});
```

- [ ] **Step 8: Verify + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/credential-usecase-runtime.test.ts && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: PASS + typecheck clean (the two callers and both repos compile with the new field).
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/prisma.ts apps/api/src/credential-issuance.ts apps/api/src/credential-kinds.ts apps/api/src/user-kinds.ts apps/api/test/credential-usecase-runtime.test.ts
git commit -m "feat(api): generalize issueCredentialFor + credentialUseCaseKey on credential/verification records"
```

---

## Task 3: Issuance route + proposal kind + eligible-holders + revoke depth

**Files:**
- Create: `apps/api/src/credential-usecase-kinds.ts`
- Modify: `apps/api/src/proposal-kinds.ts` (register the new kind)
- Modify: `apps/api/src/http/routes.ts` (issuance route, eligible-holders route, revoke-depth fix)
- Modify: `apps/api/src/http/schemas.ts` (new schemas)
- Test: `apps/api/test/credential-usecase-issuance.test.ts` (new)

- [ ] **Step 1: The proposal kind** — create `apps/api/src/credential-usecase-kinds.ts`:
```ts
/**
 * Config-driven credential issuance (ID-B). A bound issuer issues a configured
 * credential type to an eligible holder, through maker-checker. ORG scoped to
 * the issuer org (like the closed-catalog credential kinds), but the type's
 * claim schema + validity come from the CredentialUseCase config, not the
 * closed catalog.
 */
import { credentialUseCaseType } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import { coded } from "./executors.js";
import { issueCredentialFor } from "./credential-issuance.js";
import type { TokenClaims } from "./http/support.js";
import type { ProposalKindHandler } from "./proposal-kinds.js";
import type { ProposalRecord } from "./persistence/types.js";

const orgScopedView = async (_deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean> =>
  claims.role === "PlatformAdmin" || (claims.role === "OrgAdmin" && !!p.orgId && claims.orgId === p.orgId);

export interface IssueUsecaseCredentialPayload {
  credentialUseCaseKey: string;
  credentialType: string;
  subjectDid: string;
  subjectUserId: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}

export const issueUsecaseCredentialKind: ProposalKindHandler = {
  kind: "issue-usecase-credential",
  canView: orgScopedView,
  canApprove: orgScopedView,
  async execute(ctx, _proposer, p) {
    const pl = p.payload as unknown as IssueUsecaseCredentialPayload;
    // Re-resolve fresh config at execution — never sign stale config.
    const def = await ctx.deps.credentialUseCases.get(pl.credentialUseCaseKey);
    if (!def) throw coded(404, "UNKNOWN_USECASE", `credential use case '${pl.credentialUseCaseKey}' missing`);
    const spec = credentialUseCaseType(def, pl.credentialType); // throws UNKNOWN_CREDENTIAL_TYPE
    const org = await ctx.deps.organizations.get(pl.issuerOrgId);
    if (!org) throw coded(404, "NOT_FOUND", "issuing organization missing");
    await issueCredentialFor(ctx.deps, {
      issuerOrg: org, subjectDid: pl.subjectDid, type: spec.name, claims: pl.claims,
      validityDays: spec.validityDays, credentialUseCaseKey: def.key, proposalId: p.id,
    });
  },
};
```

- [ ] **Step 2: Register the kind** — in `apps/api/src/proposal-kinds.ts`: add `import { issueUsecaseCredentialKind } from "./credential-usecase-kinds.js";` with the other kind imports, and `registerProposalKind(issueUsecaseCredentialKind);` in the registration block at the bottom (next to `registerProposalKind(issueCredentialKind);`).

- [ ] **Step 3: Add the schemas** — in `apps/api/src/http/schemas.ts`, add two entries to the `S` object (near `requestCredential`):
```ts
  issueUsecaseCredential: {
    tags: ["Credentials"], summary: "Issue a configured credential type (gated by the type's approval depth)", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    body: {
      type: "object", additionalProperties: false, required: ["credentialType", "subjectUserId", "claims"],
      properties: {
        credentialType: { type: "string" },
        subjectUserId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
      },
    },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404) },
  },
  eligibleHolders: {
    tags: ["Credentials"], summary: "Users eligible to hold a credential of this use case", security: bearer,
    params: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    response: {
      200: { type: "array", items: { type: "object", additionalProperties: true } },
      ...errs(401, 403, 404),
    },
  },
```
Then add `credentialUseCaseKey: { type: "string" }` to the `properties` of `S.createVerificationRequest.body` (do NOT add it to `required` — it is optional). This one line prepares Task 4.

- [ ] **Step 4: Write failing behavioural tests** — create `apps/api/test/credential-usecase-issuance.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

// Seed a credential use case, an issuer-eligible subject, then exercise the runtime.
async function seedUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key: "corp-kyc", name: "Corp KYC",
    credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return DEF;
}

// A subject user that has a DID: onboard one through the existing gated flow, OR
// reuse a seeded desk operator that already holds a DID. The seeded issuer desk
// operators (e.g. m1.issuer) hold a DID + membership credential.
async function subjectWithDid(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string): Promise<{ id: string; did: string }> {
  const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
  const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(issuer) });
  const body = me.json();
  expect(body.did).toBeTruthy();
  return { id: body.id, did: body.did };
}

describe("config-driven credential issuance", () => {
  it("PlatformAdmin issues a platform-bound credential (202) → approved → held by the subject", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app, admin);

    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(issued.statusCode).toBe(202);
    const proposalId = issued.json().proposal.id;

    // Second PlatformAdmin approves (proposer != approver).
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2) });
    expect(approve.statusCode).toBe(200);

    // The subject now holds the credential.
    const subjTok = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    expect((held.json() as { type: string[] }[]).some((c) => c.type.includes("KycCredential"))).toBe(true);
  });

  it("rejects bad claims (INVALID_METADATA) and an unknown type (UNKNOWN_CREDENTIAL_TYPE)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app, admin);
    const badClaims = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme" } } });
    expect(badClaims.statusCode).toBe(400);
    const badType = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "Nope", subjectUserId: subject.id, claims: {} } });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe("UNKNOWN_CREDENTIAL_TYPE");
  });

  it("an OrgAdmin cannot issue for a platform-bound use case (ISSUER_NOT_PERMITTED)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app, admin);
    // m1.admin is an OrgAdmin? If not available, this asserts the platform gate via a non-PlatformAdmin issuer role.
    const orgAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(orgAdmin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect([403]).toContain(res.statusCode);
  });

  it("honors requiredApprovals: 2 (one approval is not enough)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin, { credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 2,
      claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } } }] });
    const subject = await subjectWithDid(app, admin);
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyc/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(issued.json().proposal.required).toBe(2);
  });

  it("lists eligible holders for a use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const res = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/corp-kyc/eligible-holders`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    // every returned holder has a DID
    for (const h of res.json() as { did: string }[]) expect(h.did).toBeTruthy();
  });
});
```
NOTE to implementer: the approve route is confirmed — `POST ${V1}/proposals/${id}/approve` with `payload: {}` (see `apps/api/test/approvals.test.ts:43`, `cashflows.test.ts:45`). The `GET /me` handler is `actorOf(request)` — confirm it returns the caller's `did` (`grep -n "function actorOf" apps/api/src/http/*.ts`); if `did` is absent from that shape, resolve the subject's id+did via `GET ${V1}/orgs/:id/members` for the seeded desk org (that projection includes `did`) instead. Keep the assertions unchanged (202 → approve → held; 400 bad claims/type; 403 org-admin-on-platform-binding; required===2; eligible-holders all have DIDs).

- [ ] **Step 5: Implement the issuance + eligible-holders routes** — in `apps/api/src/http/routes.ts`.

Add imports (top of file, to the existing `@tokenlayer/core` import): `credentialUseCaseType, issuerBindingAllows, holderPolicyAllows`. Add `import { PLATFORM_ORG_NAME } from "../platform-org.js";` if not already imported.

Add these two routes next to the existing `/credential-use-cases` routes (after `PATCH /credential-use-cases/:key`):
```ts
  // A shared issuer-authorization helper: resolve the bound issuer org + confirm
  // the caller may act as it. Returns { issuerOrg } or sends an error + null.
  async function resolveIssuer(reply: FastifyReply, claims: TokenClaims, def: Awaited<ReturnType<typeof deps.credentialUseCases.get>>) {
    const isPlatformAdmin = claims.role === "PlatformAdmin";
    if (claims.role !== "PlatformAdmin" && claims.role !== "OrgAdmin") {
      reply.code(403).send({ error: "FORBIDDEN", message: "only a Platform Admin or an Org Admin may issue credentials" });
      return null;
    }
    if (!issuerBindingAllows(def!.issuer, { callerOrgId: claims.orgId ?? null, isPlatformAdmin })) {
      reply.code(403).send({ error: "ISSUER_NOT_PERMITTED", message: "you may not issue for this use case's configured issuer" });
      return null;
    }
    const issuerOrg = def!.issuer.kind === "platform"
      ? await deps.organizations.findByName(PLATFORM_ORG_NAME)
      : await deps.organizations.get(def!.issuer.orgId);
    if (!issuerOrg) {
      reply.code(400).send({ error: "ISSUER_ORG_MISSING", message: "the configured issuer organization does not exist" });
      return null;
    }
    return { issuerOrg };
  }

  app.get("/credential-use-cases/:key/eligible-holders", { schema: S.eligibleHolders, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { key } = request.params as { key: string };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(reply, claims, def); // same gate as issuing
    if (!resolved) return;
    const users = await deps.users.list();
    const out: { id: string; email: string; did: string; orgName: string | null }[] = [];
    for (const u of users) {
      if (!u.did) continue;
      const org = u.orgId ? await deps.organizations.get(u.orgId) : null;
      if (holderPolicyAllows(def.holderPolicy, org ? { id: org.id, orgType: org.orgType } : null)) {
        out.push({ id: u.id, email: u.email, did: u.did, orgName: org?.name ?? null });
      }
    }
    return out;
  });

  app.post("/credential-use-cases/:key/credentials", { schema: S.issueUsecaseCredential, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { key } = request.params as { key: string };
    const b = request.body as { credentialType: string; subjectUserId: string; claims: Record<string, unknown> };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(reply, claims, def);
    if (!resolved) return;
    const { issuerOrg } = resolved;

    let spec;
    try { spec = credentialUseCaseType(def, b.credentialType); }
    catch (err) { return reply.code(400).send({ error: "UNKNOWN_CREDENTIAL_TYPE", message: (err as Error).message }); }

    const subject = await deps.users.findById(b.subjectUserId);
    if (!subject) return notFound(reply, "subject user not found");
    if (!subject.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject has no decentralized identifier" });
    const holderOrg = subject.orgId ? await deps.organizations.get(subject.orgId) : null;
    if (!holderPolicyAllows(def.holderPolicy, holderOrg ? { id: holderOrg.id, orgType: holderOrg.orgType } : null)) {
      return reply.code(403).send({ error: "HOLDER_NOT_ELIGIBLE", message: "the subject is not an eligible holder for this use case" });
    }
    validateMetadata(b.claims, spec.claimSchema); // throws INVALID_METADATA → 400

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuerOrg.id, assetId: null, kind: "issue-usecase-credential",
      payload: { credentialUseCaseKey: key, credentialType: spec.name, subjectDid: subject.did, subjectUserId: subject.id, claims: b.claims, issuerOrgId: issuerOrg.id },
      proposerId: claims.id, proposerLabel: claims.email, required: spec.requiredApprovals,
    });
    return reply.code(202).send({ proposal });
  });
```
NOTE: confirm `FastifyReply` is imported in routes.ts (it is used elsewhere); if the local `resolveIssuer` closure placement causes a "used before declaration" lint, hoist it above both routes (as written) or inline the logic. `validateMetadata` and `notFound` are already imported in this file.

- [ ] **Step 6: Fix revoke depth for use-case credentials** — in `apps/api/src/http/routes.ts`, the `POST /credentials/:id/revoke` handler currently does `const def = credentialTypeDef(cred.type);` then `required: def.requiredApprovals`. Replace that resolution with:
```ts
    // Depth from the credential's origin: a use-case credential resolves against
    // its use case; a closed-catalog credential against the catalog.
    let required = 1;
    if (cred.credentialUseCaseKey) {
      const uc = await deps.credentialUseCases.get(cred.credentialUseCaseKey);
      required = uc ? credentialUseCaseType(uc, cred.type).requiredApprovals : 1;
    } else {
      required = credentialTypeDef(cred.type).requiredApprovals;
    }
```
and change the proposal `required: def.requiredApprovals` → `required`. Keep `credentialTypeDef` imported (still used in the else branch and by `/credentials/requests`).

- [ ] **Step 7: Run tests, iterate to green**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/credential-usecase-issuance.test.ts`
Expected: PASS (adjust the test helpers per the Step 4 note if the approve route / `GET /me` shapes differ — the assertions stay).

- [ ] **Step 8: Typecheck + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec tsc --noEmit`
```bash
git add apps/api/src/credential-usecase-kinds.ts apps/api/src/proposal-kinds.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/credential-usecase-issuance.test.ts
git commit -m "feat(api): config-driven credential issuance route + kind + eligible-holders + revoke depth"
```

---

## Task 4: Verification extension (use-case-aware)

**Files:**
- Modify: `apps/api/src/http/routes.ts` (`POST /verification-requests` gating + `vreqView`)
- Modify: `apps/api/src/http/schemas.ts` (already added `credentialUseCaseKey` to the body in Task 3 Step 3)
- Modify: `apps/api/src/persistence/*` (already carry the field from Task 2)
- Test: `apps/api/test/credential-usecase-verify.test.ts` (new)

- [ ] **Step 1: Write failing tests** — create `apps/api/test/credential-usecase-verify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

// Seed a use case whose verifier binding is restricted to a specific org, then
// confirm an allowed verifier can create a request and a disallowed one cannot.
describe("use-case-aware verification requests", () => {
  it("gates the requesting org by the verifier binding", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Discover a real org id to bind as verifier (a verifier-type org exists in seeds).
    const orgs = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) });
    const verifierOrg = (orgs.json() as { id: string; orgType: string }[]).find((o) => o.orgType === "verifier");
    expect(verifierOrg).toBeTruthy();
    const DEF = {
      key: "vc-bound", name: "Bound",
      credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "orgs", orgIds: [verifierOrg!.id] },
    };
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

    // A verifier-org OrgAdmin who is on the list can request; the request carries the key.
    // (If no such OrgAdmin login exists in seeds, assert the disallowed path below only.)
    const outsider = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const denied = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(outsider),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["KycCredential"], purpose: "check", credentialUseCaseKey: "vc-bound" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("VERIFIER_NOT_PERMITTED");
  });

  it("rejects requested types not in the use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const DEF = {
      key: "vc-any", name: "Any",
      credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    };
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);
    // With verifier:any, an OrgAdmin (any onboarded org) may request; but a type outside the use case is rejected.
    const someOrgAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(someOrgAdmin),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["NotAType"], purpose: "check", credentialUseCaseKey: "vc-any" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TYPES_NOT_IN_USECASE");
  });
});
```
NOTE: confirm a `GET /orgs` exists and returns `{id, orgType}` (it does — org list route). If `m1.admin` is not an OrgAdmin in seeds, use whichever seeded OrgAdmin login exists (search `apps/api/src/seed.ts`); the point is a non-listed org → 403, and a bad type → 400.

- [ ] **Step 2: Extend the verification-request route** — in `apps/api/src/http/routes.ts`, replace the body of `POST /verification-requests` gating with a use-case-aware branch. The current handler reads `const b = request.body as { holderDid; requestedTypes; purpose }` and gates on verifier org-type. Change to:
```ts
  app.post("/verification-requests", { schema: S.createVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string };
    if (claims.role !== "OrgAdmin" || !claims.orgId) {
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "only an organization admin may request a presentation" });
    }
    const org = await deps.organizations.get(claims.orgId);
    if (!org) return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not found" });

    if (b.credentialUseCaseKey) {
      // Use-case-aware: gate by the Verifier binding (replaces the org-type gate)
      // and require every requested type to belong to the use case.
      const def = await deps.credentialUseCases.get(b.credentialUseCaseKey);
      if (!def) return notFound(reply, `credential use case '${b.credentialUseCaseKey}' not found`);
      if (!verifierBindingAllows(def.verifier, org.id)) {
        return reply.code(403).send({ error: "VERIFIER_NOT_PERMITTED", message: "your organization may not verify this use case" });
      }
      const names = new Set(def.credentialTypes.map((t) => t.name));
      if (!b.requestedTypes.every((t) => names.has(t))) {
        return reply.code(400).send({ error: "TYPES_NOT_IN_USECASE", message: "a requested type is not part of this use case" });
      }
    } else if (org.orgType !== "verifier") {
      // Legacy generic flow: still requires a verifier org-type.
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    }

    const rec = await deps.verificationRequests.create({
      verifierOrgId: org.id, holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
      credentialUseCaseKey: b.credentialUseCaseKey ?? null,
      challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
      consentedCredentialIds: null, verifierResult: null, verifiedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    await deps.audit.append({ actorId: claims.id, action: "verification-requested" as LifecycleAction, payload: { requestId: rec.id, verifierOrgId: org.id, holderDid: b.holderDid, types: b.requestedTypes, credentialUseCaseKey: rec.credentialUseCaseKey } });
    return reply.code(201).send(vreqView(rec));
  });
```
Add `verifierBindingAllows` to the `@tokenlayer/core` import at the top of routes.ts. In the `vreqView` projection (defined just above this route, ~line 1858), add `credentialUseCaseKey: r.credentialUseCaseKey,` to the returned object so the UI can display it.

- [ ] **Step 3: Run tests, iterate to green**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/credential-usecase-verify.test.ts`
Expected: PASS.

- [ ] **Step 4: Full-flow test (issue → verify a use-case credential)** — append to `apps/api/test/credential-usecase-verify.test.ts` a test that: seeds a `verifier:any` use case, issues+approves a credential to a DID-holding subject (reuse the Task 3 helper pattern), has that subject consent to a use-case verification request from an OrgAdmin, then the verifier calls `GET /verification-requests/:id/verify` and asserts `valid:true`; revoke the credential and re-verify → `valid:false`. If wiring the full flow here is heavy, cover it in the Task 6 live E2E instead and keep Steps 1-3 as the unit-level guarantees. (Implementer's judgment; prefer including it if the seeded logins support a holder that can log in and consent.)

- [ ] **Step 5: Typecheck + full api suite + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm -s --filter @tokenlayer/api test`
Expected: typecheck clean; full suite green.
```bash
git add apps/api/src/http/routes.ts apps/api/test/credential-usecase-verify.test.ts
git commit -m "feat(api): use-case-aware verification requests (verifier-binding gate)"
```

---

## Task 5: Web — issue surface + verifier picker + client

**Files:**
- Modify: `apps/web/src/types.ts` (`CredentialTypeSpec.requiredApprovals`, `VerificationRequest.credentialUseCaseKey`, `EligibleHolder`)
- Modify: `apps/web/src/api.ts` (issue, eligible-holders, verification-request key)
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx` (Approvals field per type)
- Create: `apps/web/src/components/IssueUsecaseCredential.tsx`
- Modify: `apps/web/src/components/IdentityHome.tsx` (Issue action per card)
- Modify: `apps/web/src/components/VerificationRequests.tsx` (use-case picker)
- Modify: `apps/web/src/App.tsx` (Identity nav for OrgAdmin + panel branch)

- [ ] **Step 1: Types + client** — in `apps/web/src/types.ts`:
  - Add `requiredApprovals: number;` to `CredentialTypeSpec`.
  - Add `credentialUseCaseKey?: string | null;` to `VerificationRequest`.
  - Add `export interface EligibleHolder { id: string; email: string; did: string; orgName: string | null; }`.

In `apps/web/src/api.ts` add methods (near the other credential-use-case methods):
```ts
  eligibleHolders: (token: string, key: string) =>
    request<EligibleHolder[]>(`/credential-use-cases/${encodeURIComponent(key)}/eligible-holders`, token),
  issueUsecaseCredential: (token: string, key: string, body: { credentialType: string; subjectUserId: string; claims: Record<string, unknown> }) =>
    request<{ proposal: Proposal }>(`/credential-use-cases/${encodeURIComponent(key)}/credentials`, token, { method: "POST", body: JSON.stringify(body) }),
```
and add `credentialUseCaseKey?: string` to the `createVerificationRequest` body param type:
```ts
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
```
Import `EligibleHolder` in api.ts's type import.

- [ ] **Step 2: Approvals field in the builder** — in `apps/web/src/components/CredentialUseCaseBuilder.tsx`, each credential type already edits `name`/`title`/`validityDays`. Add a numeric "Approvals" input bound to a per-type `requiredApprovals` (default 1), and include `requiredApprovals` when building each `credentialTypes[]` entry in the submit/`buildDefinition` step. When a template is loaded, set `requiredApprovals` from the template (all templates are 1). Mirror the existing `validityDays` field's markup + state handling exactly.

- [ ] **Step 3: The issue form component** — create `apps/web/src/components/IssueUsecaseCredential.tsx`:
```tsx
import { useEffect, useState } from "react";
import { useAuth } from "../auth.js";
import { api, ApiError } from "../api.js";
import type { CredentialUseCase, CredentialTypeSpec, EligibleHolder } from "../types.js";

export function IssueUsecaseCredential({ useCase, onIssued }: { useCase: CredentialUseCase; onIssued: () => void }): JSX.Element {
  const { token } = useAuth();
  const [typeName, setTypeName] = useState(useCase.credentialTypes[0]?.name ?? "");
  const [holders, setHolders] = useState<EligibleHolder[]>([]);
  const [subjectUserId, setSubjectUserId] = useState("");
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.eligibleHolders(token, useCase.key).then(setHolders).catch(() => setHolders([]));
  }, [token, useCase.key]);

  const spec: CredentialTypeSpec | undefined = useCase.credentialTypes.find((t) => t.name === typeName);

  async function submit(): Promise<void> {
    setErr(null); setMsg(null);
    if (!token || !subjectUserId) { setErr("pick a holder"); return; }
    try {
      await api.issueUsecaseCredential(token, useCase.key, { credentialType: typeName, subjectUserId, claims });
      setMsg("Issuance submitted — pending approval."); setClaims({}); onIssued();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4 mt-3">
      <div className="text-sm font-medium mb-2">Issue a credential</div>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
      <label className="block text-xs text-slate-500 mb-1">Credential type</label>
      <select className="input w-full mb-2" value={typeName} onChange={(e) => setTypeName(e.target.value)}>
        {useCase.credentialTypes.map((t) => <option key={t.name} value={t.name}>{t.title} ({t.name})</option>)}
      </select>
      <label className="block text-xs text-slate-500 mb-1">Holder</label>
      <select className="input w-full mb-2" value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)}>
        <option value="">— select an eligible holder —</option>
        {holders.map((h) => <option key={h.id} value={h.id}>{h.email}{h.orgName ? ` · ${h.orgName}` : ""}</option>)}
      </select>
      {spec && Object.entries(spec.claimSchema.properties).map(([field, p]) => (
        <div key={field} className="mb-2">
          <label className="block text-xs text-slate-500 mb-1">{field}{spec.claimSchema.required?.includes(field) ? " *" : ""}</label>
          {Array.isArray(p.enum) ? (
            <select className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })}>
              <option value="">—</option>
              {p.enum.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })} />
          )}
        </div>
      ))}
      <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white mt-1" onClick={() => void submit()}>Submit for approval</button>
    </div>
  );
}
```
(Confirm the `input`/`brand-600` classes match the project's Tailwind conventions — they are used in `VerificationRequests.tsx`. Reuse whatever `Card`/button styling IdentityHome already uses if cleaner.)

- [ ] **Step 4: Wire the issue form into IdentityHome cards** — in `apps/web/src/components/IdentityHome.tsx`, add per-card an "Issue credential" toggle button that expands `<IssueUsecaseCredential useCase={uc} onIssued={reload} />`. Show the button to any viewer (the server authorizes); track an expanded-card id in local state. Import `IssueUsecaseCredential`.

- [ ] **Step 5: Verifier use-case picker** — in `apps/web/src/components/VerificationRequests.tsx`:
  - Load `api.credentialUseCases(token)` into state; render a `<select>` "Credential use case (optional)" above the types list: `— none (generic) —` + one option per use case.
  - When a use case is selected, replace the closed-catalog `types` checkboxes with that use case's `credentialTypes` (checkbox per `t.name`); when none, keep the existing `credentialTypes`-from-`api.credentialTypes` behavior.
  - Pass `credentialUseCaseKey` (the selected key, or omit) in the `api.createVerificationRequest` call.

- [ ] **Step 6: Identity nav for OrgAdmin** — in `apps/web/src/App.tsx`, operator-console branch (the one with `activeUseCaseObj`):
  - Add to `items` (next to the `organizations`/`verify` conditional spreads): `...(isPlatform || isOrgAdmin ? [{ id: "identity", label: "Identity", icon: "shield" as const }] : []),`
  - Add a panel branch: `} else if (view === "identity") { panel = <IdentityHome />;` and `import { IdentityHome } from "./components/IdentityHome.js";` at the top.
  (Leave the existing PlatformHome-based Identity for PlatformAdmin-no-active-use-case untouched.)

- [ ] **Step 7: Typecheck + build**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean. Fix all type errors.

- [ ] **Step 8: Commit**
```bash
git add apps/web/src
git commit -m "feat(web): issue-credential surface + verifier use-case picker + Identity for OrgAdmins"
```

---

## Task 6: Verify — full suite + live browser walkthrough + finish

**Files:** none (verification + branch finish).

- [ ] **Step 1: Full workspace gate**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s typecheck && pnpm -s --filter @tokenlayer/core test && pnpm -s --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build`
Expected: typecheck clean across all packages; core + api suites green; web builds.

- [ ] **Step 2: Boot live stack** — `bash scripts/dev-boot.sh` (Besu/MST/Fabric + escrow). Wait for "TokenLayer API listening". If a stale API holds `:4000`, `lsof -nP -iTCP:4000 -sTCP:LISTEN -t | xargs kill` first, and run `prisma db push` (Task 2 Step 2) so the new columns exist in `dev.db`. Start the web preview (vite) too.

- [ ] **Step 3: Live API walkthrough (curl)** — against `http://localhost:4000/api/v1`, log in as `admin@tokenlayer.dev`/`admin123`:
  1. Confirm the seeded `corp-trade-credentials` use case exists (`GET /credential-use-cases`).
  2. `GET /credential-use-cases/corp-trade-credentials/eligible-holders` → non-empty, every holder has a `did`.
  3. `POST /credential-use-cases/corp-trade-credentials/credentials` (an MCA credential to an eligible holder) → 202; approve the proposal as `admin2@tokenlayer.dev` → the credential is issued.
  4. The holder's `GET /me/credentials` includes it.
  5. A verifier `POST /verification-requests` with `credentialUseCaseKey` → holder consent → `GET …/verify` → `valid:true`; revoke → re-verify → `valid:false`.
  Capture the outputs as the proof.

- [ ] **Step 4: Live browser walkthrough** — in the preview: log in as PlatformAdmin → Identity → open a use-case card → "Issue credential" → pick a type + eligible holder + fill claims → submit (202/pending). Approve it (Approvals inbox). Log in as the holder → My Credentials shows it. As a verifier org → Verification → pick the use case → request → holder consents → run verification → valid. Screenshot the key states.

- [ ] **Step 5: Finish the branch** — use `superpowers:finishing-a-development-branch` (verify tests pass, then present the 4 options; merge locally to `main` per this program's pattern unless the user chooses otherwise).

---

## Self-review checklist (author)

- **Spec coverage:** approval depth (T1) ✓; four core functions (T1) ✓; issuance route + kind + gates + maker-checker (T3) ✓; generalized primitive (T2) ✓; revocation depth (T3) ✓; verification extension (T4) ✓; web issue surface + verifier picker + OrgAdmin nav (T5) ✓; live verify (T6) ✓.
- **Type consistency:** `credentialUseCaseType`/`issuerBindingAllows`/`holderPolicyAllows`/`verifierBindingAllows` names identical across core (T1), api routes/kind (T3/T4). `IssueUsecaseCredentialPayload` fields (`credentialUseCaseKey`, `credentialType`, `subjectDid`, `subjectUserId`, `claims`, `issuerOrgId`) match between the route's `proposals.create` payload (T3 Step 5) and the kind's `execute` reader (T3 Step 1). `credentialUseCaseKey` added to `CredentialRecord` (T2) is written by `issueCredentialFor` (T2) and read by the revoke route (T3 Step 6). `EligibleHolder` shape matches the route projection (T3 Step 5) and the web type (T5 Step 1).
- **Placeholder scan:** none — every code step carries real code; the two "confirm the seeded login / approve-route shape" notes are explicit implementer instructions, not placeholders.
