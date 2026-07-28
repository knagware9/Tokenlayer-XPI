# ID-C — Entity Wallet + My Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an organization a first-class credential holder (issue-to-org + an entity wallet view), and give both an entity and a person a richer credential wallet (use-case label, issuer name, full-claims detail, VC-JWT download).

**Architecture:** API + web only — **no packages/core change**. Extend the ID-B issuance route to accept an org subject (`holderDid = org.did`, gated by the same holder policy); add `GET /orgs/:id/wallet` + a richer shared held-credential projection; add a shared web `CredentialCard`, a dedicated `OrganizationWallet` surface, and org holders in the issue form. Org-side *presentation* is deferred.

**Tech Stack:** apps/api (Fastify + Prisma/SQLite + Vitest), apps/web (React + Vite + Tailwind). Spec: `docs/superpowers/specs/2026-07-28-identity-entity-wallet-my-credentials-design.md`.

**Branch:** create `feat/identity-entity-wallet` off `main` before Task 1.

## Verified contracts (grounded in current code — do not re-derive)

- **Issuance route** `POST /credential-use-cases/:key/credentials` (`apps/api/src/http/routes.ts:432`): body today `{ credentialType, subjectUserId, claims }`; uses the `resolveIssuer` closure (line 393) then `credentialUseCaseType` (400 `UNKNOWN_CREDENTIAL_TYPE`), resolves the subject user (`404`/`SUBJECT_HAS_NO_DID`), `holderPolicyAllows` (403 `HOLDER_NOT_ELIGIBLE`), `validateMetadata` (400 `INVALID_METADATA`), then parks a proposal with payload `{ credentialUseCaseKey, credentialType, subjectDid, subjectUserId, claims, issuerOrgId }`, `required = spec.requiredApprovals`, `202`.
- **The kind** `issueUsecaseCredentialKind` (`apps/api/src/credential-usecase-kinds.ts`): `execute` reads `pl.subjectDid` (NOT subjectUserId) and calls `issueCredentialFor` — so making the subject an org needs only the ROUTE to resolve `subjectDid = org.did`; the kind is unaffected except its payload TYPE (`IssueUsecaseCredentialPayload.subjectUserId` becomes optional + add `subjectOrgId?`).
- **eligible-holders** (`routes.ts:413`): returns `{ id, email, did, orgName }[]` for DID-holding users passing `holderPolicyAllows`. `holderPolicyAllows(policy, { id, orgType } | null)` already accepts an org shape.
- **`GET /me/credentials`** (`routes.ts:1796`): `listByHolder(claims.did)` → `{ id, type: c.type.split(","), issuerDid, holderDid, claims, issuedAt, expiresAt, revoked, revokedAt, revokedReason, vcJwt }`. `credentialUseCaseKey` is ON the record (ID-B) but NOT surfaced here.
- **Org read** `orgViewWithCreds` (`routes.ts:1617`) already does `listByHolder(o.did)` — orgs already hold credentials (the KYB `OrganizationCredential`). `OrganizationRecord` has `did: string` (required) + `orgType`; `organizations.findByDid(did)`, `.get(id)`, `.list()` exist. `orgScoped(claims, orgId)` (line 141) = PlatformAdmin or the OrgAdmin of that org.
- **Response schemas are loose**: `S.myCredentials` / `S.eligibleHolders` responses are `additionalProperties: true` (arrays of open objects) — enriching a projection needs NO schema change. Only `S.issueUsecaseCredential.body` is strict (`additionalProperties: false`) — it must gain `subjectOrgId` and drop `subjectUserId` from `required`.
- **Web**: `HeldCredential` (`types.ts:337`) has no `credentialUseCaseKey`/`issuerName`. `EligibleHolder` (`types.ts:433`) = `{ id, email, did, orgName }`. `MyIdentity.tsx` renders the credential card inline (lines ~97-124) + embeds `VerificationInbox`. `IssueUsecaseCredential.tsx` reads `h.email`/`h.orgName` and submits `subjectUserId`. `App.tsx` operator-console branch (~line 126) builds `items` with conditional spreads and an if/else `panel` chain; OrgAdmin flags: `isOrgAdmin`. `IconName` (`ui.tsx:5`) includes `"coins"` (no "wallet") — use `"coins"`. `request<T>(path, token, init?)` is the api.ts helper.
- **DB**: uses `prisma db push` (no migrations). **This plan adds NO columns** — no schema/db-push needed.
- **Tests**: `apps/api/test/*.ts` use `buildTestApp`, `loginAs`, `V1`, `auth` from `helpers.js`. Approve a proposal via `POST ${V1}/proposals/:id/approve` with `payload: {}`. Seeded users have NO DIDs in-test (DID provisioning is live-boot only); mint a DID-holding subject via `POST /orgs` + `POST /orgs/:id/users` (see `apps/api/test/credential-usecase-issuance.test.ts` for the exact pattern) OR onboard one. Orgs created via `POST /orgs` DO get a DID immediately.

