# Digital Identity (DID / Verifiable Credentials) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desk-initiated DID/VC investor verification — the desk verifies a holder-signed Verifiable Presentation of a KYC credential; on success the platform auto-sets `kycStatus=approved` + `kyc.country`, unblocking the investor in the existing fail-closed compliance engine and portal.

**Architecture:** A pure, dependency-free `packages/core/src/identity.ts` (did:key + Ed25519 + VC-JWT/VP-JWT via `node:crypto`, `verifyPresentation`) does all crypto/policy. `apps/api` adds an injected single-use challenge store, a `TRUSTED_KYC_ISSUERS` allowlist, `User.did` persistence, and three routes (`challenge`, `verify`, dev-only `mint`). `apps/web` adds a "Verify identity" action in User Management.

**Tech Stack:** TypeScript, `node:crypto` (native Ed25519, zero new deps), Fastify + Vitest, React.

**Spec:** `docs/superpowers/specs/2026-07-10-digital-identity-vc-design.md`

---

## File map

| File | Change |
|---|---|
| `packages/core/src/identity.ts` | **Create**: did:key/Ed25519, JWT sign/verify, `verifyPresentation`, dev `generateDidKey`/`issueCredential`/`presentCredential` |
| `packages/core/src/index.ts` | Export the identity module |
| `packages/core/test/identity.test.ts` | **Create**: unit tests |
| `apps/api/src/identity-challenges.ts` | **Create**: `ChallengeStore` interface + in-memory TTL impl |
| `apps/api/src/persistence/types.ts` | `UserRecord.did?`, `KycDetails` gains `issuerDid?/credentialId?/verifiedAt?`, widen `UserRepository.update` |
| `apps/api/src/persistence/memory.ts` | `update` accepts `did`/`kyc`; `toUser`/create carry `did` |
| `apps/api/src/persistence/prisma.ts` | `update` accepts `did`/`kyc`; `toUser` maps `did` |
| `apps/api/prisma/schema.prisma` | `User.did String?` |
| `apps/api/src/context.ts` | `AppDeps` gains `challenges: ChallengeStore`, `trustedKycIssuers?: string[]`, `devIssuerSeed?: string` |
| `apps/api/src/env.ts` | parse `TRUSTED_KYC_ISSUERS`, `DEV_KYC_ISSUER_SEED` |
| `apps/api/src/server.ts` + `apps/api/test/helpers.ts` | construct + inject the new deps |
| `apps/api/src/http/routes.ts` | 3 routes: challenge, verify, dev mint |
| `apps/api/src/http/schemas.ts` | schemas for the 3 routes |
| `apps/api/test/identity.test.ts` | **Create**: endpoint tests |
| `apps/web/src/types.ts` + `api.ts` | client methods + types |
| `apps/web/src/components/UserManagement.tsx` | "Verify identity" action |
| `scripts/identity-vc-e2e.mjs` | **Create**: live E2E |

---

### Task 1: core identity primitives — did:key + Ed25519 + JWT

**Files:** Create `packages/core/src/identity.ts`; Test: `packages/core/test/identity.test.ts`.

- [ ] **Step 1: Write failing tests** for the primitives:

```ts
import { describe, it, expect } from "vitest";
import { generateDidKey, didKeyFromPublicKey, publicKeyFromDidKey, signJwt, verifyJwtSignature, decodeJwt } from "../src/identity.js";

describe("did:key + JWT primitives", () => {
  it("round-trips a did:key ⇄ public key", () => {
    const { did, publicKey } = generateDidKey();
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
    // the resolved key verifies a signature made by the matching private key
    expect(didKeyFromPublicKey(publicKey.export({ type: "spki", format: "der" }).subarray(-32))).toBe(did);
  });
  it("signs and verifies an EdDSA JWT; tamper is rejected", () => {
    const { did, privateKey } = generateDidKey();
    const jwt = signJwt({ alg: "EdDSA", typ: "JWT", kid: `${did}#0` }, { iss: did, foo: "bar" }, privateKey);
    const pub = publicKeyFromDidKey(did);
    expect(verifyJwtSignature(jwt, pub)).toBe(true);
    expect(decodeJwt(jwt).payload.foo).toBe("bar");
    const tampered = jwt.slice(0, -4) + (jwt.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(verifyJwtSignature(tampered, pub)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/core test identity` → module not found.

- [ ] **Step 3: Implement** `packages/core/src/identity.ts`:

```ts
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

// --- base64url ---
const b64u = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o: unknown): string => b64u(Buffer.from(JSON.stringify(o), "utf8"));
const fromB64u = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// --- base58btc (Bitcoin alphabet), enough for did:key multibase ---
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(bytes: Buffer): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
function base58decode(str: string): Buffer {
  let n = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of str) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

// Ed25519 multicodec prefix 0xed 0x01; SPKI DER header for a raw Ed25519 pubkey.
const ED_MULTICODEC = Buffer.from([0xed, 0x01]);
const SPKI_ED_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function didKeyFromPublicKey(rawPub: Buffer): string {
  return "did:key:z" + base58encode(Buffer.concat([ED_MULTICODEC, rawPub]));
}

export function publicKeyFromDidKey(did: string): KeyObject {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)(#.*)?$/.exec(did);
  if (!m) throw new Error("unsupported DID (expected did:key ed25519)");
  const decoded = base58decode(m[1]!);
  if (!decoded.subarray(0, 2).equals(ED_MULTICODEC)) throw new Error("unsupported did:key codec");
  const rawPub = decoded.subarray(2);
  if (rawPub.length !== 32) throw new Error("bad ed25519 key length");
  return createPublicKey({ key: Buffer.concat([SPKI_ED_PREFIX, rawPub]), format: "der", type: "spki" });
}

export interface DidKey { did: string; publicKey: KeyObject; privateKey: KeyObject; }
export function generateDidKey(): DidKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { did: didKeyFromPublicKey(rawPub), publicKey, privateKey };
}

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: KeyObject): string {
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = edSign(null, Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

export function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return { header: JSON.parse(fromB64u(parts[0]!).toString("utf8")), payload: JSON.parse(fromB64u(parts[1]!).toString("utf8")) };
}

export function verifyJwtSignature(jwt: string, publicKey: KeyObject): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    return edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), publicKey, fromB64u(parts[2]!));
  } catch { return false; }
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @tokenlayer/core test identity` → PASS.
- [ ] **Step 5: Export** — add to `packages/core/src/index.ts`: `export * from "./identity.js";`. Run `pnpm --filter @tokenlayer/core exec tsc --noEmit` → clean.
- [ ] **Step 6: Commit** — `git commit -m "feat(core): did:key + Ed25519 + EdDSA JWT primitives (node:crypto, no deps)"` with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Task 2: core `verifyPresentation` + dev issuer/holder helpers

**Files:** Modify `packages/core/src/identity.ts`; Test: `packages/core/test/identity.test.ts`.

- [ ] **Step 1: Write failing tests** covering the happy path + every failure mode:

```ts
import { generateDidKey, issueCredential, presentCredential, verifyPresentation } from "../src/identity.js";

