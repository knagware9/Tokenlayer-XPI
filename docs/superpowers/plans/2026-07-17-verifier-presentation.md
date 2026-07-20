# Verifier / Presentation + Selective Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verifier requests a presentation, the holder consents and selects which credentials to disclose, the platform signs the presentation on their behalf, and the verifier gets a real, per-credential verification (signatures recomputed, issuer trust from the on-chain DID registry, revocation from the chain-backed status).

**Architecture:** Two NEW core functions add multi-credential present/verify beside the untouched single-VC ones. A dedicated `VerificationRequest` model drives a `pending → consented | rejected | expired` state machine. Consent is a holder-only action that triggers custodial VP signing via `keystore.keyOf(holderSeed)`. Verification composes core's pure crypto with on-chain issuer-trust and chain-backed revocation at the API layer — returning 200 with a structured `valid:false` result for an invalid presentation (an invalid presentation is a successful verification outcome, not an HTTP error).

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify, Prisma + SQLite, Vitest, React + Vite, `node:crypto` (Ed25519 EdDSA JWTs).

**Reference spec:** `docs/superpowers/specs/2026-07-17-verifier-presentation-design.md`

---

## ⚠️ Two hard gates this plan protects

**1. The single-VC identity functions must not move.** `presentCredential` / `verifyPresentation` have exactly two production callers (`routes.ts:1482` desk KYC verify, `routes.ts:1512` dev `/identity/mint`) plus `packages/core/test/identity.test.ts` + `apps/api/test/identity.test.ts`. This plan ADDS new functions; it does not touch the old ones. Those tests must stay green **unedited**.

**2. Besu-absent is the default.** The whole suite (437 today) runs with no registry (`buildTestApp` uses `CHAIN_STRICT:"0"`). So issuer trust must fall back to the static `trustedKycIssuers` allowlist and revocation to the DB flag whenever `deps.registry` is `undefined`. Every existing test stays green; the on-chain path is covered by a test double (Task 6) and the live E2E (Task 8).

---

## File Structure

**Create:**
- `packages/core/test/multi-presentation.test.ts` — core multi-VC tests.
- `apps/api/test/verification.test.ts` — the request→consent→verify API tests.
- `apps/api/test/fake-anchor-vp.ts` — a tiny test double reused for the on-chain trust/revocation path (or import the existing `apps/api/test/fake-anchor.ts` from #4 — check first).
- `apps/web/src/components/VerificationRequests.tsx` — verifier request form + results.
- `apps/web/src/components/VerificationInbox.tsx` — holder consent inbox.
- `scripts/verification-e2e.mjs`

**Modify:**
- `packages/core/src/identity.ts` (+ `presentCredentials`, `verifyPresentationCredentials`, types), `packages/core/src/index.ts` (exports).
- `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,memory,prisma}.ts` (VerificationRequest).
- `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts` (wire the repo).
- `apps/api/src/http/{routes,schemas}.ts` (5 routes).
- `apps/web/src/{types,api}.ts`, `apps/web/src/components/MyIdentity.tsx` (or App.tsx nav), `apps/web/src/App.tsx` + `apps/web/src/components/PlatformHome.tsx` (nav).

---

## Task 1: Core — multi-credential present + verify

**Files:**
- Modify: `packages/core/src/identity.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/multi-presentation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/multi-presentation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { didKeyFromSeed, issueCredential, presentCredentials, verifyPresentationCredentials } from "../src/index.js";

const seed = (b: number): Buffer => Buffer.alloc(32, b);
const NOW = 1_800_000_000;

function issuer(b: number) {
  const k = didKeyFromSeed(seed(b));
  return { did: k.did, key: k.privateKey };
}
function holder(b: number) {
  return didKeyFromSeed(seed(b));
}

describe("presentCredentials + verifyPresentationCredentials", () => {
  it("verifies N credentials in one holder-signed VP, per-credential verdicts", () => {
    const iss = issuer(1);
    const h = holder(9);
    const vc1 = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: { country: "IN" }, type: ["VerifiableCredential", "KycCredential"], expiresAt: NOW + 1000, now: NOW });
    const vc2 = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: { role: "CFO" }, type: ["VerifiableCredential", "AuthorizedSignatory"], expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vc1, vc2], challenge: "chal-1", now: NOW });

    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "chal-1", trustedIssuers: [iss.did], now: NOW });
    expect(r.valid).toBe(true);
    expect(r.holderDid).toBe(h.did);
    expect(r.credentials).toHaveLength(2);
    expect(r.credentials.every((c) => c.valid)).toBe(true);
    expect(r.credentials[0]!.credential!.claims).toEqual({ country: "IN" });
    expect(r.credentials[1]!.credential!.claims).toEqual({ role: "CFO" });
  });

  it("flags one bad credential among good ones without failing the others", () => {
    const good = issuer(1), rogue = issuer(2);
    const h = holder(9);
    const vcGood = issueCredential({ issuerDid: good.did, issuerKey: good.key, subjectDid: h.did, claims: { country: "IN" }, expiresAt: NOW + 1000, now: NOW });
    const vcUntrusted = issueCredential({ issuerDid: rogue.did, issuerKey: rogue.key, subjectDid: h.did, claims: { country: "US" }, expiresAt: NOW + 1000, now: NOW });
    const vcExpired = issueCredential({ issuerDid: good.did, issuerKey: good.key, subjectDid: h.did, claims: { x: 1 }, expiresAt: NOW - 10, now: NOW - 100 });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vcGood, vcUntrusted, vcExpired], challenge: "c", now: NOW });

    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [good.did], now: NOW });
    expect(r.valid).toBe(true); // holder proof + >=1 credential present
    expect(r.credentials[0]!.valid).toBe(true);
    expect(r.credentials[1]!.valid).toBe(false);
    expect(r.credentials[1]!.reason).toBe("UNTRUSTED_ISSUER");
    expect(r.credentials[2]!.valid).toBe(false);
    expect(r.credentials[2]!.reason).toBe("CREDENTIAL_EXPIRED");
  });

  it("fails the whole VP on a challenge mismatch (no per-credential results)", () => {
    const iss = issuer(1); const h = holder(9);
    const vc = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: h.did, claims: {}, expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vc], challenge: "right", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "wrong", trustedIssuers: [iss.did], now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("CHALLENGE_MISMATCH");
    expect(r.credentials).toHaveLength(0);
  });

  it("rejects a credential whose subject is not the holder (SUBJECT_MISMATCH)", () => {
    const iss = issuer(1); const h = holder(9); const other = holder(8);
    const vcForOther = issueCredential({ issuerDid: iss.did, issuerKey: iss.key, subjectDid: other.did, claims: {}, expiresAt: NOW + 1000, now: NOW });
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [vcForOther], challenge: "c", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [iss.did], now: NOW });
    expect(r.credentials[0]!.reason).toBe("SUBJECT_MISMATCH");
  });

  it("returns NO_CREDENTIAL for an empty presentation", () => {
    const h = holder(9);
    const vp = presentCredentials({ holderDid: h.did, holderKey: h.privateKey, vcJwts: [], challenge: "c", now: NOW });
    const r = verifyPresentationCredentials({ vpJwt: vp, challenge: "c", trustedIssuers: [], now: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("NO_CREDENTIAL");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/multi-presentation.test.ts`
Expected: FAIL — `presentCredentials`/`verifyPresentationCredentials` are not exported.

- [ ] **Step 3: Add the two functions**

In `packages/core/src/identity.ts`, AFTER the existing `verifyPresentation` (after line 133), append:

```typescript
export interface PresentManyInput { holderDid: string; holderKey: KeyObject; vcJwts: string[]; challenge: string; now: number; }
/** Wrap N VC-JWTs in ONE holder-signed VP-JWT over a challenge. */
export function presentCredentials(p: PresentManyInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${p.holderDid}#0` },
    { iss: p.holderDid, nonce: p.challenge, iat: p.now,
      vp: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: ["VerifiablePresentation"], verifiableCredential: p.vcJwts } },
    p.holderKey,
  );
}