---

## Task 1: API — issue-to-org + eligible-holders (users + orgs)

**Files:**
- Modify: `apps/api/src/http/routes.ts` (issuance route + eligible-holders route)
- Modify: `apps/api/src/credential-usecase-kinds.ts` (payload type)
- Modify: `apps/api/src/http/schemas.ts` (`issueUsecaseCredential` body)
- Test: `apps/api/test/entity-wallet.test.ts` (new)

- [ ] **Step 1: Widen the schema body** — in `apps/api/src/http/schemas.ts`, change `S.issueUsecaseCredential.body` to:
```ts
    body: {
      type: "object", additionalProperties: false, required: ["credentialType", "claims"],
      properties: {
        credentialType: { type: "string" },
        subjectUserId: { type: "string" },
        subjectOrgId: { type: "string" },
        claims: { type: "object", additionalProperties: true },
      },
    },
```

- [ ] **Step 2: Update the kind payload type** — in `apps/api/src/credential-usecase-kinds.ts`, change `IssueUsecaseCredentialPayload`:
```ts
export interface IssueUsecaseCredentialPayload {
  credentialUseCaseKey: string;
  credentialType: string;
  subjectDid: string;
  subjectUserId?: string;
  subjectOrgId?: string;
  claims: Record<string, unknown>;
  issuerOrgId: string;
}
```
(The `execute` body is unchanged — it reads only `pl.subjectDid`, `pl.credentialUseCaseKey`, `pl.credentialType`, `pl.issuerOrgId`.)

- [ ] **Step 3: Write the failing tests** — create `apps/api/test/entity-wallet.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

async function seedUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key: "corp-kyb", name: "Corp KYB",
    credentialTypes: [{ name: "MCACredential", title: "MCA", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["cin", "companyName"], properties: { cin: { type: "string" }, companyName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);
  return DEF;
}

// A corporate org (created via POST /orgs) has a DID immediately.
async function makeOrg(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, name: string, orgType = "corporate") {
  const r = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
  expect(r.statusCode).toBe(201);
  return r.json() as { id: string; did: string; name: string };
}

describe("issue-to-org (entity holder)", () => {
  it("issues a credential to an ORG → approve → held on the org DID", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Acme Manufacturing Ltd");

    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, claims: { cin: "U74999MH2020PTC1", companyName: "Acme Manufacturing Ltd" } } });
    expect(issued.statusCode).toBe(202);
    const pid = issued.json().proposal.id;
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

    // Held on the org's DID — visible in the org wallet (Task 2 route).
    const wallet = await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) });
    expect(wallet.statusCode).toBe(200);
    const held = wallet.json() as { holderDid: string; type: string[] }[];
    expect(held.some((c) => c.holderDid === org.did && c.type.includes("MCACredential"))).toBe(true);
  });

  it("400 SUBJECT_REQUIRED when neither or both subject ids are given", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Beta Corp");
    const neither = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", claims: { cin: "x", companyName: "y" } } });
    expect(neither.statusCode).toBe(400);
    expect(neither.json().error).toBe("SUBJECT_REQUIRED");
    const both = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, subjectUserId: "u1", claims: { cin: "x", companyName: "y" } } });
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toBe("SUBJECT_REQUIRED");
  });

  it("holder policy gates an org subject", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const bank = await makeOrg(app, admin, "Some Bank", "bank");
    const corp = await makeOrg(app, admin, "Gamma Corp", "corporate");
    // policy admits only corporates
    await seedUseCase(app, admin, { key: "corp-only", holderPolicy: { who: "orgType", orgTypes: ["corporate"] } });
    const bad = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-only/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: bank.id, claims: { cin: "x", companyName: "y" } } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe("HOLDER_NOT_ELIGIBLE");
    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-only/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: corp.id, claims: { cin: "x", companyName: "y" } } });
    expect(ok.statusCode).toBe(202);
  });

  it("eligible-holders includes both user and org rows for any-onboarded", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    await makeOrg(app, admin, "Delta Corp");
    const res = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/corp-kyb/eligible-holders`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { kind: string; did: string }[];
    expect(rows.some((r) => r.kind === "org")).toBe(true);
    // every row carries a DID + a kind
    for (const r of rows) { expect(r.did).toBeTruthy(); expect(["user", "org"]).toContain(r.kind); }
  });
});
```

- [ ] **Step 4: Run tests, verify they fail**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/entity-wallet.test.ts`
Expected: FAIL (org subject not accepted; no wallet route; eligible-holders has no `kind`).