describe("verifyPresentation", () => {
  const now = 1_800_000_000; // fixed epoch seconds
  function scenario(over: Partial<{ challenge: string; issuerTrusted: boolean; expiresAt: number; wrongHolder: boolean; subjectMismatch: boolean }> = {}) {
    const issuer = generateDidKey();
    const holder = generateDidKey();
    const other = generateDidKey();
    const subject = over.subjectMismatch ? other.did : holder.did;
    const vcJwt = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: subject, claims: { country: "IN", legalName: "Asha Rao" }, expiresAt: over.expiresAt ?? now + 3600, now });
    const presenter = over.wrongHolder ? other : holder;
    const vpJwt = presentCredential({ holderDid: holder.did, holderKey: presenter.privateKey, vcJwt, challenge: "chal-1", now });
    return verifyPresentation({ vpJwt, challenge: over.challenge ?? "chal-1", trustedIssuers: over.issuerTrusted === false ? [] : [issuer.did], now });
  }
  it("accepts a valid VP and returns claims", () => {
    const r = scenario();
    expect(r.valid).toBe(true);
    expect(r.holderDid?.startsWith("did:key:")).toBe(true);
    expect(r.credential?.claims.country).toBe("IN");
  });
  it("rejects an untrusted issuer", () => expect(scenario({ issuerTrusted: false })).toMatchObject({ valid: false, reason: "UNTRUSTED_ISSUER" }));
  it("rejects an expired credential", () => expect(scenario({ expiresAt: now - 1 })).toMatchObject({ valid: false, reason: "CREDENTIAL_EXPIRED" }));
  it("rejects a bad holder proof", () => expect(scenario({ wrongHolder: true })).toMatchObject({ valid: false, reason: "BAD_HOLDER_PROOF" }));
  it("rejects a challenge mismatch", () => expect(scenario({ challenge: "wrong" })).toMatchObject({ valid: false, reason: "CHALLENGE_MISMATCH" }));
  it("rejects subject≠holder", () => expect(scenario({ subjectMismatch: true })).toMatchObject({ valid: false, reason: "SUBJECT_MISMATCH" }));
  it("rejects malformed input", () => expect(verifyPresentation({ vpJwt: "not-a-jwt", challenge: "x", trustedIssuers: [], now })).toMatchObject({ valid: false, reason: "MALFORMED_PRESENTATION" }));
});
```

- [ ] **Step 2: Run to verify failure** — functions not defined.

- [ ] **Step 3: Implement** — append to `identity.ts`:

```ts
import { randomUUID } from "node:crypto";

export interface IssueInput { issuerDid: string; issuerKey: KeyObject; subjectDid: string; claims: Record<string, unknown>; expiresAt: number; now: number; }
/** Mint a VC-JWT (dev/test helper). credentialSubject.id = subjectDid; jti = credential id. */
export function issueCredential(i: IssueInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${i.issuerDid}#0` },
    { iss: i.issuerDid, sub: i.subjectDid, jti: `urn:uuid:${randomUUID()}`, iat: i.now, nbf: i.now, exp: i.expiresAt,
      vc: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: ["VerifiableCredential", "KycCredential"], credentialSubject: { id: i.subjectDid, ...i.claims } } },
    i.issuerKey,
  );
}

export interface PresentInput { holderDid: string; holderKey: KeyObject; vcJwt: string; challenge: string; now: number; }
/** Wrap a VC-JWT in a holder-signed VP-JWT over a challenge (dev/test helper). */
export function presentCredential(p: PresentInput): string {
  return signJwt(
    { alg: "EdDSA", typ: "JWT", kid: `${p.holderDid}#0` },
    { iss: p.holderDid, nonce: p.challenge, iat: p.now,
      vp: { "@context": ["https://www.w3.org/2018/credentials/v1"], type: ["VerifiablePresentation"], verifiableCredential: [p.vcJwt] } },
    p.holderKey,
  );
}

export interface VerifiedCredential { issuer: string; subject: string; claims: Record<string, unknown>; issuedAt?: number; expiresAt?: number; }
export interface PresentationResult { valid: boolean; reason?: string; holderDid?: string; credential?: VerifiedCredential; }
export interface VerifyInput { vpJwt: string; challenge: string; trustedIssuers: string[]; now: number; }