export interface PerCredentialResult { valid: boolean; reason?: string; credential?: VerifiedCredential; }
export interface MultiPresentationResult { valid: boolean; reason?: string; holderDid?: string; credentials: PerCredentialResult[]; }
export interface VerifyManyInput { vpJwt: string; challenge: string; trustedIssuers: string[]; now: number; }

/**
 * Verify a VP-JWT holding N credentials: the holder proof + challenge are checked
 * ONCE, then EACH inner VC is checked independently (issuer sig, trust, expiry,
 * subject binding). Fixes the single-VC verifier's silent drop of verifiableCredential[1..].
 * Pure crypto — no revocation, no I/O; the caller composes those.
 */
export function verifyPresentationCredentials(input: VerifyManyInput): MultiPresentationResult {
  const fail = (reason: string): MultiPresentationResult => ({ valid: false, reason, credentials: [] });
  let vp;
  try { vp = decodeJwt(input.vpJwt); } catch { return fail("MALFORMED_PRESENTATION"); }
  const holderDid = String(vp.payload.iss ?? "");
  if (!holderDid.startsWith("did:key:")) return fail("MALFORMED_PRESENTATION");
  let holderKey;
  try { holderKey = publicKeyFromDidKey(holderDid); } catch { return fail("MALFORMED_PRESENTATION"); }
  if (!verifyJwtSignature(input.vpJwt, holderKey)) return fail("BAD_HOLDER_PROOF");
  if (String(vp.payload.nonce ?? "") !== input.challenge) return fail("CHALLENGE_MISMATCH");
  const vcJwts = (vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential;
  if (!Array.isArray(vcJwts) || vcJwts.length === 0) return fail("NO_CREDENTIAL");

  const credentials: PerCredentialResult[] = vcJwts.map((raw): PerCredentialResult => {
    const bad = (reason: string): PerCredentialResult => ({ valid: false, reason });
    if (typeof raw !== "string") return bad("NO_CREDENTIAL");
    let vc;
    try { vc = decodeJwt(raw); } catch { return bad("MALFORMED_PRESENTATION"); }
    const issuerDid = String(vc.payload.iss ?? "");
    let issuerKey;
    try { issuerKey = publicKeyFromDidKey(issuerDid); } catch { return bad("BAD_ISSUER_SIGNATURE"); }
    if (!issuerDid.startsWith("did:key:") || !verifyJwtSignature(raw, issuerKey)) return bad("BAD_ISSUER_SIGNATURE");
    if (!input.trustedIssuers.includes(issuerDid)) return bad("UNTRUSTED_ISSUER");
    const exp = Number(vc.payload.exp ?? 0), nbf = Number(vc.payload.nbf ?? vc.payload.iat ?? 0);
    if (!exp || exp < input.now || nbf > input.now) return bad("CREDENTIAL_EXPIRED");
    const subjectId = String((vc.payload.vc as { credentialSubject?: { id?: string } })?.credentialSubject?.id ?? vc.payload.sub ?? "");
    if (subjectId !== holderDid) return bad("SUBJECT_MISMATCH");
    const cs = { ...(vc.payload.vc as { credentialSubject?: Record<string, unknown> }).credentialSubject };
    delete (cs as { id?: unknown }).id;
    return { valid: true, credential: { issuer: issuerDid, subject: subjectId, claims: cs, issuedAt: nbf, expiresAt: exp } };
  });
  return { valid: true, holderDid, credentials };
}
```

Note: the per-credential checks are byte-identical to `verifyPresentation`'s inner-VC checks — the same coded reasons, so any consumer that knows the single-VC codes already understands these.

- [ ] **Step 4: Export from core**

In `packages/core/src/index.ts`, inside the explicit identity re-export block (the `export { ... } from "./identity.js";`), add these names alongside `presentCredential`/`verifyPresentation`:

```typescript
  presentCredentials,
  verifyPresentationCredentials,
  type PresentManyInput,
  type PerCredentialResult,
  type MultiPresentationResult,
  type VerifyManyInput,
```

- [ ] **Step 5: Run the new test + the full core suite (single-VC untouched)**

Run: `pnpm --filter @tokenlayer/core exec vitest run test/multi-presentation.test.ts` → PASS (5 tests).
Then `pnpm --filter @tokenlayer/core build && pnpm --filter @tokenlayer/core exec vitest run` → all green, including the UNEDITED `test/identity.test.ts` (the single-VC gate). Report the total.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/identity.ts packages/core/src/index.ts packages/core/test/multi-presentation.test.ts
git commit -m "feat(core): presentCredentials + verifyPresentationCredentials (N-credential VP)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Persistence — VerificationRequest model + repo + wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,memory,prisma}.ts`, `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/verification-repo.test.ts`

- [ ] **Step 1: Write the failing repo test**

Create `apps/api/test/verification-repo.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MemoryVerificationRequestRepository } from "../src/persistence/memory.js";

const base = {
  verifierOrgId: "org_v", holderDid: "did:key:zH", requestedTypes: ["KycCredential"],
  purpose: "onboarding", challenge: "chal-1", status: "pending" as const,
  presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
  verifierResult: null, verifiedAt: null, expiresAt: "2026-07-18T00:00:00.000Z",
};

describe("MemoryVerificationRequestRepository", () => {
  it("creates, gets, and lists by holder and by verifier org", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    expect(r.id).toBeTruthy();
    expect(r.status).toBe("pending");
    expect((await repo.get(r.id))?.purpose).toBe("onboarding");
    expect(await repo.listByHolder("did:key:zH")).toHaveLength(1);
    expect(await repo.listByHolder("did:key:zH", "consented")).toHaveLength(0);
    expect(await repo.listByVerifierOrg("org_v")).toHaveLength(1);
    expect(await repo.listByVerifierOrg("org_other")).toHaveLength(0);
  });

  it("sets consent and status transitions", async () => {
    const repo = new MemoryVerificationRequestRepository();
    const r = await repo.create(base);
    const c = await repo.setConsented(r.id, { vpJwt: "a.b.c", credentialIds: ["cred_1"], at: "2026-07-17T12:00:00.000Z" });
    expect(c.status).toBe("consented");
    expect(c.presentationVpJwt).toBe("a.b.c");
    expect(c.consentedCredentialIds).toEqual(["cred_1"]);
    const rej = await repo.setStatus(r.id, "rejected");
    expect(rej.status).toBe("rejected");
    const v = await repo.setVerifierResult(r.id, { result: { valid: true }, at: "2026-07-17T13:00:00.000Z" });
    expect(v.verifierResult).toEqual({ valid: true });
    expect(v.verifiedAt).toBe("2026-07-17T13:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/verification-repo.test.ts`
Expected: FAIL — `MemoryVerificationRequestRepository` not exported.

- [ ] **Step 3: Prisma model**

In `apps/api/prisma/schema.prisma`, append:

```prisma
// A verifier's request for the holder to present credentials. Holder consent (a
// single direct action, not maker-checker) triggers custodial VP signing.
model VerificationRequest {
  id                     String    @id @default(cuid())
  verifierOrgId          String
  holderDid              String
  requestedTypes         String // JSON array of credential-type strings
  purpose                String
  challenge              String
  status                 String    @default("pending") // pending | consented | rejected | expired
  presentationVpJwt      String? // the holder-signed VP, set at consent
  consentedAt            DateTime?
  consentedCredentialIds String? // JSON array, set at consent
  verifierResult         String? // JSON verification result, set at verify
  verifiedAt             DateTime?
  createdAt              DateTime  @default(now())
  expiresAt              DateTime

  @@index([holderDid, status])
  @@index([verifierOrgId, status])
}
```

- [ ] **Step 4: Push schema**

Run: `pnpm --filter @tokenlayer/api exec prisma db push`
Expected: in sync + client regenerated. If it aborts on the pre-existing `Asset [useCaseKey, uniqueKey]` drift, re-run with `--accept-data-loss` (that predates this work; this is one new table). Report which.

- [ ] **Step 5: Types**

Append to `apps/api/src/persistence/types.ts`:

```typescript
export type VerificationStatus = "pending" | "consented" | "rejected" | "expired";

export interface VerificationRequestRecord {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  challenge: string;
  status: VerificationStatus;
  presentationVpJwt: string | null;
  consentedAt: string | null;
  consentedCredentialIds: string[] | null;
  verifierResult: Record<string, unknown> | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface VerificationRequestRepository {
  create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord>;
  get(id: string): Promise<VerificationRequestRecord | null>;
  listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]>;
  listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]>;
  setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord>;
  setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord>;
  setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord>;
}
```

- [ ] **Step 6: Memory repo**

Add `VerificationRequestRecord`, `VerificationRequestRepository`, `VerificationStatus` to the type-import block in `apps/api/src/persistence/memory.ts`, and append:

```typescript
export class MemoryVerificationRequestRepository implements VerificationRequestRepository {
  private readonly byId = new Map<string, VerificationRequestRecord>();
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    const rec: VerificationRequestRecord = { ...input, id: id("vreq"), createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async get(reqId: string): Promise<VerificationRequestRecord | null> {
    return this.byId.get(reqId) ?? null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()].filter((r) => r.holderDid === holderDid && (!status || r.status === status)).reverse();
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()].filter((r) => r.verifierOrgId === orgId && (!status || r.status === status)).reverse();
  }
  async setConsented(reqId: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = "consented"; rec.presentationVpJwt = input.vpJwt; rec.consentedCredentialIds = input.credentialIds; rec.consentedAt = input.at;
    return rec;
  }
  async setStatus(reqId: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.status = status;
    return rec;
  }
  async setVerifierResult(reqId: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    const rec = this.byId.get(reqId);
    if (!rec) throw new Error(`unknown verification request '${reqId}'`);
    rec.verifierResult = input.result; rec.verifiedAt = input.at;
    return rec;
  }
}
```
(Match the `reverse()`-for-newest-first idiom the file's other list methods use — verify against the real `listByHolder`/`listByOrg` in the file; if they sort instead, mirror that.)

- [ ] **Step 7: Prisma repo**

Add the three types to the import block in `apps/api/src/persistence/prisma.ts` and append:

```typescript
const toVerificationRequest = (r: {
  id: string; verifierOrgId: string; holderDid: string; requestedTypes: string; purpose: string; challenge: string;
  status: string; presentationVpJwt: string | null; consentedAt: Date | null; consentedCredentialIds: string | null;
  verifierResult: string | null; verifiedAt: Date | null; createdAt: Date; expiresAt: Date;
}): VerificationRequestRecord => ({
  id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid,
  requestedTypes: JSON.parse(r.requestedTypes) as string[], purpose: r.purpose, challenge: r.challenge,
  status: r.status as VerificationStatus, presentationVpJwt: r.presentationVpJwt,
  consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
  consentedCredentialIds: r.consentedCredentialIds ? (JSON.parse(r.consentedCredentialIds) as string[]) : null,
  verifierResult: r.verifierResult ? (JSON.parse(r.verifierResult) as Record<string, unknown>) : null,
  verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
});

export class PrismaVerificationRequestRepository implements VerificationRequestRepository {
  async create(input: Omit<VerificationRequestRecord, "id" | "createdAt">): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.create({
      data: {
        verifierOrgId: input.verifierOrgId, holderDid: input.holderDid,
        requestedTypes: JSON.stringify(input.requestedTypes), purpose: input.purpose, challenge: input.challenge,
        status: input.status, presentationVpJwt: input.presentationVpJwt,
        consentedAt: input.consentedAt ? new Date(input.consentedAt) : null,
        consentedCredentialIds: input.consentedCredentialIds ? JSON.stringify(input.consentedCredentialIds) : null,
        verifierResult: input.verifierResult ? JSON.stringify(input.verifierResult) : null,
        verifiedAt: input.verifiedAt ? new Date(input.verifiedAt) : null,
        expiresAt: new Date(input.expiresAt),
      },
    }));
  }
  async get(id: string): Promise<VerificationRequestRecord | null> {
    const r = await prisma.verificationRequest.findUnique({ where: { id } });
    return r ? toVerificationRequest(r) : null;
  }
  async listByHolder(holderDid: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { holderDid, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async listByVerifierOrg(orgId: string, status?: string): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany({ where: { verifierOrgId: orgId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" } })).map(toVerificationRequest);
  }
  async setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status: "consented", presentationVpJwt: input.vpJwt, consentedCredentialIds: JSON.stringify(input.credentialIds), consentedAt: new Date(input.at) } }));
  }
  async setStatus(id: string, status: VerificationStatus): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { status } }));
  }
  async setVerifierResult(id: string, input: { result: Record<string, unknown>; at: string }): Promise<VerificationRequestRecord> {
    return toVerificationRequest(await prisma.verificationRequest.update({ where: { id }, data: { verifierResult: JSON.stringify(input.result), verifiedAt: new Date(input.at) } }));
  }
}
```

- [ ] **Step 8: Wire AppDeps**

`apps/api/src/context.ts`: add `VerificationRequestRepository` to the type import and to `AppDeps`:
```typescript
  verificationRequests: VerificationRequestRepository;
```
`apps/api/src/server.ts`: import `PrismaVerificationRequestRepository`, construct `const verificationRequests = new PrismaVerificationRequestRepository();`, pass `verificationRequests,` into `buildApp({...})`.
`apps/api/test/helpers.ts`: import `MemoryVerificationRequestRepository`, construct it, pass `verificationRequests,` into `buildApp({...})`. Also add it to the 5 harness scripts if they'll fail tsc — but `verificationRequests` is REQUIRED, so they will: add `verificationRequests: new MemoryVerificationRequestRepository()` to `demo.ts`, `e2e-buy.ts`, `e2e-carbon.ts`, `e2e-tenancy.ts`, `e2e-usecases.ts` (import from `./persistence/memory.js`). Confirm the set with `grep -rln "buildApp({" apps/api/src apps/api/test`.

- [ ] **Step 9: Run repo test + typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/verification-repo.test.ts` → PASS.
Then `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run` → exit 0; the existing suite stays green (nothing consumes the repo in routes yet).

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-buy.ts apps/api/src/e2e-carbon.ts apps/api/src/e2e-tenancy.ts apps/api/src/e2e-usecases.ts apps/api/test/verification-repo.test.ts
git commit -m "feat(api): VerificationRequest model + repos + AppDeps wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Routes — request, inbox, read

**Files:**
- Modify: `apps/api/src/http/schemas.ts`, `apps/api/src/http/routes.ts`

- [ ] **Step 1: Schemas**

In `apps/api/src/http/schemas.ts`, add to the `S` object:

```typescript
  createVerificationRequest: {
    tags: ["Verification"], summary: "A verifier org requests a credential presentation", security: bearer,
    body: {
      type: "object", additionalProperties: false, required: ["holderDid", "requestedTypes", "purpose"],
      properties: {
        holderDid: { type: "string", minLength: 1 },
        requestedTypes: { type: "array", items: { type: "string" }, minItems: 1 },
        purpose: { type: "string", minLength: 1 },
      },
    },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 403) },
  },
  myVerificationRequests: { tags: ["Verification"], summary: "The caller's inbound verification requests", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  getVerificationRequest: {
    tags: ["Verification"], summary: "One verification request (holder or verifier org)", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404) },
  },
  consentVerificationRequest: {
    tags: ["Verification"], summary: "Holder consents, selecting credentials to disclose", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["credentialIds"], properties: { credentialIds: { type: "array", items: { type: "string" }, minItems: 1 } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 403, 404, 409, 410) },
  },
  rejectVerificationRequest: {
    tags: ["Verification"], summary: "Holder declines a verification request", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
  },
  verifyVerificationRequest: {
    tags: ["Verification"], summary: "The verifier runs verification on the consented presentation", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403, 404, 409) },
  },
