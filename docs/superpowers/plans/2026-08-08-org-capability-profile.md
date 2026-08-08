# Organization Capability Profile & Role Management (EN-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Organization gets a governed capability envelope — `domains: tokenization|identity`, `roles: Issuer|Holder|Verifier` — requested at signup, granted at approval, changed only via the approval queue (or set directly by PlatformAdmin), and enforced at the eight gates where orgs act. `null` = unrestricted legacy (zero migration, zero existing-test edits).

**Architecture:** Core gets the `OrgCapabilities` type + two null-tolerant predicates + a validator. Persistence adds one JSON column with full memory/prisma parity and a `setCapabilities` repo method. The API stores the envelope at registration, exposes PlatformAdmin direct-set and an `org-capability-change` proposal kind for org-requested changes, threads `orgCapabilities` through login/me, and adds `orgCapabilityMissing` 403s at the existing gates. Web: signup step, review pills, org page management, approvals arm, OrgAdmin nav filtering.

**Tech Stack:** packages/core (vitest), apps/api (Fastify + dual memory/prisma persistence, vitest), apps/web (React + Vite).

**Spec:** `docs/superpowers/specs/2026-08-08-org-capability-profile-design.md` — read it first, especially the enforcement table and the null-vs-`[]` semantics.

**Branch:** create `feat/org-capabilities` off main before Task A1.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/core/src/org-capabilities.ts` | create | type + predicates + validator |
| `packages/core/src/index.ts` | modify | EXPLICIT export list — add the new names (THE ID-D LESSON: forgetting this makes consumers see `undefined`) |
| `packages/core/test/org-capabilities.test.ts` | create | truth tables + validator tests |
| `apps/api/prisma/schema.prisma` | modify | `capabilities String?` on `model Organization` |
| `apps/api/src/persistence/types.ts` | modify | record field + `setCapabilities` |
| `apps/api/src/persistence/memory.ts` / `prisma.ts` | modify | parity: mapper + create + setCapabilities |
| `apps/api/src/org-kinds.ts` | create | `org-capability-change` proposal kind |
| `apps/api/src/http/routes.ts` | modify | register/PATCH/request routes, orgView, login//me threading, 8 enforcement gates |
| `apps/api/src/http/schemas.ts` | modify | new/extended schemas |
| `apps/api/test/org-capabilities.test.ts` | create | acquisition + enforcement suites |
| `apps/web/src/{types,api}.ts`, `components/{Signup,Organizations,ApprovalsPanel}.tsx`, `App.tsx`, `auth.tsx` | modify | wizard step, pills, manage/request surfaces, summarize arm, nav filtering |

**Standing hard rules:** never edit an existing behavioral test; persistence fields land in schema + types + BOTH repos + `pnpm --filter @tokenlayer/api exec prisma generate` in ONE commit, and the live walkthrough proves the Prisma round-trip; loose response schemas for new nested fields; kill APIs by port; `""`-vs-null normalization at route edges.

---

### Task A1: Core — `OrgCapabilities` type, predicates, validator

**Files:** create `packages/core/src/org-capabilities.ts`, `packages/core/test/org-capabilities.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Failing tests.** Create `packages/core/test/org-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orgDomainEnabled, orgRoleEnabled, validateOrgCapabilities } from "../src/org-capabilities.js";
import { PolicyError } from "../src/errors.js";

describe("org capability predicates", () => {
  it("null = unrestricted legacy envelope (both predicates true)", () => {
    expect(orgDomainEnabled(null, "tokenization")).toBe(true);
    expect(orgDomainEnabled(null, "identity")).toBe(true);
    expect(orgRoleEnabled(null, "Issuer")).toBe(true);
    expect(orgRoleEnabled(null, "Holder")).toBe(true);
    expect(orgRoleEnabled(null, "Verifier")).toBe(true);
  });
  it("explicit envelope gates by membership; [] is fully restrictive (≠ null)", () => {
    const caps = { domains: ["identity" as const], roles: ["Issuer" as const, "Verifier" as const] };
    expect(orgDomainEnabled(caps, "identity")).toBe(true);
    expect(orgDomainEnabled(caps, "tokenization")).toBe(false);
    expect(orgRoleEnabled(caps, "Issuer")).toBe(true);
    expect(orgRoleEnabled(caps, "Holder")).toBe(false);
    const empty = { domains: [], roles: [] };
    expect(orgDomainEnabled(empty, "identity")).toBe(false);
    expect(orgRoleEnabled(empty, "Issuer")).toBe(false);
  });
});

describe("validateOrgCapabilities", () => {
  it("accepts a well-formed envelope (incl. empty arrays)", () => {
    expect(() => validateOrgCapabilities({ domains: ["tokenization", "identity"], roles: ["Issuer"] })).not.toThrow();
    expect(() => validateOrgCapabilities({ domains: [], roles: [] })).not.toThrow();
  });
  it("rejects unknown values, duplicates, and non-arrays", () => {
    expect(() => validateOrgCapabilities({ domains: ["defi"], roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: ["identity", "identity"], roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: ["identity"], roles: ["Admin"] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities({ domains: "identity", roles: [] } as never)).toThrow(PolicyError);
    expect(() => validateOrgCapabilities(null as never)).toThrow(PolicyError);
  });
});
```