- [ ] **Step 5: Implement the issuance route subject discriminator** — in `apps/api/src/http/routes.ts`, replace the `POST /credential-use-cases/:key/credentials` handler's body-read + subject-resolution block (currently lines ~435, ~446-452) with:
```ts
    const b = request.body as { credentialType: string; subjectUserId?: string; subjectOrgId?: string; claims: Record<string, unknown> };
    const def = await deps.credentialUseCases.get(key);
    if (!def) return notFound(reply, `credential use case '${key}' not found`);
    const resolved = await resolveIssuer(reply, claims, def);
    if (!resolved) return;
    const { issuerOrg } = resolved;

    let spec;
    try { spec = credentialUseCaseType(def, b.credentialType); }
    catch (err) { return reply.code(400).send({ error: "UNKNOWN_CREDENTIAL_TYPE", message: (err as Error).message }); }

    // Subject is EXACTLY ONE of a user or an org.
    if ((!b.subjectUserId) === (!b.subjectOrgId)) {
      return reply.code(400).send({ error: "SUBJECT_REQUIRED", message: "provide exactly one of subjectUserId or subjectOrgId" });
    }
    let subjectDid: string;
    let holderOrg: { id: string; orgType: OrgType } | null;
    const subjectRef: { subjectUserId?: string; subjectOrgId?: string } = {};
    if (b.subjectUserId) {
      const subject = await deps.users.findById(b.subjectUserId);
      if (!subject) return notFound(reply, "subject user not found");
      if (!subject.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject has no decentralized identifier" });
      const org = subject.orgId ? await deps.organizations.get(subject.orgId) : null;
      subjectDid = subject.did; holderOrg = org ? { id: org.id, orgType: org.orgType } : null; subjectRef.subjectUserId = subject.id;
    } else {
      const org = await deps.organizations.get(b.subjectOrgId!);
      if (!org) return notFound(reply, "subject organization not found");
      if (!org.did) return reply.code(400).send({ error: "SUBJECT_HAS_NO_DID", message: "the subject organization has no DID" });
      subjectDid = org.did; holderOrg = { id: org.id, orgType: org.orgType }; subjectRef.subjectOrgId = org.id;
    }
    if (!holderPolicyAllows(def.holderPolicy, holderOrg)) {
      return reply.code(403).send({ error: "HOLDER_NOT_ELIGIBLE", message: "the subject is not an eligible holder for this use case" });
    }
    validateMetadata(b.claims, spec.claimSchema); // throws INVALID_METADATA → 400

    const proposal = await deps.proposals.create({
      useCaseKey: null, orgId: issuerOrg.id, assetId: null, kind: "issue-usecase-credential",
      payload: { credentialUseCaseKey: key, credentialType: spec.name, subjectDid, ...subjectRef, claims: b.claims, issuerOrgId: issuerOrg.id },
      proposerId: claims.id, proposerLabel: claims.email, required: spec.requiredApprovals,
    });
    return reply.code(202).send({ proposal });
```
`OrgType` is NOT currently imported in routes.ts — ADD it to the existing `@tokenlayer/core` import at the top (the `holderOrg` annotation references it), or the file won't typecheck.

- [ ] **Step 6: Extend eligible-holders with org rows** — in `routes.ts`, replace the `GET …/eligible-holders` body (the `out` construction) with the discriminated shape:
```ts
    const out: { kind: "user" | "org"; id: string; label: string; did: string; subLabel: string | null }[] = [];
    const users = await deps.users.list();
    for (const u of users) {
      if (!u.did) continue;
      const org = u.orgId ? await deps.organizations.get(u.orgId) : null;
      if (holderPolicyAllows(def.holderPolicy, org ? { id: org.id, orgType: org.orgType } : null)) {
        out.push({ kind: "user", id: u.id, label: u.email, did: u.did, subLabel: org?.name ?? null });
      }
    }
    const orgs = await deps.organizations.list();
    for (const o of orgs) {
      if (!o.did) continue;
      if (holderPolicyAllows(def.holderPolicy, { id: o.id, orgType: o.orgType })) {
        out.push({ kind: "org", id: o.id, label: o.name, did: o.did, subLabel: o.orgType });
      }
    }
    return out;
```