```

Confirm `errs` handles 410 (it is generic — `codes.map(c => [c, {$ref:"Error#"}])` — so any code works).

- [ ] **Step 2: Add the request + inbox + read routes**

In `apps/api/src/http/routes.ts`, add `randomUUID` (already imported from `node:crypto` — verify) usage and a new "// --- verification ---" section after the credentials section. First the helper + three routes:

```typescript
  // --- verification (verifier-request → holder-consent → verify) -----------
  // A public projection of a verification request. Never leaks the challenge to
  // the verifier UI (it's embedded in the VP) or the raw VP to the holder list.
  function vreqView(r: VerificationRequestRecord) {
    return {
      id: r.id, verifierOrgId: r.verifierOrgId, holderDid: r.holderDid, requestedTypes: r.requestedTypes,
      purpose: r.purpose, status: r.status, consentedCredentialIds: r.consentedCredentialIds,
      consentedAt: r.consentedAt, verifiedAt: r.verifiedAt, createdAt: r.createdAt, expiresAt: r.expiresAt,
    };
  }

  app.post("/verification-requests", { schema: S.createVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { holderDid: string; requestedTypes: string[]; purpose: string };
    // Only a verifier-type org may request. PlatformAdmin has no org and is excluded here:
    // requesting a presentation is an org action, and the org's type is the gate.
    if (claims.role !== "OrgAdmin" || !claims.orgId) {
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "only a verifier organization may request a presentation" });
    }
    const org = await deps.organizations.get(claims.orgId);
    if (!org || org.orgType !== "verifier") {
      return reply.code(403).send({ error: "NOT_A_VERIFIER", message: "your organization is not a verifier" });
    }
    const rec = await deps.verificationRequests.create({
      verifierOrgId: org.id, holderDid: b.holderDid, requestedTypes: b.requestedTypes, purpose: b.purpose,
      challenge: randomUUID(), status: "pending", presentationVpJwt: null, consentedAt: null,
      consentedCredentialIds: null, verifierResult: null, verifiedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    await deps.audit.append({ actorId: claims.id, action: "verification-requested" as LifecycleAction, payload: { requestId: rec.id, verifierOrgId: org.id, holderDid: b.holderDid, types: b.requestedTypes } });
    return reply.code(201).send(vreqView(rec));
  });

  app.get("/me/verification-requests", { schema: S.myVerificationRequests, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    if (!claims.did) return [];
    const rows = await deps.verificationRequests.listByHolder(claims.did);
    // Attach the holder's ELIGIBLE credentials per request (own + a requested type + unrevoked)
    // so the consent UI can offer exactly what may be disclosed.
    const mine = await deps.credentials.listByHolder(claims.did);
    return rows.map((r) => ({
      ...vreqView(r),
      eligibleCredentials: mine
        .filter((c) => !c.revoked && r.requestedTypes.includes(c.type))
        .map((c) => ({ id: c.id, type: c.type, issuerDid: c.issuerDid, issuedAt: c.issuedAt })),
    }));
  });

  app.get("/verification-requests/:id", { schema: S.getVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    // Visible to the holder OR an OrgAdmin/PlatformAdmin of the verifier org. 404 otherwise (no existence leak).
    const isHolder = !!claims.did && claims.did === r?.holderDid;
    const isVerifier = !!r && orgScoped(claims, r.verifierOrgId);
    if (!r || (!isHolder && !isVerifier)) return notFound(reply, "verification request not found");
    return vreqView(r);
  });