(Check how `PolicyError` is constructed/exported in `packages/core/src/errors.ts` and how sibling validators like `validateCredentialUseCase` throw it — mirror that exactly.)

- [ ] **Step 2: Run to fail** — `pnpm --filter @tokenlayer/core exec vitest run test/org-capabilities.test.ts` → module not found.

- [ ] **Step 3: Implement `packages/core/src/org-capabilities.ts`:**

```ts
/**
 * The organization capability envelope (EN-A): which domains a tenant org
 * operates and which operating roles it plays. `null` everywhere means the
 * unrestricted LEGACY envelope — orgs created before EN-A (or by paths that
 * don't choose) keep full powers until the platform sets an explicit envelope.
 * An explicit envelope with an empty array is fully restrictive: [] ≠ null.
 */
import { PolicyError } from "./errors.js";

export const ORG_DOMAINS = ["tokenization", "identity"] as const;
export type OrgDomain = (typeof ORG_DOMAINS)[number];
export const ORG_OPERATING_ROLES = ["Issuer", "Holder", "Verifier"] as const;
export type OrgOperatingRole = (typeof ORG_OPERATING_ROLES)[number];

export interface OrgCapabilities {
  domains: OrgDomain[];
  roles: OrgOperatingRole[];
}

export function orgDomainEnabled(caps: OrgCapabilities | null, domain: OrgDomain): boolean {
  return caps === null || caps.domains.includes(domain);
}

export function orgRoleEnabled(caps: OrgCapabilities | null, role: OrgOperatingRole): boolean {
  return caps === null || caps.roles.includes(role);
}

export function validateOrgCapabilities(input: unknown): OrgCapabilities {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PolicyError("INVALID_CAPABILITIES", "capabilities must be an object with domains and roles arrays");
  }
  const { domains, roles } = input as { domains?: unknown; roles?: unknown };
  const checkList = (value: unknown, allowed: readonly string[], label: string): string[] => {
    if (!Array.isArray(value)) throw new PolicyError("INVALID_CAPABILITIES", `${label} must be an array`);
    for (const v of value) {
      if (typeof v !== "string" || !allowed.includes(v)) {
        throw new PolicyError("INVALID_CAPABILITIES", `unknown ${label} entry '${String(v)}'`);
      }
    }
    if (new Set(value).size !== value.length) throw new PolicyError("INVALID_CAPABILITIES", `${label} contains duplicates`);
    return value as string[];
  };
  return {
    domains: checkList(domains, ORG_DOMAINS, "domains") as OrgDomain[],
    roles: checkList(roles, ORG_OPERATING_ROLES, "roles") as OrgOperatingRole[],
  };
}
```

Adjust the `PolicyError` constructor call to the real signature in errors.ts (code-first vs message-first — READ IT). If `PolicyErrorCode` is a closed union, add `"INVALID_CAPABILITIES"` to it.

- [ ] **Step 4: Export.** Add `org-capabilities` exports to `packages/core/src/index.ts`'s explicit list: `ORG_DOMAINS, OrgDomain, ORG_OPERATING_ROLES, OrgOperatingRole, OrgCapabilities, orgDomainEnabled, orgRoleEnabled, validateOrgCapabilities` (types via `export type`). Match the file's existing export style exactly.