/** Verify a VP-JWT: holder proof over the challenge, then the inner VC (issuer sig, trust, expiry, subject binding). First failure wins. */
export function verifyPresentation(input: VerifyInput): PresentationResult {
  const fail = (reason: string): PresentationResult => ({ valid: false, reason });
  let vp;
  try { vp = decodeJwt(input.vpJwt); } catch { return fail("MALFORMED_PRESENTATION"); }
  try {
    const holderDid = String(vp.payload.iss ?? "");
    if (!holderDid.startsWith("did:key:")) return fail("MALFORMED_PRESENTATION");
    if (!verifyJwtSignature(input.vpJwt, publicKeyFromDidKey(holderDid))) return fail("BAD_HOLDER_PROOF");
    if (String(vp.payload.nonce ?? "") !== input.challenge) return fail("CHALLENGE_MISMATCH");
    const vcJwt = (vp.payload.vp as { verifiableCredential?: unknown[] })?.verifiableCredential?.[0];
    if (typeof vcJwt !== "string") return fail("NO_CREDENTIAL");
    const vc = decodeJwt(vcJwt);
    const issuerDid = String(vc.payload.iss ?? "");
    if (!issuerDid.startsWith("did:key:") || !verifyJwtSignature(vcJwt, publicKeyFromDidKey(issuerDid))) return fail("BAD_ISSUER_SIGNATURE");
    if (!input.trustedIssuers.includes(issuerDid)) return fail("UNTRUSTED_ISSUER");
    const exp = Number(vc.payload.exp ?? 0), nbf = Number(vc.payload.nbf ?? vc.payload.iat ?? 0);
    if (!exp || exp < input.now || nbf > input.now) return fail("CREDENTIAL_EXPIRED");
    const subjectId = String((vc.payload.vc as { credentialSubject?: { id?: string } })?.credentialSubject?.id ?? vc.payload.sub ?? "");
    if (subjectId !== holderDid) return fail("SUBJECT_MISMATCH");
    const cs = { ...(vc.payload.vc as { credentialSubject?: Record<string, unknown> }).credentialSubject };
    delete (cs as { id?: unknown }).id;
    return { valid: true, holderDid, credential: { issuer: issuerDid, subject: subjectId, claims: cs, issuedAt: nbf, expiresAt: exp } };
  } catch { return fail("MALFORMED_PRESENTATION"); }
}
```

- [ ] **Step 4: Run tests** — `pnpm --filter @tokenlayer/core test identity` → all PASS; `pnpm --filter @tokenlayer/core exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(core): verifyPresentation (VP holder proof + VC issuer trust/expiry/binding) + dev issuer helpers"`.

### Task 3: persistence — `User.did` + KYC verification fields

**Files:** Modify `apps/api/src/persistence/types.ts`, `memory.ts`, `prisma.ts`, `apps/api/prisma/schema.prisma`.

- [ ] **Step 1: Types** — in `types.ts`: add `did?: string;` to `UserRecord` (after `kyc`); add `issuerDid?: string; credentialId?: string; verifiedAt?: string;` to `KycDetails`; widen the repo signature to
  `update(id: string, patch: Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active" | "kycStatus" | "did" | "kyc">>): Promise<UserRecord>;`
- [ ] **Step 2: Prisma schema** — add `did String?` to `model User`. Run `pnpm --filter @tokenlayer/api exec prisma generate`.
- [ ] **Step 3: Prisma repo** — in `prisma.ts`: `toUser` maps `did: r.did ?? undefined` (add `did` to the row type + `UserRecord`); `update` signature widened; its `data` serializes `kyc` when present: `data: { ...patch, ...(patch.kyc !== undefined ? { kyc: patch.kyc ? JSON.stringify(patch.kyc) : null } : {}) }` (mirror how `create` serializes kyc). Confirm `create` already round-trips `did` (add `did: input.did` if the create data is explicit).
- [ ] **Step 4: Memory repo** — in `memory.ts`: `update` accepts the widened patch (the existing `Object.assign(rec, patch)` already applies `did`/`kyc`); ensure `create` stores `did`.
- [ ] **Step 5: Typecheck** — `pnpm --filter @tokenlayer/api exec tsc --noEmit` clean; `pnpm --filter @tokenlayer/api test` → 128 passed (no behavior change).
- [ ] **Step 6: Commit** — `git commit -m "feat(api): persist User.did + KYC verification metadata (issuerDid/credentialId/verifiedAt)"`.

### Task 4: challenge store + AppDeps + env wiring

**Files:** Create `apps/api/src/identity-challenges.ts`; modify `apps/api/src/context.ts`, `apps/api/src/env.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`.

- [ ] **Step 1: Create the store** `apps/api/src/identity-challenges.ts`:

```ts
import { randomBytes } from "node:crypto";

export interface ChallengeStore {
  /** Issue a single-use challenge for a user, valid for `ttlMs`. */
  issue(userId: string): { challenge: string; expiresAt: string };
  /** Consume a challenge: true iff it matches an unexpired issued challenge for the user (then removes it). */
  consume(userId: string, challenge: string): boolean;
}

/** In-memory single-use challenges (single-instance demo scope). `nowMs` is injectable for tests. */
export function createMemoryChallengeStore(ttlMs = 5 * 60_000, nowMs: () => number = () => Date.now()): ChallengeStore {
  const byUser = new Map<string, { challenge: string; exp: number }>();
  return {
    issue(userId) {
      const challenge = randomBytes(24).toString("base64url");
      const exp = nowMs() + ttlMs;
      byUser.set(userId, { challenge, exp });
      return { challenge, expiresAt: new Date(exp).toISOString() };
    },
    consume(userId, challenge) {
      const rec = byUser.get(userId);
      if (!rec || rec.challenge !== challenge || rec.exp < nowMs()) return false;
      byUser.delete(userId);
      return true;
    },
  };
}
```

- [ ] **Step 2: AppDeps** — in `context.ts` add to `AppDeps`: `challenges: ChallengeStore;`, `trustedKycIssuers?: string[];`, `devIssuerSeed?: string;` (import `ChallengeStore`).
- [ ] **Step 3: env** — in `env.ts` add to `Env` + parse: `trustedKycIssuers: (process.env.TRUSTED_KYC_ISSUERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)` and `devKycIssuerSeed: process.env.DEV_KYC_ISSUER_SEED` (optional).
- [ ] **Step 4: server wiring** — in `server.ts` construct `createMemoryChallengeStore()` and pass `challenges`, `trustedKycIssuers: env.trustedKycIssuers`, `devIssuerSeed: env.devKycIssuerSeed` into `buildApp({...})`.
- [ ] **Step 5: test helper** — in `helpers.ts` `buildTestApp`: import `createMemoryChallengeStore`; add `challenges: createMemoryChallengeStore()` to the `buildApp` call; allow tests to pass trusted issuers: extend the opts to `{ ...; trustedKycIssuers?: string[] }` and pass `trustedKycIssuers: opts.trustedKycIssuers`.
- [ ] **Step 6: Verify** — `pnpm --filter @tokenlayer/api exec tsc --noEmit` clean; `pnpm --filter @tokenlayer/api test` → 128 passed.
- [ ] **Step 7: Commit** — `git commit -m "feat(api): challenge store + trusted-issuer config wired into AppDeps"`.

### Task 5: routes + schemas + tests

**Files:** Modify `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`; Create `apps/api/test/identity.test.ts`.