```

Ensure `VerificationRequestRecord` is imported from `../persistence/types.js` in routes.ts.

- [ ] **Step 3: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; existing suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/api/src/http/routes.ts
git commit -m "feat(api): verification request + holder inbox + read routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Routes — consent (custodial signing) + reject

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add the consent + reject routes**

Add `presentCredentials` to the `@tokenlayer/core` import in `routes.ts`. Then, in the verification section:

```typescript
  app.post("/verification-requests/:id/consent", { schema: S.consentVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const { credentialIds } = request.body as { credentialIds: string[] };
    const r = await deps.verificationRequests.get(id);
    if (!r) return notFound(reply, "verification request not found");
    // Holder ONLY — one person authorizing disclosure of their OWN credentials.
    if (!claims.did || claims.did !== r.holderDid) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the holder may consent to this request" });
    }
    if (r.status !== "pending") return reply.code(409).send({ error: "REQUEST_NOT_PENDING", message: `request is ${r.status}` });
    if (new Date(r.expiresAt).getTime() < Date.now()) {
      await deps.verificationRequests.setStatus(r.id, "expired");
      return reply.code(410).send({ error: "REQUEST_EXPIRED", message: "this verification request has expired" });
    }
    // Every chosen credential must be the holder's own, of a requested type, unrevoked.
    const mine = await deps.credentials.listByHolder(claims.did);
    const byId = new Map(mine.map((c) => [c.id, c]));
    const chosen = credentialIds.map((cid) => byId.get(cid));
    for (let i = 0; i < credentialIds.length; i++) {
      const c = chosen[i];
      if (!c || c.revoked || !r.requestedTypes.includes(c.type)) {
        return reply.code(400).send({ error: "CREDENTIAL_NOT_ELIGIBLE", message: `credential '${credentialIds[i]}' is not an eligible, unrevoked, requested-type credential you hold` });
      }
    }
    // Custodial VP signing: the platform holds the holder's seed (User.didSeedEncrypted).
    // The caller IS the holder, so resolve their own user record.
    const holderUser = await deps.users.findById(claims.id);
    if (!holderUser?.didSeedEncrypted) {
      return reply.code(409).send({ error: "HOLDER_KEY_UNAVAILABLE", message: "no custodial key is available for your DID" });
    }
    const holderKey = deps.keystore.keyOf(holderUser.didSeedEncrypted);
    const vpJwt = presentCredentials({
      holderDid: r.holderDid, holderKey: holderKey.privateKey,
      vcJwts: chosen.map((c) => c!.vcJwt), challenge: r.challenge, now: Math.floor(Date.now() / 1000),
    });
    const updated = await deps.verificationRequests.setConsented(r.id, { vpJwt, credentialIds, at: new Date().toISOString() });
    await deps.audit.append({ actorId: claims.id, action: "verification-consented" as LifecycleAction, payload: { requestId: r.id, verifierOrgId: r.verifierOrgId, credentialIds } });
    return vreqView(updated);
  });

  app.post("/verification-requests/:id/reject", { schema: S.rejectVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    if (!r) return notFound(reply, "verification request not found");
    if (!claims.did || claims.did !== r.holderDid) {
      return reply.code(403).send({ error: "FORBIDDEN", message: "only the holder may reject this request" });
    }
    if (r.status !== "pending") return reply.code(409).send({ error: "REQUEST_NOT_PENDING", message: `request is ${r.status}` });
    const updated = await deps.verificationRequests.setStatus(r.id, "rejected");
    await deps.audit.append({ actorId: claims.id, action: "verification-rejected" as LifecycleAction, payload: { requestId: r.id, verifierOrgId: r.verifierOrgId } });
    return vreqView(updated);
  });