- [ ] **Step 7: Run the entity-wallet tests** — the wallet-route test (test 1) still fails until Task 2 (no `GET /orgs/:id/wallet` yet). Run just the subject/eligible tests to green:

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/entity-wallet.test.ts -t "SUBJECT_REQUIRED|holder policy|eligible-holders"`
Expected: those 3 pass. (The "issues a credential to an ORG" test needs Task 2's wallet route — it will pass after Task 2.)

- [ ] **Step 8: Typecheck + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: clean.
```bash
git add apps/api/src/http/routes.ts apps/api/src/credential-usecase-kinds.ts apps/api/src/http/schemas.ts apps/api/test/entity-wallet.test.ts
git commit -m "feat(api): issue credentials to an organization holder + eligible-holders includes orgs"
```

---

## Task 2: API — entity wallet read + richer held-credential projection

**Files:**
- Modify: `apps/api/src/http/routes.ts` (`mapHeld` helper, `GET /orgs/:id/wallet`, `GET /me/credentials`)
- Modify: `apps/api/src/http/schemas.ts` (`orgWallet` schema)
- Test: `apps/api/test/entity-wallet.test.ts` (extend)

- [ ] **Step 1: Add the `orgWallet` schema** — in `apps/api/src/http/schemas.ts`, add next to `orgCredentials`:
```ts
  orgWallet: {
    tags: ["Identity"], summary: "Credentials held by an organization (entity wallet)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401, 403, 404) },
  },
```

- [ ] **Step 2: Add the shared `mapHeld` closure** — in `apps/api/src/http/routes.ts`, near `orgViewWithCreds` (~line 1617, inside `registerRoutes`), add:
```ts
  /** Enriched held-credential projection: adds the use case + the issuer org's
   *  name (memoised per call), shared by /me/credentials and the org wallet. */
  async function mapHeld(rows: CredentialRecord[]) {
    const names = new Map<string, string | null>();
    const nameOf = async (did: string): Promise<string | null> => {
      if (!names.has(did)) names.set(did, (await deps.organizations.findByDid(did))?.name ?? null);
      return names.get(did) ?? null;
    };
    return Promise.all(rows.map(async (c) => ({
      id: c.id, type: c.type.split(","), credentialUseCaseKey: c.credentialUseCaseKey,
      issuerDid: c.issuerDid, issuerName: await nameOf(c.issuerDid), holderDid: c.holderDid,
      claims: c.subjectClaims, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
      revoked: c.revoked, revokedAt: c.revokedAt, revokedReason: c.revokedReason, vcJwt: c.vcJwt,
    })));
  }
```
`CredentialRecord` is NOT currently imported in routes.ts — ADD it to the existing `../persistence/types.js` type import (the `mapHeld` param references it), or the file won't typecheck.

- [ ] **Step 3: Route `/me/credentials` through `mapHeld`** — replace the `GET /me/credentials` handler body:
```ts
  app.get("/me/credentials", { schema: S.myCredentials, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    return mapHeld(await deps.credentials.listByHolder(claims.did));
  });
```

- [ ] **Step 4: Add `GET /orgs/:id/wallet`** — in `routes.ts`, next to `GET /orgs/:id/credentials` (~line 1924):
```ts
  app.get("/orgs/:id/wallet", { schema: S.orgWallet, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    if (!orgScoped(claims, id)) return reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to view that organization's wallet" });
    const org = await deps.organizations.get(id);
    if (!org) return notFound(reply, "organization not found");
    return mapHeld(await deps.credentials.listByHolder(org.did));
  });