- [ ] **Step 5: Green** — target file passes; full `pnpm --filter @tokenlayer/core test` (227 + new); `tsc --noEmit` clean.

- [ ] **Step 6: Commit** — `feat(core): OrgCapabilities envelope — type, null-tolerant predicates, validator`.

---

### Task A2: Persistence — capabilities column, parity, setCapabilities

**Files:** modify `apps/api/prisma/schema.prisma` (model Organization), `apps/api/src/persistence/types.ts` (~375 `OrganizationRecord`, ~391 `OrganizationRepository`), `memory.ts`, `prisma.ts`; test `apps/api/test/org-capabilities.test.ts` (created here, grows in A3/A4).

- [ ] **Step 1: Failing test.** Create `apps/api/test/org-capabilities.test.ts` with a memory-repo pin (mirror the N1 pattern; read the memory org repo for the create-input shape first):

```ts
import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";

describe("Organization.capabilities persistence (EN-A task A2)", () => {
  it("create stores an explicit envelope; setCapabilities replaces it; null round-trips", async () => {
    const repo = new MemoryOrganizationRepository();
    const base = { name: "Caps Org", orgType: "corporate" as const, registrationId: null, jurisdiction: null,
      did: "did:key:zCaps", didSeedEncrypted: "enc", status: "active" as const, verified: false, verifiedAt: null,
      companyProfile: null, capabilities: { domains: ["identity" as const], roles: ["Issuer" as const] } };
    const o = await repo.create(base);
    expect(o.capabilities).toEqual({ domains: ["identity"], roles: ["Issuer"] });
    const tightened = await repo.setCapabilities(o.id, { domains: [], roles: [] });
    expect(tightened.capabilities).toEqual({ domains: [], roles: [] });
    const cleared = await repo.setCapabilities(o.id, null);
    expect(cleared.capabilities).toBeNull();
  });
});
```

Adapt the fixture to the REAL `OrganizationRecord` create-input (read types.ts/memory.ts — field list above is from the current record but verify).

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement — ALL IN ONE COMMIT (the parity rule):**
  - `schema.prisma`, `model Organization`: `capabilities String? // EN-A: JSON OrgCapabilities envelope; null = unrestricted legacy` → `pnpm --filter @tokenlayer/api exec prisma generate`.
  - `types.ts`: `OrganizationRecord` gains `capabilities: OrgCapabilities | null;` (import the type from `@tokenlayer/core`); `OrganizationRepository` gains `setCapabilities(id: string, caps: OrgCapabilities | null): Promise<OrganizationRecord>;`.
  - `memory.ts`: create spreads input (verify — if it builds an explicit literal, add the field); `setCapabilities` mirrors `setStatus`'s shape.
  - `prisma.ts`: org row-type + `toOrganization` mapper (`capabilities: r.capabilities ? JSON.parse(r.capabilities) : null` — model on how `companyProfile` is handled), create data (`capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null`), `setCapabilities` via `prisma.organization.update`.
  - The widened record makes every `organizations.create` call site a compile error — grep `organizations.create(` (expected: register route, `POST /orgs`/`ensureOrg`, platform-org boot in `platform-org.ts`, possibly test helpers are NOT edited — helpers construct via routes) and pass `capabilities: null` explicitly at each except the register route (A3 wires the real value; for A2 pass `null` there too so the commit is behavior-neutral).

- [ ] **Step 4: Green** — target file + full api suite (`pnpm --filter @tokenlayer/api test`, 401 + new) + `tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(api): Organization.capabilities column + setCapabilities (memory/prisma parity)`.

---

### Task A3: API — acquisition (register, direct-set, change-request kind) + threading

**Files:** modify `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`; create `apps/api/src/org-kinds.ts`; extend `apps/api/test/org-capabilities.test.ts`.