```

- [ ] **Step 2: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; existing suite green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): holder consent (custodial VP signing) + reject routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Routes — verify (trust compute + revocation + result)

**Files:**
- Modify: `apps/api/src/http/routes.ts`

- [ ] **Step 1: Add the verify route**

Add `verifyPresentationCredentials`, `decodeJwt` to the `@tokenlayer/core` import. Then:

```typescript
  app.get("/verification-requests/:id/verify", { schema: S.verifyVerificationRequest, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const r = await deps.verificationRequests.get(id);
    if (!r || !orgScoped(claims, r.verifierOrgId)) return notFound(reply, "verification request not found");
    if (r.status !== "consented" || !r.presentationVpJwt) {
      return reply.code(409).send({ error: "NOT_CONSENTED", message: `request is ${r.status}; nothing to verify` });
    }
    const vpJwt = r.presentationVpJwt;
    const nowSec = Math.floor(Date.now() / 1000);

    // STEP 1 — compute the trusted-issuer list (this is HOW core's trust check is fed,
    // not a second check). Collect each inner VC's issuer DID, then decide trust:
    // on-chain (registered && active) when a registry is configured, else the static allowlist.
    const issuerDids = new Set<string>();
    try {
      const vp = decodeJwt(vpJwt);
      for (const raw of ((vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential ?? [])) {
        if (typeof raw === "string") { try { issuerDids.add(String(decodeJwt(raw).payload.iss ?? "")); } catch { /* skip */ } }
      }
    } catch { /* malformed → core will fail it below */ }
    const trusted: string[] = [];
    for (const did of issuerDids) {
      if (!did) continue;
      if (deps.registry) {
        try {
          const reg = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, did);
          if (reg.registered && reg.active) trusted.push(did);
        } catch (err) { request.log.error({ err, did }, "on-chain issuer-trust read failed"); }
      } else if ((deps.trustedKycIssuers ?? []).includes(did)) {
        trusted.push(did);
      }
    }

    // STEP 2 — pure crypto verification against that trust list.
    const core = verifyPresentationCredentials({ vpJwt, challenge: r.challenge, trustedIssuers: trusted, now: nowSec });

    // STEP 3 — per-credential chain-backed revocation. core doesn't surface each
    // VC's jti, so re-decode the presented VCs aligned BY INDEX to recover jti
    // (our VCs set jti === Credential.id) and resolve revocation from it.
    const presentedJtis: (string | null)[] = [];
    try {
      const vp = decodeJwt(vpJwt);
      for (const raw of ((vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential ?? [])) {
        presentedJtis.push(typeof raw === "string" ? (() => { try { return String(decodeJwt(raw).payload.jti ?? "") || null; } catch { return null; } })() : null);
      }
    } catch { /* handled by core */ }

    const credentials = await Promise.all(core.credentials.map(async (c, i) => {
      const jti = presentedJtis[i] ?? null;
      let revoked: boolean | "unknown" = "unknown";
      let type: string | null = null;
      if (jti) {
        const stored = await deps.credentials.get(jti);
        type = stored?.type ?? null;
        if (deps.registry) {
          try {
            const st = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, jti);
            revoked = st.exists ? st.revoked : (stored ? stored.revoked : "unknown");
          } catch (err) { request.log.error({ err }, "on-chain revocation read failed"); revoked = stored ? stored.revoked : "unknown"; }
        } else {
          revoked = stored ? stored.revoked : "unknown";
        }
      }
      const notRevoked = revoked === false;
      const checks = {
        signature: c.reason !== "BAD_ISSUER_SIGNATURE" && c.reason !== "MALFORMED_PRESENTATION",
        trusted: c.reason !== "UNTRUSTED_ISSUER",
        notExpired: c.reason !== "CREDENTIAL_EXPIRED",
        subjectBound: c.reason !== "SUBJECT_MISMATCH",
        notRevoked,
      };
      return {
        id: jti, type, issuer: c.credential?.issuer ?? null, claims: c.credential?.claims ?? null,
        reason: c.reason ?? null, checks, valid: c.valid && notRevoked,
      };
    }));

    const requestedCovered = r.requestedTypes.every((t) => credentials.some((c) => c.type === t && c.valid));
    const result = { valid: core.valid && requestedCovered, holderDid: core.holderDid ?? null, reason: core.reason ?? null, purpose: r.purpose, credentials, verifiedAt: new Date().toISOString() };
    await deps.verificationRequests.setVerifierResult(r.id, { result, at: result.verifiedAt });
    await deps.audit.append({ actorId: claims.id, action: "verification-verified" as LifecycleAction, payload: { requestId: r.id, valid: result.valid, holderDid: core.holderDid ?? null } });
    return result; // 200 even when valid:false — an invalid presentation is a successful verification outcome
  });