```

- [ ] **Step 5: Extend the tests** — append to `apps/api/test/entity-wallet.test.ts`:
```ts
describe("entity wallet read", () => {
  it("me/credentials + org wallet carry credentialUseCaseKey + issuerName", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const org = await makeOrg(app, admin, "Epsilon Corp");
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/corp-kyb/credentials`, headers: auth(admin),
      payload: { credentialType: "MCACredential", subjectOrgId: org.id, claims: { cin: "c", companyName: "Epsilon Corp" } } });
    const pid = issued.json().proposal.id;
    await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: auth(admin2), payload: {} });

    const wallet = (await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/wallet`, headers: auth(admin) })).json() as { credentialUseCaseKey: string | null; issuerName: string | null }[];
    expect(wallet[0]!.credentialUseCaseKey).toBe("corp-kyb");
    expect(wallet[0]!.issuerName).toBeTruthy(); // the platform issuer org's name
  });

  it("org wallet is org-scoped: a foreign OrgAdmin is 403", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const orgA = await makeOrg(app, admin, "Org A");
    const orgB = await makeOrg(app, admin, "Org B");
    // an OrgAdmin of B
    await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(admin), payload: { email: "b.admin@x.io", password: "badmin123", role: "OrgAdmin" } });
    const bAdmin = await loginAs(app, "b.admin@x.io", "badmin123");
    expect((await app.inject({ method: "GET", url: `${V1}/orgs/${orgA.id}/wallet`, headers: auth(bAdmin) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${V1}/orgs/${orgB.id}/wallet`, headers: auth(bAdmin) })).statusCode).toBe(200);
  });
});
```

- [ ] **Step 6: Full entity-wallet file + typecheck + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/entity-wallet.test.ts && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: all entity-wallet tests pass (incl. Task 1's "issues to an ORG" now that the wallet route exists); typecheck clean.
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/entity-wallet.test.ts
git commit -m "feat(api): org wallet route + enriched held-credential projection (use case + issuer name)"
```

---

## Task 3: Web — types/client + shared CredentialCard + MyIdentity + issue-form holders

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`
- Create: `apps/web/src/components/CredentialCard.tsx`
- Modify: `apps/web/src/components/MyIdentity.tsx`, `apps/web/src/components/IssueUsecaseCredential.tsx`

- [ ] **Step 1: Types + client** — in `apps/web/src/types.ts`:
  - Add to `HeldCredential`: `credentialUseCaseKey?: string | null;` and `issuerName?: string | null;`.
  - Replace `EligibleHolder` with: `export interface EligibleHolder { kind: "user" | "org"; id: string; label: string; did: string; subLabel: string | null; }`.

In `apps/web/src/api.ts`:
  - Change `issueUsecaseCredential`'s body type to `{ credentialType: string; subjectUserId?: string; subjectOrgId?: string; claims: Record<string, unknown> }`.
  - Add `orgWallet: (token: string, orgId: string) => request<HeldCredential[]>(\`/orgs/${encodeURIComponent(orgId)}/wallet\`, token),`.
  (`eligibleHolders` already returns `EligibleHolder[]` — the shape change is picked up via the type.)

- [ ] **Step 2: Create the shared `CredentialCard`** — `apps/web/src/components/CredentialCard.tsx`:
```tsx
import { useState } from "react";
import type { CredentialStatusInfo, HeldCredential } from "../types.js";
import { Pill } from "./ui.js";

function truncateDid(v: string): string { return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v; }
function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}
/** Issuer label: the resolved org name, else a claim-carried org, else the DID. */
function issuerLabel(c: HeldCredential): string {
  if (c.issuerName) return c.issuerName;
  const org = c.claims.organization;
  return typeof org === "string" && org ? org : truncateDid(c.issuerDid);
}

export function CredentialCard({ credential: c, status }: { credential: HeldCredential; status?: CredentialStatusInfo }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {c.type.map((t) => <Pill key={t} tone="info">{t}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
          <Pill tone={c.revoked ? "danger" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
          {status && (status.anchored ? <Pill tone="info">anchored · {status.chainId}</Pill> : <Pill tone="muted">unanchored</Pill>)}
        </div>
      </div>
      <div className="text-xs text-slate-600"><span className="font-medium text-slate-800">{issuerLabel(c)}</span></div>
      {c.credentialUseCaseKey && <div className="text-[11px] text-slate-400">use case · {c.credentialUseCaseKey}</div>}
      <div className="text-xs text-slate-500">Issued {fmtDate(c.issuedAt)} · Expires {fmtDate(c.expiresAt)}</div>
      {c.revokedReason && <div className="text-xs text-rose-600 mt-0.5">Revoked: {c.revokedReason}</div>}
      <button className="text-[11px] font-medium text-brand-600 hover:text-brand-700" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Claims</div>
            <dl className="text-xs">
              {Object.entries(c.claims).filter(([k]) => k !== "id").map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 py-0.5">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-slate-900 font-mono text-[11px] truncate max-w-[60%] text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="text-[11px] text-slate-500 font-mono break-all">holder · {c.holderDid}</div>
          <div className="flex gap-2">
            <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(c.vcJwt)}>Copy VC-JWT</button>
            <a className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              href={`data:application/jwt;charset=utf-8,${encodeURIComponent(c.vcJwt)}`} download={`${c.type[0] ?? "credential"}-${c.id}.jwt`}>Download</a>
          </div>
        </div>
      )}
    </div>
  );
}
```
(Confirm `Pill` tones `info|ok|danger|muted` and the `brand-600` class match the project — they are used in `MyIdentity`.)

- [ ] **Step 3: MyIdentity uses CredentialCard** — in `apps/web/src/components/MyIdentity.tsx`, remove the inline card markup + the local `truncateDid`/`fmtDate`/`issuerLabel` helpers, import `CredentialCard`, and render each credential as `<CredentialCard key={c.id} credential={c} status={statuses[c.id]} />` in the existing grid. Keep the DID card, DID-document card, the `statuses` fetch, and the trailing `<VerificationInbox />` exactly as-is.

- [ ] **Step 4: Issue form supports org holders** — in `apps/web/src/components/IssueUsecaseCredential.tsx`:
  - Rename the holder state to `subjectId`/`setSubjectId` (or keep `subjectUserId` but treat as generic selection id). Track the selected holder's `kind` by looking it up in `holders`.
  - Render options with the union shape: `{holders.map((h) => <option key={`${h.kind}:${h.id}`} value={h.id}>{h.kind === "org" ? "🏢 " : ""}{h.label}{h.subLabel ? ` · ${h.subLabel}` : ""}</option>)}`.
  - In `submit`, resolve the picked holder: `const picked = holders.find((h) => h.id === subjectId)`; send `picked.kind === "org" ? { credentialType: typeName, subjectOrgId: picked.id, claims } : { credentialType: typeName, subjectUserId: picked.id, claims }`. Guard `if (!picked) { setErr("pick a holder"); return; }`.

- [ ] **Step 5: Typecheck + build + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean.
```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/CredentialCard.tsx apps/web/src/components/MyIdentity.tsx apps/web/src/components/IssueUsecaseCredential.tsx
git commit -m "feat(web): shared CredentialCard (detail + VC download) + issue-form org holders"
```

---

## Task 4: Web — Organization Wallet surface + nav

**Files:**
- Create: `apps/web/src/components/OrganizationWallet.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create `OrganizationWallet.tsx`** — `apps/web/src/components/OrganizationWallet.tsx`:
```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { CredentialStatusInfo, HeldCredential } from "../types.js";
import { Card, EmptyState, SectionHeader, Skeleton } from "./ui.js";
import { CredentialCard } from "./CredentialCard.js";

/** The signed-in OrgAdmin's ENTITY wallet: credentials held by the org's own DID. */
export function OrganizationWallet(): JSX.Element {
  const { token, user } = useAuth();
  const orgId = user?.orgId ?? null;
  const [creds, setCreds] = useState<HeldCredential[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CredentialStatusInfo>>({});

  useEffect(() => {
    if (!token || !orgId) { setCreds([]); return; }
    void api.orgWallet(token, orgId).then(setCreds).catch(() => setCreds([]));
  }, [token, orgId]);

  useEffect(() => {
    if (!creds?.length) return;
    void Promise.all(creds.map((c) => api.credentialStatus(c.id).then((s) => [c.id, s] as const).catch(() => null)))
      .then((rows) => setStatuses(Object.fromEntries(rows.filter(Boolean) as (readonly [string, CredentialStatusInfo])[])));
  }, [creds]);

  if (!orgId) {
    return (
      <div>
        <SectionHeader title="Organization wallet" />
        <Card><EmptyState icon="shield" title="No organization" hint="This account is not affiliated with an organization." /></Card>
      </div>
    );
  }
  return (
    <div>
      <SectionHeader title="Organization wallet" description="Verifiable credentials held by your organization as an entity." />
      {creds === null ? <Card><Skeleton lines={4} /></Card>
        : creds.length === 0 ? <Card><EmptyState icon="doc" title="No credentials yet" hint="Credentials issued to your organization will appear here." /></Card>
        : <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{creds.map((c) => <CredentialCard key={c.id} credential={c} status={statuses[c.id]} />)}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Wire the nav** — in `apps/web/src/App.tsx` operator-console branch, add to `items` (after the `identity` spread):
```tsx
    ...(isOrgAdmin ? [{ id: "org-wallet", label: "Organization Wallet", icon: "coins" as const }] : []),
```
add a panel branch (next to `view === "identity"`):
```tsx
  } else if (view === "org-wallet") {
    panel = <OrganizationWallet />;
```
and import it at the top: `import { OrganizationWallet } from "./components/OrganizationWallet.js";`.

- [ ] **Step 3: Typecheck + build + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean.
```bash
git add apps/web/src/components/OrganizationWallet.tsx apps/web/src/App.tsx
git commit -m "feat(web): Organization Wallet surface + OrgAdmin nav"
```

---

## Task 5: Verify — full suite + live browser walkthrough + finish

**Files:** none.

- [ ] **Step 1: Full workspace gate**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s typecheck && pnpm -s --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build`
Expected: typecheck clean across all packages; api suite green; web builds. (Core is unchanged, but run `pnpm -s --filter @tokenlayer/core test` too for completeness.)

- [ ] **Step 2: Boot live stack** — for a clean live demo, a fresh chain avoids the persistent-Besu nonce collision noted in ID-B: `make besu-down && make besu-up`, wait for blocks, then `bash scripts/dev-boot.sh` (it re-seeds under the current DID_MASTER_KEY). If the shared Besu can't be reset, a Besu-only boot still exercises the credential runtime. Start the web preview.

- [ ] **Step 3: Live API walkthrough (curl)** against `http://localhost:4000/api/v1`, as `admin@tokenlayer.dev`/`admin123` (+ `admin2` for approval):
  1. Create a corporate org (`POST /orgs`), note its `id` + `did`.
  2. `GET /credential-use-cases/corp-trade-credentials/eligible-holders` → the new org appears with `kind:"org"`.
  3. Issue an MCA credential to the org (`subjectOrgId`) → `202` → approve as admin2.
  4. `GET /orgs/:id/wallet` → the credential is held on the org DID, with `credentialUseCaseKey` + `issuerName`, and (on real Besu) `GET /credentials/:id/status` shows `anchored`.
  Capture outputs as proof.

- [ ] **Step 4: Live browser walkthrough** — log in as PlatformAdmin → Identity → a use-case card → Issue credential → pick the corporate **org** as holder → submit → approve (Approvals). Log in as that corporate's OrgAdmin → **Organization Wallet** → the credential shows with use-case + issuer labels → open **Details** → **Download** the VC-JWT. Also open **My Credentials** for a user holder to confirm the shared card renders. Screenshot the key states.

- [ ] **Step 5: Finish the branch** — use `superpowers:finishing-a-development-branch` (verify tests pass, then present the options; merge locally to `main` per this program's pattern unless the user chooses otherwise).

---

## Self-review checklist (author)

- **Spec coverage:** issue-to-org (T1) ✓; eligible-holders users+orgs (T1) ✓; entity wallet read + richer projection (T2) ✓; shared CredentialCard + detail/download + MyIdentity (T3) ✓; issue-form org holders (T3) ✓; Organization Wallet + nav (T4) ✓; live verify (T5) ✓. Org-side presentation correctly OUT of scope.
- **Type consistency:** `EligibleHolder` union `{kind,id,label,did,subLabel}` identical across api projection (T1 Step 6), web type (T3 Step 1), and both consumers (IssueUsecaseCredential T3 Step 4). `HeldCredential` gains `credentialUseCaseKey?`+`issuerName?` (T3) matching the `mapHeld` projection (T2 Step 2) consumed by `CredentialCard` (T3) + `OrganizationWallet` (T4). `subjectOrgId` flows: schema (T1 S1) → route (T1 S5) → payload type (T1 S2) → api client (T3 S1) → issue form (T3 S4). `orgWallet` client (T3) ↔ route (T2 S4).
- **Placeholder scan:** none — every step has real code; the Task-1 note that one test passes only after Task 2 is an explicit sequencing note, not a placeholder.
- **No core / no DB migration:** confirmed — ID-C adds no packages/core change and no Prisma column (`credentialUseCaseKey` already exists from ID-B).