- [ ] **Step 1: Write failing tests** `apps/api/test/identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateDidKey, issueCredential, presentCredential } from "@tokenlayer/core";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// A deterministic trusted issuer shared by the test app + the test's credentials.
const issuer = generateDidKey();

async function appWithIssuer() {
  return buildTestApp({ trustedKycIssuers: [issuer.did] });
}
async function pendingInvestor(app: import("fastify").FastifyInstance) {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  const created = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: `inv.${Math.random().toString(36).slice(2)}@x.dev`, password: "secret1", role: "Buyer" } });
  return { admin, userId: created.json().id as string };
}

describe("identity verification", () => {
  it("verifies a valid VP → approves KYC + sets country + did", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const ch = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) });
    expect(ch.statusCode).toBe(200);
    const challenge = ch.json().challenge as string;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN", legalName: "Asha Rao" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", did: holder.did, claims: { country: "IN" } });
    const users = await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) });
    const u = users.json().find((x: { id: string }) => x.id === userId);
    expect(u.kycStatus).toBe("approved");
    expect(u.kyc.country).toBe("IN");
  });

  it("rejects an untrusted issuer with UNTRUSTED_ISSUER (no KYC change)", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [] }); // nothing trusted
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const challenge = (await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) })).json().challenge;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNTRUSTED_ISSUER");
  });

  it("rejects a replayed / unknown challenge", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge: "never-issued", now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CHALLENGE_EXPIRED");
  });

  it("tenancy: an admin cannot verify a user outside their use case", async () => {
    const app = await appWithIssuer();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const { userId } = await pendingInvestor(app); // created under invoice-tokenization (m1.admin)
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(carbon) });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure** — routes 404.

- [ ] **Step 3: Schemas** — add to the `S` object in `schemas.ts` (permissive, house pattern with `security: bearer` + `errs(400, 401, 403)`):

```ts
identityChallenge: { tags: ["Identity"], summary: "Issue a verification challenge for a user", response: { 200: { type: "object", additionalProperties: true } } },
identityVerify: { tags: ["Identity"], summary: "Verify a DID/VC presentation and set KYC", body: { type: "object", required: ["presentation"], properties: { presentation: { type: "string" } } }, response: { 200: { type: "object", additionalProperties: true } } },
identityMint: { tags: ["Identity"], summary: "Dev: mint a demo VP", body: { type: "object", additionalProperties: true }, response: { 200: { type: "object", additionalProperties: true } } },
```
(Match the exact house wrapper — copy the shape of an existing entry like `verifyAssetAudit`.)

- [ ] **Step 4: Routes** in `routes.ts` (import `verifyPresentation, generateDidKey, issueCredential, presentCredential, didKeyFromPublicKey` from `@tokenlayer/core`; import `createHash` from `node:crypto` for the dev seed). Add after the users PATCH route. Reuse the existing `sameScope` guard used by `PATCH /users/:id` — extract it into a helper `canManageTarget(claims, target)` if not already, or inline the identical check:

```ts
// Shared scope guard (identical to PATCH /users/:id).
async function manageableTarget(request: FastifyRequest, reply: FastifyReply): Promise<UserRecord | null> {
  const claims = request.user as TokenClaims;
  const target = await deps.users.findById((request.params as { id: string }).id);
  if (!target) { notFound(reply, "user not found"); return null; }
  const ok = claims.role === "PlatformAdmin" || (canManageUsers(claims.role) && target.useCaseKey === claims.useCaseKey && target.role !== "UseCaseAdmin");
  if (!ok) { reply.code(403).send({ error: "FORBIDDEN", message: "not allowed to manage that user" }); return null; }
  return target;
}

app.post("/users/:id/identity/challenge", { schema: S.identityChallenge, ...auth }, async (request, reply) => {
  const target = await manageableTarget(request, reply);
  if (!target) return reply;
  return deps.challenges.issue(target.id);
});