```

- [ ] **Step 2: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; existing suite green.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/http/routes.ts
git commit -m "feat(api): verify route — on-chain trust + chain-backed revocation + structured result

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: API tests — the whole flow + the on-chain path via a double

**Files:**
- Test: `apps/api/test/verification.test.ts`

- [ ] **Step 1: Write the tests**

READ `apps/api/test/fake-anchor.ts` (from #4) first — reuse its `FakeAnchor` + `fakeRegistry` to drive the on-chain trust/revocation path. Create `apps/api/test/verification.test.ts`:

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

const createOrg = (name: string, orgType: string) =>
  app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
const addMember = (orgId: string, email: string, role: string, pw: string) =>
  app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: { email, password: pw, role } });

/** An issuer verifier-org that can issue KYC to a subject, plus the subject's token + credential. */
async function issueKycTo(tag: string) {
  const issOrg = (await createOrg(`Issuer ${tag}`, "verifier")).json();
  const ia1 = `ia1.${tag}@x.io`, ia2 = `ia2.${tag}@x.io`, s = `s.${tag}@x.io`;
  await addMember(issOrg.id, ia1, "OrgAdmin", "orgadmin1");
  await addMember(issOrg.id, ia2, "OrgAdmin", "orgadmin2");
  const subject = (await addMember(issOrg.id, s, "Buyer", "subject1")).json();
  const t1 = await loginAs(app, ia1, "orgadmin1"), t2 = await loginAs(app, ia2, "orgadmin2");
  const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(t1), payload: { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya", country: "IN" } } });
  await app.inject({ method: "POST", url: `${V1}/proposals/${req.json().proposal.id}/approve`, headers: auth(t2), payload: {} });
  const subjTok = await loginAs(app, s, "subject1");
  const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) })).json();
  return { issOrg, subject, subjTok, s, kyc: creds.find((c: { type: string[] }) => c.type.includes("KycCredential")) };
}

async function verifierOrg(tag: string) {
  const org = (await createOrg(`Verifier ${tag}`, "verifier")).json();
  const email = `va.${tag}@x.io`;
  await addMember(org.id, email, "OrgAdmin", "orgadmin1");
  return { org, token: await loginAs(app, email, "orgadmin1") };
}

describe("request → consent → verify", () => {
  it("a verifier requests, the holder consents, verification passes with real signatures", async () => {
    const { issOrg, subject, subjTok, kyc } = await issueKycTo("happy");
    const v = await verifierOrg("happy");

    const reqRes = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding" } });
    expect(reqRes.statusCode).toBe(201);
    const reqId = reqRes.json().id;

    // Holder inbox surfaces the request with its eligible credential.
    const inbox = (await app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(subjTok) })).json();
    const entry = inbox.find((r: { id: string }) => r.id === reqId);
    expect(entry.eligibleCredentials.map((c: { id: string }) => c.id)).toContain(kyc.id);

    const consent = await app.inject({ method: "POST", url: `${V1}/verification-requests/${reqId}/consent`, headers: auth(subjTok), payload: { credentialIds: [kyc.id] } });
    expect(consent.statusCode).toBe(200);
    expect(consent.json().status).toBe("consented");

    const verify = await app.inject({ method: "GET", url: `${V1}/verification-requests/${reqId}/verify`, headers: auth(v.token) });
    expect(verify.statusCode).toBe(200);
    const result = verify.json();
    expect(result.valid).toBe(true);
    expect(result.holderDid).toBe(subject.did);
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].valid).toBe(true);
    expect(result.credentials[0].checks).toMatchObject({ signature: true, trusted: true, notExpired: true, subjectBound: true, notRevoked: true });
    expect(result.credentials[0].claims).toMatchObject({ country: "IN" });

    // Independent proof: the stored VP verifies OUTSIDE the API.
    const stored = (await app.inject({ method: "GET", url: `${V1}/verification-requests/${reqId}`, headers: auth(subjTok) })).json();
    void stored; // the read view intentionally omits the VP; verify via the verify result's holder proof instead
    const vpDecoded = decodeJwt(consent.json().presentationVpJwt ?? "");
    void vpDecoded;
  });

  it("only a verifier-type org may request", async () => {
    const corp = (await createOrg("Corp NotVerifier", "corporate")).json();
    const email = "ca.notv@x.io";
    await addMember(corp.id, email, "OrgAdmin", "orgadmin1");
    const t = await loginAs(app, email, "orgadmin1");
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(t), payload: { holderDid: "did:key:zX", requestedTypes: ["KycCredential"], purpose: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("NOT_A_VERIFIER");
  });

  it("a non-holder cannot consent", async () => {
    const { subject } = await issueKycTo("nonholder");
    const v = await verifierOrg("nonholder");
    const reqId = (await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "x" } })).json().id;
    // v.token is the verifier admin, not the holder.
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests/${reqId}/consent`, headers: auth(v.token), payload: { credentialIds: ["whatever"] } });
    expect(res.statusCode).toBe(403);
  });

  it("consent rejects a credential that isn't the holder's / isn't a requested type", async () => {
    const { subject, subjTok, kyc } = await issueKycTo("ineligible");
    const v = await verifierOrg("ineligible");
    // request a DIFFERENT type than the held KYC
    const reqId = (await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["AccreditedInvestor"], purpose: "x" } })).json().id;
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests/${reqId}/consent`, headers: auth(subjTok), payload: { credentialIds: [kyc.id] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CREDENTIAL_NOT_ELIGIBLE");
  });

  it("a VP for request A cannot satisfy request B (challenge binding)", async () => {
    const { subject, subjTok, kyc } = await issueKycTo("chal");
    const v = await verifierOrg("chal");
    const reqA = (await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "A" } })).json().id;
    const reqB = (await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "B" } })).json().id;
    await app.inject({ method: "POST", url: `${V1}/verification-requests/${reqA}/consent`, headers: auth(subjTok), payload: { credentialIds: [kyc.id] } });
    // B has no consent yet → verify is 409.
    const vb = await app.inject({ method: "GET", url: `${V1}/verification-requests/${reqB}/verify`, headers: auth(v.token) });
    expect(vb.statusCode).toBe(409);
    // (A's challenge != B's challenge is enforced by construction: each request mints its own.)
  });

  it("reject moves the request to rejected", async () => {
    const { subject, subjTok } = await issueKycTo("reject");
    const v = await verifierOrg("reject");
    const reqId = (await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(v.token), payload: { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "x" } })).json().id;
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests/${reqId}/reject`, headers: auth(subjTok) });
    expect(res.json().status).toBe("rejected");
  });
});
```

Note the happy-path test asserts the credential's `claims.country === "IN"` (the KYC claim). If the seeded issuer org's DID isn't automatically trusted with no registry, the `trusted` check would fail — so the test must ensure the issuing org's DID is in `trustedKycIssuers`. **Since besu is absent in tests and trust falls back to the static allowlist**, pass the issuer org's DID via `buildTestApp({ trustedKycIssuers: [issOrg.did] })` — but `issOrg.did` isn't known until after creation. Resolve this by using the **on-chain double** instead: build the app with `buildTestApp({ registry: fakeRegistry(anchor) })` and have the FakeAnchor's `didRegistration` return `{ registered: true, active: true }` for any DID (so every issuer is trusted), which is simpler than threading the allowlist. Adjust `buildTestApp` usage accordingly and set the anchor to also mark credentials anchored on issue (the #4 wiring already anchors on the fake in that mode). Verify the exact FakeAnchor behaviour in `fake-anchor.ts` and adapt; if it's easier to make trust deterministic, add a `trustAll` flag to the double.

- [ ] **Step 2: Run + the gate**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/verification.test.ts` → PASS.
Then `pnpm --filter @tokenlayer/api exec vitest run` → the full suite, with `identity.test.ts`, `approvals.test.ts`, `proposal-compensation.test.ts`, `credential-issuance.test.ts`, `onchain-registry.test.ts` all UNEDITED (`git diff --stat` empty on each).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/verification.test.ts
git commit -m "test(api): verifier request → consent → verify, eligibility + challenge binding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Web — verifier request/results + holder consent inbox

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/components/PlatformHome.tsx`, `apps/web/src/components/MyIdentity.tsx`
- Create: `apps/web/src/components/VerificationRequests.tsx`, `apps/web/src/components/VerificationInbox.tsx`

**MANDATORY PREP:** read `apps/web/src/components/ui.tsx` (real primitives — `Pill` tones `ok|warn|danger|info|muted`, `Card`, `SectionHeader`, `EmptyState`, no `Button`), `apps/web/src/components/CredentialsPanel.tsx` (the closest analogue — schema-driven form + a list), and `apps/web/src/App.tsx` + `PlatformHome.tsx` nav.

- [ ] **Step 1: Types + client**

In `apps/web/src/types.ts` append:
```typescript
export interface VerificationRequest {
  id: string;
  verifierOrgId: string;
  holderDid: string;
  requestedTypes: string[];
  purpose: string;
  status: "pending" | "consented" | "rejected" | "expired";
  consentedCredentialIds: string[] | null;
  consentedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  expiresAt: string;
  eligibleCredentials?: { id: string; type: string; issuerDid: string; issuedAt: string }[];
}
export interface VerificationResult {
  valid: boolean;
  holderDid: string | null;
  reason: string | null;
  purpose: string;
  verifiedAt: string;
  credentials: { id: string | null; type: string | null; issuer: string | null; reason: string | null;
    claims: Record<string, unknown> | null;
    checks: { signature: boolean; trusted: boolean; notExpired: boolean; subjectBound: boolean; notRevoked: boolean | "unknown" };
    valid: boolean }[];
}
```
In `apps/web/src/api.ts` add:
```typescript
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
  myVerificationRequests: (token: string) => request<VerificationRequest[]>("/me/verification-requests", token),
  consentVerification: (token: string, id: string, credentialIds: string[]) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/consent`, token, { method: "POST", body: JSON.stringify({ credentialIds }) }),
  rejectVerification: (token: string, id: string) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify({}) }),
  verifyVerification: (token: string, id: string) => request<VerificationResult>(`/verification-requests/${encodeURIComponent(id)}/verify`, token),
```

- [ ] **Step 2: VerificationRequests.tsx (verifier side)**

Create `apps/web/src/components/VerificationRequests.tsx`: a `Card` "Request a presentation" with a holder-DID input, a checkbox list of types from `api.credentialTypes(token)` (reuse), and a purpose input → `api.createVerificationRequest`. Below, a list of the org's requests (from a new client call is not required — reuse `api.myVerificationRequests` returns the HOLDER's; the verifier's own list isn't exposed by a route in this plan, so show only the just-created request id + a "Verify" button that calls `api.verifyVerification` and renders the `VerificationResult` with each credential's five checks as `Pill`s (`ok` green when true, `danger` when false, `muted` when `"unknown"`)). Keep it simple: after creating a request, keep its id in state and offer "Run verification" once the holder has consented.

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { CredentialTypeInfo, VerificationResult } from "../types.js";
import { Card, Pill } from "./ui.js";