- [ ] **Step 1: Failing tests** (append a describe "capability acquisition (A3)"), covering:
1. `POST /orgs/register` with `capabilities: {domains:["identity"], roles:["Issuer","Verifier"]}` → pending org stores it (visible in the PlatformAdmin org review GET — check the review/list route's shape and assert through it) → `POST /orgs/:id/approve` → active org still carries it; `orgView` responses include `capabilities`.
2. Register WITHOUT capabilities → org has `capabilities: null` (old clients unaffected).
3. Register with bad capabilities (`domains:["defi"]`) → 400 `INVALID_CAPABILITIES`.
4. `PATCH /orgs/:id/capabilities` as PlatformAdmin → 200, applied, audit appended; as OrgAdmin → 403.
5. `POST /orgs/:id/capabilities/request` as the org's OrgAdmin → 202 proposal kind `org-capability-change`; PlatformAdmin approves → applied. OrgAdmin of ANOTHER org → 403. The proposing OrgAdmin cannot approve (403 — verify whether the block comes from SELF_APPROVAL or canApprove role gating; assert the 403, not the code).
6. Login as an OrgAdmin of an enveloped org → response `user.orgCapabilities` equals the envelope; a non-org user gets `null`.

Build fixtures through real HTTP (register → approve mirrors `apps/api/test/corporate*.test.ts` — read one for the exact document-upload/approve mechanics; if registration requires uploaded KYB document ids, reuse that test's helper approach).

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement:**
  - **Register** (routes.ts ~2061): body type += `capabilities?: unknown`; when present `validateOrgCapabilities` (PolicyError → the route's existing error mapping; confirm PolicyError becomes a 400 here — if the route lacks a catch, add an explicit try/catch returning `400 INVALID_CAPABILITIES`); store on create (`capabilities: caps ?? null`).
  - **orgView** (routes.ts:79): add `capabilities: o.capabilities`.
  - **`PATCH /orgs/:id/capabilities`** (PlatformAdmin only): validate → `setCapabilities` → audit `org-capabilities-set` → 200 orgView. Body `{capabilities: {...} | null}` (null clears back to legacy — PlatformAdmin only, deliberate).
  - **`POST /orgs/:id/capabilities/request`** (OrgAdmin, `orgScoped(claims, id)` — reuse the existing guard at routes.ts ~2325): validate → create proposal `{kind: "org-capability-change", orgId: id, useCaseKey: null, assetId: null, payload: {orgId: id, capabilities}, proposerId, proposerLabel, required: 1}` → 202. (Check the proposal-create call shape against an existing kind, e.g. the revoke route.)
  - **`apps/api/src/org-kinds.ts`**: `orgCapabilityChangeKind` — `canApprove`: PlatformAdmin only; `userScopedView`: visible to PlatformAdmin + the org's own OrgAdmin (mirror how org-scoped kinds do this — read `credential-kinds.ts` for the shape); `execute`: re-`validateOrgCapabilities(payload.capabilities)`, org must still exist (else throw coded 404 → proposal fails via existing path), `setCapabilities`, audit. Register it wherever the other kinds register (grep `registerProposalKind` — mirror `credential-usecase-kinds.ts`'s registration site).
  - **Threading**: login (~routes.ts:189) and `/me` (~193): `const org = claims.orgId ? await deps.organizations.get(claims.orgId) : null;` → add `orgCapabilities: org?.capabilities ?? null` to the returned `user`/me object. Grep for the QR-login poll's token-release payload — if it builds a parallel `user` object, thread it there too (the ID-F lesson: web gets its session from LOGIN, not /me).
  - **Schemas**: `registerOrg` body += loose `capabilities` object; new `patchOrgCapabilities` + `requestOrgCapabilities` entries (loose 200/202 + inline 400 with `additionalProperties: true` for problems — the fast-json-stringify lesson); check `login`/`me` response schemas are loose enough to carry `orgCapabilities` (they carry `useCaseDomain` today — mirror).

- [ ] **Step 4: Green** — target file + FULL api suite + tsc. No existing test edited.

- [ ] **Step 5: Commit** — `feat(api): capability acquisition — register envelope, platform set, org-capability-change kind, session threading`.

---

### Task A4: API — enforcement at the eight gates

**Files:** modify `apps/api/src/http/routes.ts` (+ `apps/api/src/usecase-kinds.ts` for the create-use-case executor if the gate lives there); extend the test file.

- [ ] **Step 1: Failing tests** (describe "capability enforcement (A4)"). Shared fixture: register+approve TWO orgs — `capped` with `{domains:["identity"], roles:["Issuer"]}` and `legacy` with no capabilities — plus OrgAdmins for each. Then one test per enforcement row, each asserting the positive (legacy org or in-envelope act succeeds) AND the 403 `ORG_CAPABILITY_MISSING` negative:
1. Credential-use-case create with `issuer: {kind:"org", orgId: capped.id}` succeeds (has Issuer+identity); same with a `{domains:["tokenization"], roles:[]}` org → 403.
2. Issue-time defense-in-depth: bind while allowed → PlatformAdmin tightens via PATCH → the org's OrgAdmin issuing now → 403.
3. Verification request by `capped`'s OrgAdmin (no Verifier) → 403; after a capability-change proposal adds Verifier → succeeds.
4. Use-case create with `verifier: {kind:"orgs", orgIds:[cappedNoVerifier.id]}` → 403 at config time.
5. Issue with `subjectOrgId` targeting an org without Holder → 403; legacy org → succeeds.
6. Org-owned TOKENIZATION use case (the gated create-use-case flow — mirror `apps/api/test/` CS-4 era tests for mechanics) for an identity-only org → 403.
7. Org-owned IDENTITY use case (`ownerOrgId`/provision rebind) for a tokenization-only org → 403.
8. Member-add filtering: `capped` (identity, Issuer only) OrgAdmin adds an Issuer member with an identity useCaseKey → 201; adds a Verifier member → 403; adds a member with a TOKENIZATION useCaseKey → 403; PlatformAdmin adding the same member to the same org → succeeds (bypass); `legacy` OrgAdmin adds anything → 201.

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement.** One shared route-file helper:

```ts
  function orgCapabilityMissing(reply: FastifyReply, org: OrganizationRecord, missing: string) {
    return reply.code(403).send({
      error: "ORG_CAPABILITY_MISSING",
      message: `organization '${org.name}' does not have the '${missing}' capability`,
      details: { orgId: org.id, missing },
    });
  }
```

Then per gate (each is a 2-5 line check using `orgRoleEnabled`/`orgDomainEnabled` right after the org is already loaded — do NOT add extra org fetches where the record is already in hand; check the shared `Error#` schema tolerates `details` — it does, `details` is declared):
- Use-case binding gates live where `issuer`/`verifier` bindings are validated on credential-use-case create/PATCH and in the provisioning rebind — grep `issuer.orgId` / `verifier` validation in routes.ts + the provision executor.
- `resolveIssuer` (~731): after `issuerOrg` resolves, if `issuer.kind === "org"` check `orgRoleEnabled(issuerOrg.capabilities, "Issuer")`.
- Verification org path (~2680-2699): after the existing orgType gate, add `Verifier` + `identity` checks.
- `subjectOrgId` path (~784-801): after target org loads, check `Holder`.
- create-use-case (tokenization) executor in `usecase-kinds.ts` + the gated wizard route: check the owner org's `tokenization` domain (execute re-loads the org — enforce there; if the drafting route also pre-checks, add it there too for a friendly early 403).
- Credential-use-case with `ownerOrgId`: check `identity` domain at create/provision.
- `POST /orgs/:id/users` (~2321): after `canCreateOrgMember`, when `claims.role !== "PlatformAdmin"` and `org.capabilities !== null`: if target role ∈ {Issuer, Holder, Verifier} require `orgRoleEnabled`; resolve the member's `useCaseKey` domain via the same catalog lookup POST /users uses (`useCaseDomainOf`) and require `orgDomainEnabled` when a key is given.

- [ ] **Step 4: Green** — full api suite + tsc; **zero existing-test edits** (legacy-null keeps every old flow byte-identical — if any existing test breaks, the null-tolerance is wrong somewhere; fix the code, never the test).

- [ ] **Step 5: Commit** — `feat(api): enforce org capability envelope at the eight org-action gates`.

---

### Task A5: Web — wizard step, pills, management, approvals arm, nav filtering

**Files:** modify `apps/web/src/types.ts`, `api.ts`, `auth.tsx` (SessionUser), `components/Signup.tsx`, `components/Organizations.tsx`, `components/ApprovalsPanel.tsx`, `App.tsx`.

- [ ] **Step 1: Types + client.** `OrgCapabilities` type (mirror core); `SessionUser.orgCapabilities?: OrgCapabilities | null`; `Org` view type += `capabilities`; api methods `setOrgCapabilities(token, id, caps)` (PATCH) and `requestOrgCapabilities(token, id, caps)` (POST …/request).
- [ ] **Step 2: Signup wizard** (`Signup.tsx` — read its step structure first): new "Capabilities" step before review — two checkbox groups (domains: Tokenization/Identity; roles: Issuer/Holder/Verifier), all pre-checked, ≥1 of each required to proceed; include `capabilities` in the register payload; review step lists the picks.
- [ ] **Step 3: Review + org page.** PlatformAdmin org review expansion (wherever KYB docs render — grep the review component): capability pills for the requested envelope ("unrestricted (legacy)" when null). `Organizations.tsx`: pills per org; PlatformAdmin edit control (checkbox popover → PATCH → reload); OrgAdmin own-org "Request change" (checkboxes → POST request → "pending approval" note).
- [ ] **Step 4: Approvals arm.** `ApprovalsPanel.summarize()` gains an `org-capability-change` arm: "«Org name» requests capabilities: identity · Issuer, Verifier" (org name from payload if present, else orgId).
- [ ] **Step 5: Nav filtering** (`App.tsx`, OrgAdmin branch only — the last branch): with `user.orgCapabilities` non-null, intersect the branch's domain switcher (filter `enabledDomains` before `availableDomains`) with the envelope's domains; hide `org-wallet` without Holder; hide `verify` without Verifier. Legacy null ⇒ untouched behavior. Member desks unchanged.
- [ ] **Step 6: Green** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` + `build`; api tsc unchanged.
- [ ] **Step 7: Commit** — `feat(web): org capability wizard step, pills, management surfaces, envelope-aware nav`.

---

### Task A6: Verify — suites + live Besu walkthrough + review + finish

- [ ] **Step 1:** typecheck core/adapters/api/web (contracts is known-broken on main — skip), core + api full suites, web build.
- [ ] **Step 2: Live Besu walkthrough** (scratchpad script + browser pass; standard boot recipe, throwaway `dev-endemo.db`, kill by port, dev.db untouched):
1. Register an org via the API choosing `{domains:["identity"], roles:["Issuer","Verifier"]}` (with KYB docs) → PlatformAdmin approves → org active with envelope (Prisma round-trip proof).
2. Org binds as issuer of a provisioned identity use case and issues a credential → ok, anchored (eth_call).
3. Org tries `subjectOrgId` holding → 403 `ORG_CAPABILITY_MISSING (Holder)`; tries an org-owned tokenization use case → 403 (domain).
4. OrgAdmin requests adding `Holder` → proposal → PlatformAdmin approves → holding now succeeds.
5. A pre-existing org (e.g. the platform boot org / a `POST /orgs` org, capabilities null) still does everything.
6. Browser: signup wizard shows the capabilities step; Organizations page shows pills; OrgAdmin of the identity-only org sees no Tokenization domain in the switcher and no Organization Wallet (until Holder is granted); Approvals inbox renders the change request readably.
- [ ] **Step 3: Final whole-branch review** — focus: null-legacy back-compat (zero existing-test drift), gate completeness vs the spec's table (adversarially check for a NINTH gate the spec missed — e.g. eligible-holders listing, org wallet route, batch issuance subjectEmail path don't need gating, but confirm batch issuance to an org and template provisioning rebind are covered), parity, no privilege widening in the new routes, proposal-kind view scoping.
- [ ] **Step 4: Finish** — superpowers:finishing-a-development-branch, standing option 1: merge `feat/org-capabilities` → main, delete branch, update the enterprise-program memory (create `enterprise-program.md`: EN-A merged; EN-B machine API access next).

---

## Self-review notes

- Spec coverage: model/predicates → A1; persistence → A2; acquisition (all four paths) + threading → A3; all eight enforcement rows → A4 tests 1-8 map 1:1 to the spec table; web surfaces → A5; walkthrough + finish → A6.
- Known unknowns flagged for implementers rather than guessed: PolicyError signature (A1), org create-input exact shape (A2), register/approve test mechanics + QR-poll user payload (A3), exact binding-validation and create-use-case gate locations (A4), Signup step structure + review component (A5).
- Naming consistent throughout: `capabilities` (column/field), `orgCapabilities` (session), `ORG_CAPABILITY_MISSING` / `INVALID_CAPABILITIES` (errors), `org-capability-change` (kind).