app.post("/users/:id/identity/verify", { schema: S.identityVerify, ...auth }, async (request, reply) => {
  const target = await manageableTarget(request, reply);
  if (!target) return reply;
  const { presentation } = request.body as { presentation: string };
  // Recover the challenge from the VP and consume it (single-use, unexpired).
  let nonce = "";
  try { nonce = String((JSON.parse(Buffer.from(presentation.split(".")[1] ?? "", "base64url").toString("utf8")) as { nonce?: string }).nonce ?? ""); } catch { /* malformed → handled below */ }
  if (!nonce || !deps.challenges.consume(target.id, nonce)) {
    return reply.code(400).send({ error: "CHALLENGE_EXPIRED", message: "no matching unexpired challenge — request a new one" });
  }
  const result = verifyPresentation({ vpJwt: presentation, challenge: nonce, trustedIssuers: deps.trustedKycIssuers ?? [], now: Math.floor(Date.now() / 1000) });
  if (!result.valid) return reply.code(400).send({ error: result.reason, message: `presentation rejected: ${result.reason}` });
  const claims = result.credential!.claims as { country?: string; legalName?: string };
  await deps.users.update(target.id, {
    kycStatus: "approved",
    did: result.holderDid,
    kyc: { ...(target.kyc ?? {}), country: claims.country, legalName: claims.legalName ?? target.kyc?.legalName, issuerDid: result.credential!.issuer, credentialId: String((decodeVcJti(presentation)) ?? ""), verifiedAt: new Date().toISOString() },
  });
  await deps.audit.append({ assetId: null, actorId: actorOf(request).id, action: "kyc-verified", payload: { userId: target.id, did: result.holderDid, issuer: result.credential!.issuer, country: claims.country ?? null } });
  return { status: "approved", did: result.holderDid, claims: result.credential!.claims, issuer: result.credential!.issuer };
});
```

Add a tiny local helper near the route (extract the inner VC `jti`):
```ts
function decodeVcJti(vpJwt: string): string | null {
  try {
    const vp = JSON.parse(Buffer.from(vpJwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { vp?: { verifiableCredential?: string[] } };
    const vc = vp.vp?.verifiableCredential?.[0]; if (!vc) return null;
    return String((JSON.parse(Buffer.from(vc.split(".")[1] ?? "", "base64url").toString("utf8")) as { jti?: string }).jti ?? "");
  } catch { return null; }
}
```

Note: `"kyc-verified"` is a new audit action string; the audit `action` column is a free string (LifecycleAction is widened by cast at the append boundary — follow how `distribute`/`redeem` are appended). If `deps.audit.append` requires a `LifecycleAction`, pass `action: "kyc-verified" as LifecycleAction` and confirm the analytics/holders folds ignore unknown actions (they do — default no-op).

Dev mint route (gated: only when a dev issuer seed is configured AND not production):
```ts
app.post("/identity/mint", { schema: S.identityMint, ...auth }, async (request, reply) => {
  if (deps.isProduction || !deps.devIssuerSeed) return reply.code(404).send({ error: "NOT_FOUND", message: "not available" });
  if ((request.user as TokenClaims).role !== "PlatformAdmin") return reply.code(403).send({ error: "FORBIDDEN", message: "platform admin only" });
  const { subjectDid, holderSeed, claims, challenge } = request.body as { subjectDid?: string; holderSeed?: string; claims: Record<string, unknown>; challenge: string };
  const issuer = devKeyFromSeed(deps.devIssuerSeed);          // deterministic issuer (its did must be in TRUSTED_KYC_ISSUERS)
  const holder = holderSeed ? devKeyFromSeed(holderSeed) : generateDidKey();
  const subject = subjectDid ?? holder.did;
  const now = Math.floor(Date.now() / 1000);
  const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: subject, claims, expiresAt: now + 86400, now });
  const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
  return { presentation: vp, holderDid: holder.did, issuerDid: issuer.did };
});
```
where `devKeyFromSeed(seed)` derives a deterministic Ed25519 key from a seed via core (add `export function didKeyFromSeed(seed32: Buffer): DidKey` to identity.ts using `createPrivateKey` from a PKCS8-wrapped 32-byte seed, or `generateKeyPairSync` is non-deterministic — so add the seed-based constructor in Task 2's file. **Add this to Task 2**: `didKeyFromSeed(seed: Buffer)` building an Ed25519 private key from the raw seed: `createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"), seed.subarray(0,32)]), format: "der", type: "pkcs8" })`, then derive the public key with `createPublicKey(priv)`.)

- [ ] **Step 5: Run tests** — `pnpm --filter @tokenlayer/api test` → 128 + 4 = 132 passed; `tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `git commit -m "feat(api): DID/VC identity routes — challenge, verify (sets KYC + audit), dev mint"`.

> **Back-fill Task 2**: add `didKeyFromSeed(seed: Buffer): DidKey` (deterministic key from a 32-byte seed via the PKCS8 wrapper above) so both the dev route and the E2E can reproduce the trusted issuer's DID. Add a core test: `didKeyFromSeed(Buffer.alloc(32, 7))` yields a stable did and can sign a JWT that `publicKeyFromDidKey` verifies.

### Task 6: web — Verify-identity action

**Files:** Modify `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/components/UserManagement.tsx`.

- [ ] **Step 1: Types + client** — `types.ts`: `export interface IdentityResult { status: string; did: string; claims: Record<string, unknown>; issuer: string; }`. `api.ts` (inside `api`):
```ts
identityChallenge: (token: string, userId: string) => request<{ challenge: string; expiresAt: string }>(`/users/${userId}/identity/challenge`, token, { method: "POST" }),
identityVerify: (token: string, userId: string, presentation: string) => request<IdentityResult>(`/users/${userId}/identity/verify`, token, { method: "POST", body: JSON.stringify({ presentation }) }),
identityMint: (token: string, body: { subjectDid?: string; holderSeed?: string; claims: Record<string, unknown>; challenge: string }) => request<{ presentation: string; holderDid: string; issuerDid: string }>(`/identity/mint`, token, { method: "POST", body: JSON.stringify(body) }),
```
- [ ] **Step 2: UI** — in `UserManagement.tsx`, for a pending user add a **"Verify identity (DID/VC)"** button opening a small panel: it calls `identityChallenge`, shows a `<textarea>` for the investor's VP-JWT and a **"Generate demo credential"** button (calls `identityMint` with `{ claims: { country: "IN", legalName: <user email> }, challenge }` and fills the textarea), then **"Verify"** calls `identityVerify` and on success shows `status/claims.country/issuer` and refreshes the list (badge → approved); failures render `err.code`. Follow the component's existing fetch/error patterns.
- [ ] **Step 3: Verify** — `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build` → clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(web): Verify identity (DID/VC) action in User Management"`.