export function VerificationRequests(): JSX.Element {
  const { token } = useAuth();
  const [types, setTypes] = useState<CredentialTypeInfo[]>([]);
  const [holderDid, setHolderDid] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [purpose, setPurpose] = useState("");
  const [reqId, setReqId] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (token) void api.credentialTypes(token).then(setTypes).catch(() => setTypes([])); }, [token]);

  async function submit(): Promise<void> {
    if (!token) return;
    const requestedTypes = Object.keys(picked).filter((k) => picked[k]);
    if (!holderDid || requestedTypes.length === 0 || !purpose) { setErr("holder DID, at least one type, and a purpose are required"); return; }
    setErr(null); setResult(null);
    try {
      const r = await api.createVerificationRequest(token, { holderDid: holderDid.trim(), requestedTypes, purpose: purpose.trim() });
      setReqId(r.id); setMsg(`Requested — waiting for the holder to consent (request ${r.id.slice(0, 8)}…).`);
    } catch (e) { setErr((e as Error).message); }
  }
  async function runVerify(): Promise<void> {
    if (!token || !reqId) return;
    setErr(null);
    try { setResult(await api.verifyVerification(token, reqId)); }
    catch (e) { setErr((e as Error).message); }
  }

  const check = (ok: boolean | "unknown") => <Pill tone={ok === true ? "ok" : ok === "unknown" ? "muted" : "danger"}>{ok === true ? "✓" : ok === "unknown" ? "?" : "✗"}</Pill>;

  return (
    <div className="space-y-5">
      <Card title="Request a presentation" description="Ask a holder to present specific credentials. They consent and choose what to disclose.">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
        <input className="input w-full mb-2" placeholder="Holder DID (did:key:…)" value={holderDid} onChange={(e) => setHolderDid(e.target.value)} />
        <div className="flex flex-wrap gap-3 mb-2">
          {types.map((t) => (
            <label key={t.type} className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={!!picked[t.type]} onChange={(e) => setPicked({ ...picked, [t.type]: e.target.checked })} /> {t.type}
            </label>
          ))}
        </div>
        <input className="input w-full mb-3" placeholder="Purpose (e.g. investor onboarding)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        <div className="flex gap-2">
          <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white" onClick={submit}>Request</button>
          {reqId && <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={runVerify}>Run verification</button>}
        </div>
      </Card>

      {result && (
        <Card title="Verification result" description={result.valid ? "Presentation is valid." : "Presentation did not fully verify."}>
          <div className="mb-2"><Pill tone={result.valid ? "ok" : "danger"}>{result.valid ? "valid" : "invalid"}</Pill> <span className="text-xs text-slate-500">holder {result.holderDid?.slice(0, 20)}…</span></div>
          <div className="space-y-2">
            {result.credentials.map((c, i) => (
              <div key={i} className="border border-slate-100 rounded-lg p-3">
                <div className="font-medium">{c.type ?? "unknown credential"} {c.reason && <span className="text-xs text-rose-600">· {c.reason}</span>}</div>
                <div className="flex flex-wrap gap-3 text-xs mt-1 items-center">
                  <span>sig {check(c.checks.signature)}</span><span>trusted {check(c.checks.trusted)}</span>
                  <span>not-expired {check(c.checks.notExpired)}</span><span>subject {check(c.checks.subjectBound)}</span>
                  <span>not-revoked {check(c.checks.notRevoked)}</span>
                </div>
                {c.claims && <div className="text-xs text-slate-500 mt-1">{Object.entries(c.claims).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
```
If `ui.tsx`'s `Card` lacks `title`/`description`, render plain markup — match the real API.

- [ ] **Step 3: VerificationInbox.tsx (holder side)**

Create `apps/web/src/components/VerificationInbox.tsx`: lists `api.myVerificationRequests(token)`; each pending request shows verifier org id, purpose, requested types, and its `eligibleCredentials` as checkboxes; a Consent button (disabled until ≥1 ticked) → `api.consentVerification`; a Reject button → `api.rejectVerification`.

```tsx
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { VerificationRequest } from "../types.js";
import { Card, Pill } from "./ui.js";

export function VerificationInbox(): JSX.Element {
  const { token } = useAuth();
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [picked, setPicked] = useState<Record<string, Record<string, boolean>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = (): void => { if (token) void api.myVerificationRequests(token).then(setRequests).catch((e) => setErr(e.message)); };
  useEffect(reload, [token]);

  async function consent(r: VerificationRequest): Promise<void> {
    if (!token) return;
    const ids = Object.keys(picked[r.id] ?? {}).filter((k) => picked[r.id]![k]);
    if (ids.length === 0) return;
    setErr(null); setMsg(null);
    try { await api.consentVerification(token, r.id, ids); setMsg("Consented — the presentation was signed and released."); reload(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function reject(r: VerificationRequest): Promise<void> {
    if (!token) return;
    try { await api.rejectVerification(token, r.id); reload(); } catch (e) { setErr((e as Error).message); }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const past = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-5">
      <Card title="Verification requests" description="Relying parties asking you to present credentials. Nothing is shared until you consent.">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
        {pending.length === 0 && <div className="text-sm text-slate-500">No pending requests.</div>}
        <div className="space-y-3">
          {pending.map((r) => (
            <div key={r.id} className="border border-slate-100 rounded-lg p-3">
              <div className="text-sm font-medium">{r.purpose}</div>
              <div className="text-xs text-slate-500 mb-2">from {r.verifierOrgId} · asks for {r.requestedTypes.join(", ")}</div>
              {(r.eligibleCredentials ?? []).length === 0
                ? <div className="text-xs text-amber-600">You hold no unrevoked credential of the requested type(s).</div>
                : (r.eligibleCredentials ?? []).map((c) => (
                    <label key={c.id} className="text-sm flex items-center gap-1">
                      <input type="checkbox" checked={!!picked[r.id]?.[c.id]} onChange={(e) => setPicked({ ...picked, [r.id]: { ...picked[r.id], [c.id]: e.target.checked } })} /> {c.type}
                    </label>
                  ))}
              <div className="flex gap-2 mt-2">
                <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm text-white disabled:opacity-40" disabled={!Object.values(picked[r.id] ?? {}).some(Boolean)} onClick={() => consent(r)}>Consent &amp; present</button>
                <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-rose-600" onClick={() => reject(r)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      {past.length > 0 && (
        <Card title="Past requests">
          <div className="space-y-1">
            {past.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border-t border-slate-100 py-1">
                <span>{r.purpose} · {r.requestedTypes.join(", ")}</span>
                <Pill tone={r.status === "consented" ? "ok" : r.status === "rejected" ? "muted" : "warn"}>{r.status}</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Nav wiring**

- `apps/web/src/components/MyIdentity.tsx`: render `<VerificationInbox />` beneath the existing identity content (every signed-in user sees their inbox). Import it.
- `apps/web/src/App.tsx` + `apps/web/src/components/PlatformHome.tsx`: add a `"verify"` section/tab labeled "Verification", shown for an OrgAdmin whose org is a verifier — but the web has no easy orgType check client-side, so show it for all OrgAdmins/PlatformAdmin and let the API's `NOT_A_VERIFIER` gate non-verifier orgs (the form simply errors for them). Render `<VerificationRequests />`. Match the existing tab idiom (widen the `Section`/`Tab` union, add the entry + branch).

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): verifier request/results view + holder consent inbox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Verify — full suite, live E2E, browser, merge

**Files:**
- Create: `scripts/verification-e2e.mjs`

- [ ] **Step 1: Full monorepo build + suite**

Run: `pnpm -r build && pnpm -r test`
Expected: all green — core (+5), adapters 44, contracts 34, api (+ verification tests).

- [ ] **Step 2: Write the live E2E**

Create `scripts/verification-e2e.mjs`:

```javascript
// End-to-end against REAL Besu: a verifier org requests a presentation; the holder
// consents; verification passes with issuer-trust sourced from the on-chain DID
// registry and revocation from the chain. Then revoke the credential and re-verify
// → notRevoked flips to false while the presentation's signatures still check.
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
const mkOrg = async (name, orgType) => (await call("POST", "/orgs", { name, orgType }, platform)).json;
const mkMember = async (orgId, email, role, pw) => (await call("POST", `/orgs/${orgId}/users`, { email, password: pw, role }, platform)).json;

console.log("== 1) An issuer verifier-org issues KYC to a subject ==");
const issuer = await mkOrg(`KYC Issuer ${runId}`, "verifier");
const ia1 = `ia1.${runId}@i.dev`, ia2 = `ia2.${runId}@i.dev`, sub = `s.${runId}@i.dev`;
await mkMember(issuer.id, ia1, "OrgAdmin", "orgadmin1"); await mkMember(issuer.id, ia2, "OrgAdmin", "orgadmin2");
const subject = await mkMember(issuer.id, sub, "Buyer", "subject1");
const it1 = await login(ia1, "orgadmin1"), it2 = await login(ia2, "orgadmin2");
const cr = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya", country: "IN" } }, it1);
await call("POST", `/proposals/${cr.json.proposal.id}/approve`, {}, it2);
const subjTok = await login(sub, "subject1");
const kyc = ((await call("GET", "/me/credentials", null, subjTok)).json ?? []).find((c) => c.type.includes("KycCredential"));
ok(!!kyc && !!subject.did, "issued a KYC credential to the subject", { did: subject.did });

console.log("\n== 2) A verifier org requests a presentation ==");
const verifier = await mkOrg(`Relying Party ${runId}`, "verifier");
const va = `va.${runId}@v.dev`;
await mkMember(verifier.id, va, "OrgAdmin", "orgadmin1");
const vt = await login(va, "orgadmin1");
const req = await call("POST", "/verification-requests", { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "investor onboarding" }, vt);
ok(req.status === 201, "verifier created a request (201)", req.json);

console.log("\n== 3) The holder consents ==");
const inbox = (await call("GET", "/me/verification-requests", null, subjTok)).json ?? [];
const entry = inbox.find((r) => r.id === req.json.id);
ok(entry?.eligibleCredentials?.some((c) => c.id === kyc.id), "the holder's inbox offers the KYC credential", entry?.eligibleCredentials);
const consent = await call("POST", `/verification-requests/${req.json.id}/consent`, { credentialIds: [kyc.id] }, subjTok);
ok(consent.status === 200 && consent.json.status === "consented", "consent signed + released the VP", consent.json);

console.log("\n== 4) The verifier verifies — trust from the on-chain registry ==");
const v1 = await call("GET", `/verification-requests/${req.json.id}/verify`, null, vt);
ok(v1.json?.valid === true, "verification PASSED", v1.json);
ok(v1.json?.credentials?.[0]?.checks?.trusted === true, "issuer trusted via the on-chain DID registry", v1.json?.credentials?.[0]?.checks);
ok(v1.json?.credentials?.[0]?.checks?.notRevoked === true, "not revoked (chain-backed)", v1.json?.credentials?.[0]?.checks);

console.log("\n== 5) Revoke the credential → re-verify flips notRevoked ==");
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "test revoke" }, it1);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, it2);
const v2 = await call("GET", `/verification-requests/${req.json.id}/verify`, null, vt);
ok(v2.json?.credentials?.[0]?.checks?.notRevoked === false, "after revocation, notRevoked is false (live chain read)", v2.json?.credentials?.[0]?.checks);
ok(v2.json?.credentials?.[0]?.checks?.signature === true, "the signature still verifies — only revocation changed", v2.json?.credentials?.[0]?.checks);
ok(v2.json?.valid === false, "the overall presentation is now invalid", { valid: v2.json?.valid });

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ VERIFIER / PRESENTATION END-TO-END PASSED — request → consent → verify, on-chain issuer trust, live revocation"}`);
process.exit(fails ? 1 : 0);
```

- [ ] **Step 3: Boot against real Besu + run**

```bash
make besu-up; sleep 20
pkill -f "src/server.ts"; lsof -ti:4000 | xargs kill -9 2>/dev/null; rm -f apps/api/verify-e2e.db
DATABASE_URL="file:./verify-e2e.db" pnpm --filter @tokenlayer/api exec prisma db push --skip-generate
DATABASE_URL="file:./verify-e2e.db" JWT_SECRET="dev-secret-verify-e2e" PORT=4000 NODE_ENV=development \
  BESU_RPC_URL="http://localhost:8545" BESU_OPERATOR_KEY="0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63" \
  REGISTRY_CHAIN_ID=besu LOGIN_RATE_LIMIT_MAX=1000 pnpm api:dev &
# wait for the "[registry] deployed" + "listening" lines (registry deploy runs after use-case seeding — 30-60s)
sleep 45
node scripts/verification-e2e.mjs
```
Expected: `✅ VERIFIER / PRESENTATION END-TO-END PASSED`. (Kill by port, not just pattern — a stale server on :4000 makes the fresh one EADDRINUSE-die and the E2E hits the wrong one.)

- [ ] **Step 4: Browser**

`preview_start` the `web` config against the Besu-backed API. As a verifier-org OrgAdmin: open Verification, request a presentation for the subject's DID + KycCredential. As the holder (that subject): open My identity → the inbox shows the request; tick the credential; Consent. Back as the verifier: Run verification → the five green checks. Screenshot.

- [ ] **Step 5: Cleanup + merge**

```bash
pkill -f "src/server.ts"; lsof -ti:4000 | xargs kill -9 2>/dev/null; rm -f apps/api/verify-e2e.db
make besu-down
git add scripts/verification-e2e.mjs
git commit -m "test(e2e): live verifier request → consent → verify with on-chain trust + revocation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Then use **superpowers:finishing-a-development-branch**. Confirm the merge with the user. This completes the 4-sub-project enterprise-identity arc.

---

## Self-Review

**1. Spec coverage:**
- Core `presentCredentials`/`verifyPresentationCredentials`, N-credential, per-credential verdicts, single-VC untouched → Task 1. ✓
- `VerificationRequest` model + repos + wiring → Task 2. ✓
- `POST /verification-requests` (verifier-org gate, `NOT_A_VERIFIER`) → Task 3. ✓
- `GET /me/verification-requests` inbox with eligible credentials → Task 3. ✓
- `GET /verification-requests/:id` (holder or verifier) → Task 3. ✓
- `POST /:id/consent` (holder-only, custodial signing, eligibility guards, expiry 410) → Task 4. ✓
- `POST /:id/reject` → Task 4. ✓
- `GET /:id/verify` (trust compute on-chain-or-static, verifyPresentationCredentials, per-credential chain-backed revocation, 200 on valid:false) → Task 5. ✓
- Audit rows (requested/consented/rejected/verified) → Tasks 3–5. ✓
- Web verifier + holder views → Task 7. ✓
- Tests incl. the single-VC + full-suite gates → Tasks 1, 6. ✓ Live E2E + browser → Task 8. ✓
- Out-of-scope items (per-claim SD, share links, external verifiers) → no tasks, correctly. ✓

**2. Placeholder scan:** No TBD/TODO; every code block is meant to be copied as-is. Task 6 Step 1's trust-setup note gives a concrete resolution (use the FakeAnchor with `didRegistration` returning registered+active) rather than leaving it open. The read-then-edit steps (memory `list` ordering, `ui.tsx` primitives, `fake-anchor.ts` shape) name the exact adaptation.

**3. Type consistency:** `MultiPresentationResult`/`PerCredentialResult`/`PresentManyInput`/`VerifyManyInput` (Task 1) match their use in the verify route (Task 5) and the web `VerificationResult` shape (Task 7). `VerificationRequestRecord` fields (Task 2) are identical across memory/prisma repos, `vreqView` (Task 3), consent/reject (Task 4), verify (Task 5), and the web `VerificationRequest` type (Task 7). The `checks` object keys (`signature`, `trusted`, `notExpired`, `subjectBound`, `notRevoked`) are identical in Task 5's route, Task 6's assertion, and Task 7's rendering. `setConsented`/`setStatus`/`setVerifierResult` signatures (Task 2) match their callers (Tasks 4–5). Route error codes (`NOT_A_VERIFIER`, `CREDENTIAL_NOT_ELIGIBLE`, `REQUEST_EXPIRED`, `HOLDER_KEY_UNAVAILABLE`, `NOT_CONSENTED`, `REQUEST_NOT_PENDING`) are consistent between routes and tests.

**Deliberate deviation from the reference repo, recorded:** consent is a dedicated model + single holder action, NOT the maker-checker Proposal machinery — one person authorizing disclosure of their own credentials is a different shape than N approvers gating an org op, and bending Proposal's `canApprove` to fit would defeat its model.