### Task 7: verify + live E2E + merge

**Files:** Create `scripts/identity-vc-e2e.mjs`.

- [ ] **Step 1: Full suites** — `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build` → green (core +~9, api 132).
- [ ] **Step 2: E2E** `scripts/identity-vc-e2e.mjs` (Node, imports `@tokenlayer/core` helpers from `packages/core/dist` or via tsx — use the same import style as scripts/multi-dlt-e2e.mjs which imports ethers by abs path; here import from the built core `packages/core/dist/identity.js`, running `pnpm --filter @tokenlayer/core build` first): mint a deterministic issuer from the demo seed; onboard a pending Buyer; `POST …/identity/challenge`; build a holder did:key + VC + VP over the challenge; `POST …/identity/verify` → assert approved + country=IN + did; then the investor **subscribes to an offering through `/assets/:id/buy`** (jurisdiction now passes) — proving the loop; and a second run with a NON-trusted issuer asserts `UNTRUSTED_ISSUER` + KYC stays pending. Requires the running stack booted with `TRUSTED_KYC_ISSUERS=<demo issuer did>` and `DEV_KYC_ISSUER_SEED=<seed>` (add both to docker-compose.besu.yml / .env like the MST keys).
- [ ] **Step 3: Deploy config** — add to `docker-compose.besu.yml` api env: `DEV_KYC_ISSUER_SEED: ${DEV_KYC_ISSUER_SEED:-}` and `TRUSTED_KYC_ISSUERS: ${TRUSTED_KYC_ISSUERS:-}`; put a fixed demo seed + its derived issuer DID in `.env` (compute the DID once via `didKeyFromSeed`). Rebuild api/web, fresh-volume boot, confirm the route exists in the container.
- [ ] **Step 4: Run E2E** — `node scripts/identity-vc-e2e.mjs` → all ✓.
- [ ] **Step 5: Browser** — `preview_start "web"`; as `m1.admin` open User Management, verify a pending investor via "Generate demo credential" → Verify; badge flips to approved; screenshot. Then log in as that investor and confirm they can subscribe in the portal.
- [ ] **Step 6: Merge + memory** — commit the E2E, `git checkout main && git merge --no-ff feat/digital-identity-vc`; update `product-feature-roadmap.md`.

## Self-review

- **Spec coverage:** identity.ts primitives + verifyPresentation (T1/T2), did:key/Ed25519/JWT no-deps (T1), challenge store + trusted-issuer config absent⇒closed (T4/T5), User.did + kyc metadata persistence (T3), challenge/verify/dev-mint routes with the exact failure codes + audit entry (T5), web action (T6), manual PATCH override untouched (unchanged route), core+api+E2E+browser tests (T1/T2/T5/T7), payoff = portal subscription after verify (T7). ✅
- **Placeholders:** none — every step has concrete code. The one back-reference (Task 5 → add `didKeyFromSeed` to Task 2's file) is called out explicitly as a Task-2 back-fill with the exact PKCS8 wrapper bytes. ✅
- **Type consistency:** `PresentationResult`/`VerifyInput`/`IssueInput`/`PresentInput`/`DidKey` used identically across T1/T2/T5; `ChallengeStore.issue/consume` match server + route usage; route `result.reason` codes match core's returned strings and the tests' expected `error` values; `deps.trustedKycIssuers`/`challenges`/`devIssuerSeed` names match context + server + helper. ✅
