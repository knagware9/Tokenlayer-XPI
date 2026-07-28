# ID-D — Passwordless DID-Signature (QR) Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passwordless login by signing a server challenge with a self-custody **device login key** (browser-held Ed25519), bridged cross-device by a **QR code**.

**Architecture:** A challenge-response. The browser holds a device key (private key never leaves it) and registers its public `did:key` as a login key. To log in: `POST /auth/qr/start` → a session + challenge (+ QR of a sign URL) → an enrolled device signs `qr-login:<id>:<challenge>` → `POST /auth/qr/:id/authenticate` verifies the Ed25519 signature server-side and mints the user's normal JWT → the waiting device polls and enters. Core adds one verify helper; api adds a LoginKey model + an in-memory QR-session store + routes; web adds a device-wallet + enrolment/login/sign UIs. Password login is retained (bootstrap + fallback).

**Tech Stack:** packages/core (node Ed25519 verify — reused + 1 helper), apps/api (Fastify + Prisma/SQLite + Vitest + `qrcode`), apps/web (React + Vite + Tailwind + `@noble/ed25519`). Spec: `docs/superpowers/specs/2026-07-28-identity-qr-passwordless-login-design.md`.

**Branch:** create `feat/identity-qr-login` off `main` before Task 1.

## Verified contracts (grounded in current code — do not re-derive)

- **Core crypto** (`packages/core/src/identity.ts`): `publicKeyFromDidKey(did): KeyObject` (throws on malformed), `didKeyFromPublicKey(rawPub: Buffer): string`, `generateDidKey(): { did, publicKey, privateKey }`. Module-private `fromB64u(s): Buffer` and node `verify as edVerify` are in scope. Ed25519 is raw (no pre-hash): `edVerify(null, Buffer.from(msg,"utf8"), key, sig)`. The verify helper reuses these — add it to this file.
- **Login + JWT** (`apps/api/src/http/routes.ts:146`): `POST /auth/login` mints `app.jwt.sign(claims)` where `claims: TokenClaims = { id, email, role, useCaseKey, orgId, did }`, returns `{ token, user: { ...claims, walletAddress } }`. `app` (FastifyInstance) is in scope inside `registerRoutes`. `loginThrottled(request.ip)` throttle helper exists in this file (used by `/auth/login`).
- **Challenge store precedent** (`apps/api/src/identity-challenges.ts`): `createMemoryChallengeStore(ttlMs, nowMs)` — mirror this shape for the QR-session store. Wired as `AppDeps.challenges` (`context.ts:51`), constructed in `server.ts` (`challenges: createMemoryChallengeStore()`).
- **AppDeps** (`apps/api/src/context.ts`): fields include `challenges`, `jwtSecret`, `publicApiUrl`, `corsOrigins?`. Adding required fields means updating EVERY construction site (see below).
- **AppDeps construction sites** (all build the object literal): `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, and harness scripts `apps/api/src/{demo,e2e-buy,e2e-carbon,e2e-tenancy,e2e-usecases}.ts`. Each needs the three new fields.
- **env** (`apps/api/src/env.ts`): `corsOrigins` (from `CORS_ORIGINS`, default `["http://localhost:5173"]`), `publicApiUrl` (from `PUBLIC_API_URL`). Add `publicWebUrl` similarly.
- **Prisma**: `prisma db push` (no migrations). After editing `schema.prisma`: `cd apps/api && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`.
- **Web**: `useAuth()` (`auth.tsx`) exposes `token`, `user`, `login(email,password)`, `logout` — it needs a new `setSession(token, user)` to enter after a passwordless login (mirror `login`'s state+localStorage writes; STORAGE_KEY = `"tokenlayer.session"`). `useRoute()` (`router.tsx`) gives `useCaseKey` (first path segment) + `navigate`; query params via `window.location.search`. `App.tsx` gates: `if (!token||!user) { if routeKey==="signup" Signup; if routeKey==="login" Login; return Home }`. `api.ts` has `request<T>(path, token, init?)`. `Login.tsx` is a two-panel form.
- **Schemas** (`apps/api/src/http/schemas.ts`): `errs(...codes)` helper + `bearer` (= `[{ bearerAuth: [] }]`). Public routes omit `security`. Loose responses use `additionalProperties: true`.
- **Test harness**: `buildTestApp`, `loginAs`, `V1`, `auth` from `apps/api/test/helpers.ts`.

## Deps to add
- `apps/web`: `@noble/ed25519` (browser Ed25519). `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web add @noble/ed25519`.
- `apps/api`: `qrcode` + `@types/qrcode`. `pnpm --filter @tokenlayer/api add qrcode && pnpm --filter @tokenlayer/api add -D @types/qrcode`.

---

## Task 1: Core — `verifyDidSignature`

**Files:**
- Modify: `packages/core/src/identity.ts`
- Test: `packages/core/test/identity.test.ts` (append) — or a new `packages/core/test/did-signature.test.ts`

- [ ] **Step 1: Write failing tests** — create `packages/core/test/did-signature.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sign as edSign } from "node:crypto";
import { generateDidKey, verifyDidSignature } from "../src/identity.js";

const b64u = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("verifyDidSignature", () => {
  it("accepts a valid Ed25519 signature over the message", () => {
    const { did, privateKey } = generateDidKey();
    const msg = "qr-login:sess-1:chal-abc";
    const sig = b64u(edSign(null, Buffer.from(msg, "utf8"), privateKey));
    expect(verifyDidSignature(did, msg, sig)).toBe(true);
  });
  it("rejects a signature over a different message", () => {
    const { did, privateKey } = generateDidKey();
    const sig = b64u(edSign(null, Buffer.from("qr-login:sess-1:chal-abc", "utf8"), privateKey));
    expect(verifyDidSignature(did, "qr-login:sess-1:chal-XXX", sig)).toBe(false);
  });
  it("rejects a signature from a different key", () => {
    const a = generateDidKey(); const b = generateDidKey();
    const msg = "qr-login:s:c";
    const sig = b64u(edSign(null, Buffer.from(msg, "utf8"), b.privateKey));
    expect(verifyDidSignature(a.did, msg, sig)).toBe(false);
  });
  it("returns false (no throw) for a malformed did or signature", () => {
    expect(verifyDidSignature("not-a-did", "m", "sig")).toBe(false);
    const { did, privateKey } = generateDidKey();
    expect(verifyDidSignature(did, "m", "!!!not-base64!!!")).toBe(false);
    void privateKey;
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/core exec vitest run test/did-signature.test.ts`
Expected: FAIL (`verifyDidSignature` not exported).

- [ ] **Step 3: Add the helper** — in `packages/core/src/identity.ts`, after `verifyJwtSignature`, add:
```ts
/**
 * Verify a raw Ed25519 signature (base64url) over `message`'s UTF-8 bytes,
 * against the public key encoded in `did` (did:key ed25519). Returns false on a
 * malformed did/signature rather than throwing. Used by passwordless login.
 */
export function verifyDidSignature(did: string, message: string, signatureB64u: string): boolean {
  try {
    return edVerify(null, Buffer.from(message, "utf8"), publicKeyFromDidKey(did), fromB64u(signatureB64u));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests, verify they pass + typecheck**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/core exec vitest run test/did-signature.test.ts && pnpm --filter @tokenlayer/core exec tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 5: Full core suite + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s --filter @tokenlayer/core test`
```bash
git add packages/core/src/identity.ts packages/core/test/did-signature.test.ts
git commit -m "feat(core): verifyDidSignature — raw Ed25519 verify against a did:key"
```

---

## Task 2: API — LoginKey persistence + QR-session store + env/deps wiring

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/types.ts`, `apps/api/src/persistence/memory.ts`, `apps/api/src/persistence/prisma.ts`
- Create: `apps/api/src/qr-login-sessions.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, `apps/api/src/{demo,e2e-buy,e2e-carbon,e2e-tenancy,e2e-usecases}.ts`
- Test: `apps/api/test/qr-login-store.test.ts` (new)

- [ ] **Step 1: Add deps** — `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api add qrcode && pnpm --filter @tokenlayer/api add -D @types/qrcode`

- [ ] **Step 2: Prisma model** — add to `apps/api/prisma/schema.prisma`:
```prisma
// A self-custody device login key: the public did:key of a browser-held Ed25519
// keypair, registered for passwordless login. The private key never leaves the device.
model LoginKey {
  id         String   @id @default(cuid())
  userId     String
  did        String   @unique
  label      String
  createdAt  DateTime @default(now())
  lastUsedAt DateTime?

  @@index([userId])
}
```
Then: `cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api" && DATABASE_URL="file:./dev.db" ./node_modules/.bin/prisma db push --skip-generate && ./node_modules/.bin/prisma generate`

- [ ] **Step 3: Repository types** — in `apps/api/src/persistence/types.ts` add:
```ts
export interface LoginKeyRecord {
  id: string;
  userId: string;
  did: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface LoginKeyRepository {
  create(input: Omit<LoginKeyRecord, "id" | "createdAt" | "lastUsedAt">): Promise<LoginKeyRecord>;
  listByUser(userId: string): Promise<LoginKeyRecord[]>;
  getByDid(did: string): Promise<LoginKeyRecord | null>;
  get(id: string): Promise<LoginKeyRecord | null>;
  remove(id: string): Promise<void>;
  touch(id: string, at: string): Promise<void>;
}
```

- [ ] **Step 4: Memory repo** — in `apps/api/src/persistence/memory.ts` add `MemoryLoginKeyRepository` (Map-backed; `create` assigns `id("lk")` + `createdAt: now()` + `lastUsedAt: null`; `getByDid` scans; `touch` sets lastUsedAt). Mirror the existing memory repos' `id()`/`now()` helpers.

- [ ] **Step 5: Prisma repo** — in `apps/api/src/persistence/prisma.ts` add a `toLoginKey` mapper (Date→ISO for createdAt/lastUsedAt) + `PrismaLoginKeyRepository` implementing the interface (`create` via `prisma.loginKey.create`; `listByUser` ordered by createdAt; `getByDid`/`get` via findUnique/findFirst; `remove` via delete; `touch` via update lastUsedAt). Mirror `PrismaCredentialUseCaseRepository`.

- [ ] **Step 6: QR-login session store** — create `apps/api/src/qr-login-sessions.ts`:
```ts
import { randomBytes, randomUUID } from "node:crypto";

export type QrLoginStatus = "pending" | "authenticated" | "consumed" | "expired";
export interface QrLoginSession {
  id: string;
  challenge: string;
  status: QrLoginStatus;
  userId: string | null;
  token: string | null;
  createdAt: string;
  expiresAt: string;
}
export interface QrLoginStore {
  start(): QrLoginSession;
  get(id: string): QrLoginSession | null;
  authenticate(id: string, v: { userId: string; token: string }): boolean;
  consume(id: string): QrLoginSession | null;
}

/** In-memory single-use QR-login sessions (single-instance demo scope). */
export function createMemoryQrLoginStore(ttlMs = 3 * 60_000, nowMs: () => number = () => Date.now()): QrLoginStore {
  const byId = new Map<string, QrLoginSession>();
  const fresh = (s: QrLoginSession): QrLoginSession => {
    if (s.status === "pending" && new Date(s.expiresAt).getTime() < nowMs()) s.status = "expired";
    return s;
  };
  return {
    start() {
      const now = nowMs();
      const s: QrLoginSession = {
        id: randomUUID(), challenge: randomBytes(24).toString("base64url"), status: "pending",
        userId: null, token: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
      };
      byId.set(s.id, s);
      return s;
    },
    get(id) { const s = byId.get(id); return s ? { ...fresh(s) } : null; },
    authenticate(id, v) {
      const s = byId.get(id);
      if (!s || fresh(s).status !== "pending") return false;
      s.status = "authenticated"; s.userId = v.userId; s.token = v.token;
      return true;
    },
    consume(id) {
      const s = byId.get(id);
      if (!s || fresh(s).status !== "authenticated") return null;
      s.status = "consumed";
      return { ...s };
    },
  };
}
```

- [ ] **Step 7: env + AppDeps** —
  - `apps/api/src/env.ts`: add `publicWebUrl: string;` to the Env type and `publicWebUrl: process.env.PUBLIC_WEB_URL ?? (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",")[0]!.trim(),` to the loader.
  - `apps/api/src/context.ts`: import the two new types + store; add to `AppDeps`: `loginKeys: LoginKeyRepository;`, `qrLogin: QrLoginStore;`, `publicWebUrl: string;`.

- [ ] **Step 8: Wire every construction site** —
  - `apps/api/src/server.ts`: `const loginKeys = new PrismaLoginKeyRepository();` + in the deps literal add `loginKeys,`, `qrLogin: createMemoryQrLoginStore(),`, `publicWebUrl: env.publicWebUrl,` (import both). 
  - `apps/api/test/helpers.ts` + each harness script (`demo.ts`, `e2e-buy.ts`, `e2e-carbon.ts`, `e2e-tenancy.ts`, `e2e-usecases.ts`): add `loginKeys: new MemoryLoginKeyRepository()`, `qrLogin: createMemoryQrLoginStore()`, `publicWebUrl: "http://localhost:5173"` to each AppDeps literal (import the memory repo + store).

- [ ] **Step 9: Store unit test** — create `apps/api/test/qr-login-store.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createMemoryQrLoginStore } from "../src/qr-login-sessions.js";

describe("qr-login store", () => {
  it("start → authenticate → consume (once)", () => {
    const s = createMemoryQrLoginStore();
    const sess = s.start();
    expect(sess.status).toBe("pending");
    expect(s.authenticate(sess.id, { userId: "u1", token: "jwt" })).toBe(true);
    const c = s.consume(sess.id);
    expect(c?.token).toBe("jwt");
    expect(s.consume(sess.id)).toBeNull(); // only once
    expect(s.get(sess.id)?.status).toBe("consumed");
  });
  it("expires past TTL and cannot authenticate", () => {
    let t = 0; const s = createMemoryQrLoginStore(1000, () => t);
    const sess = s.start();
    t = 2000;
    expect(s.get(sess.id)?.status).toBe("expired");
    expect(s.authenticate(sess.id, { userId: "u1", token: "j" })).toBe(false);
  });
});
```

- [ ] **Step 10: Verify + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/qr-login-store.test.ts && pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: PASS + clean (all construction sites compile with the new fields).
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence apps/api/src/qr-login-sessions.ts apps/api/src/env.ts apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-buy.ts apps/api/src/e2e-carbon.ts apps/api/src/e2e-tenancy.ts apps/api/src/e2e-usecases.ts apps/api/test/qr-login-store.test.ts apps/api/package.json
git commit -m "feat(api): LoginKey persistence + QR-login session store + env/deps wiring"
```

---

## Task 3: API — login-key routes + QR auth routes + schemas

**Files:**
- Modify: `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/qr-login.test.ts` (new)

- [ ] **Step 1: Schemas** — in `apps/api/src/http/schemas.ts` add to `S`:
```ts
  enrollLoginKey: {
    tags: ["Auth"], summary: "Enrol a device login key (public did:key)", security: bearer,
    body: { type: "object", additionalProperties: false, required: ["did", "label"], properties: { did: { type: "string" }, label: { type: "string", minLength: 1 } } },
    response: { 201: { type: "object", additionalProperties: true }, ...errs(400, 401, 409) },
  },
  listLoginKeys: { tags: ["Auth"], summary: "The caller's enrolled device login keys", security: bearer, response: { 200: { type: "array", items: { type: "object", additionalProperties: true } }, ...errs(401) } },
  removeLoginKey: { tags: ["Auth"], summary: "Revoke a device login key", security: bearer, params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 204: { type: "null" }, ...errs(401, 404) } },
  qrStart: { tags: ["Auth"], summary: "Begin a passwordless QR login session", response: { 200: { type: "object", additionalProperties: true } } },
  qrPoll: { tags: ["Auth"], summary: "Poll a QR login session", params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, response: { 200: { type: "object", additionalProperties: true }, ...errs(404) } },
  qrAuthenticate: {
    tags: ["Auth"], summary: "Authenticate a QR login session by signing its challenge",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["did", "signature"], properties: { did: { type: "string" }, signature: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404, 410, 429) },
  },
```

- [ ] **Step 2: Write failing behavioural tests** — create `apps/api/test/qr-login.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { sign as edSign } from "node:crypto";
import { generateDidKey } from "@tokenlayer/core";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const b64u = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signChallenge = (privateKey: import("node:crypto").KeyObject, sessionId: string, challenge: string): string =>
  b64u(edSign(null, Buffer.from(`qr-login:${sessionId}:${challenge}`, "utf8"), privateKey));

describe("passwordless QR login", () => {
  it("enrol → start → authenticate → poll yields a working token", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    // enrol
    const enrol = await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "Test device" } });
    expect(enrol.statusCode).toBe(201);
    // start (public)
    const start = await app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    expect(start.statusCode).toBe(200);
    const { sessionId, challenge, qrSvg, signUrl } = start.json();
    expect(qrSvg).toContain("<svg");
    expect(signUrl).toContain("/qr-sign?session=");
    // authenticate (public, signed)
    const authn = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, challenge) } });
    expect(authn.statusCode).toBe(200);
    // poll → token, once
    const poll = await app.inject({ method: "GET", url: `${V1}/auth/qr/${sessionId}` });
    expect(poll.json().status).toBe("authenticated");
    const token = poll.json().token as string;
    expect(token).toBeTruthy();
    const poll2 = await app.inject({ method: "GET", url: `${V1}/auth/qr/${sessionId}` });
    expect(poll2.json().status).toBe("consumed");
    expect(poll2.json().token ?? null).toBeNull();
    // the token authenticates
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(me.statusCode).toBe(200);
  });

  it("rejects a bad signature, an unknown did, and a revoked key", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    const enrol = await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "d" } });
    const keyId = enrol.json().id as string;
    const start = await app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    const { sessionId, challenge } = start.json();
    // bad signature (wrong message)
    const bad = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, "wrong") } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("BAD_SIGNATURE");
    // unknown did
    const other = generateDidKey();
    const unk = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: other.did, signature: signChallenge(other.privateKey, sessionId, challenge) } });
    expect(unk.statusCode).toBe(401);
    expect(unk.json().error).toBe("UNKNOWN_KEY");
    // revoke then try the real one
    expect((await app.inject({ method: "DELETE", url: `${V1}/me/login-keys/${keyId}`, headers: auth(admin) })).statusCode).toBe(204);
    const revoked = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, challenge) } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error).toBe("UNKNOWN_KEY");
  });

  it("enrol rejects a malformed did (400) and a duplicate (409); lists + is caller-scoped", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: "nope", label: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "x" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "x" } })).statusCode).toBe(409);
    const list = await app.inject({ method: "GET", url: `${V1}/me/login-keys`, headers: auth(admin) });
    expect((list.json() as unknown[]).length).toBe(1);
  });
});
```
(Confirmed: `auth(token: string)` in `helpers.ts` wraps a RAW token string as `{ authorization: "Bearer <token>" }`, and `loginAs` returns a raw token string — so `auth(token)` works directly for the QR-minted token in this test.)

- [ ] **Step 3: Implement the routes** — in `apps/api/src/http/routes.ts`. Add imports: `verifyDidSignature` from `@tokenlayer/core`; `import qrcode from "qrcode";` (top). Place the routes near `/auth/login`.

Login-key management:
```ts
  app.post("/me/login-keys", { schema: S.enrollLoginKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const b = request.body as { did: string; label: string };
    if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(b.did)) return reply.code(400).send({ error: "BAD_DID", message: "expected a did:key ed25519" });
    if (await deps.loginKeys.getByDid(b.did)) return reply.code(409).send({ error: "KEY_ENROLLED", message: "this device key is already enrolled" });
    const rec = await deps.loginKeys.create({ userId: claims.id, did: b.did, label: b.label });
    return reply.code(201).send({ id: rec.id, did: rec.did, label: rec.label, createdAt: rec.createdAt });
  });

  app.get("/me/login-keys", { schema: S.listLoginKeys, ...auth }, async (request) => {
    const claims = request.user as TokenClaims;
    return (await deps.loginKeys.listByUser(claims.id)).map((k) => ({ id: k.id, did: k.did, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
  });

  app.delete("/me/login-keys/:id", { schema: S.removeLoginKey, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const rec = await deps.loginKeys.get(id);
    if (!rec || rec.userId !== claims.id) return notFound(reply, "login key not found");
    await deps.loginKeys.remove(id);
    return reply.code(204).send();
  });
```

QR auth:
```ts
  app.post("/auth/qr/start", { schema: S.qrStart }, async () => {
    const sess = deps.qrLogin.start();
    const signUrl = `${deps.publicWebUrl}/qr-sign?session=${sess.id}&challenge=${encodeURIComponent(sess.challenge)}`;
    const qrSvg = await qrcode.toString(signUrl, { type: "svg", margin: 1, width: 240 });
    return { sessionId: sess.id, challenge: sess.challenge, signUrl, qrSvg, expiresAt: sess.expiresAt };
  });

  app.get("/auth/qr/:id", { schema: S.qrPoll }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const sess = deps.qrLogin.get(id);
    if (!sess) return notFound(reply, "login session not found");
    if (sess.status === "authenticated") {
      const done = deps.qrLogin.consume(id); // release the token exactly once
      if (done?.token && done.userId) {
        const user = await deps.users.findById(done.userId);
        const wallet = user?.accountId ? await deps.accounts.findById(user.accountId) : null;
        const claims = user ? { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null } : null;
        return { status: "authenticated", token: done.token, user: claims ? { ...claims, walletAddress: wallet?.address ?? null } : null };
      }
    }
    return { status: sess.status };
  });

  app.post("/auth/qr/:id/authenticate", { schema: S.qrAuthenticate }, async (request, reply) => {
    if (loginThrottled(request.ip)) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "too many attempts; try again later" });
    const { id } = request.params as { id: string };
    const b = request.body as { did: string; signature: string };
    const sess = deps.qrLogin.get(id);
    if (!sess) return notFound(reply, "login session not found");
    if (sess.status !== "pending") return reply.code(410).send({ error: "SESSION_EXPIRED", message: `session is ${sess.status}` });
    const key = await deps.loginKeys.getByDid(b.did);
    if (!key) return reply.code(401).send({ error: "UNKNOWN_KEY", message: "device key is not enrolled" });
    if (!verifyDidSignature(b.did, `qr-login:${sess.id}:${sess.challenge}`, b.signature)) {
      return reply.code(401).send({ error: "BAD_SIGNATURE", message: "signature does not verify" });
    }
    const user = await deps.users.findById(key.userId);
    if (!user || !user.active) return reply.code(401).send({ error: "ACCOUNT_SUSPENDED", message: "account unavailable" });
    const claims: TokenClaims = { id: user.id, email: user.email, role: user.role, useCaseKey: user.useCaseKey, orgId: user.orgId ?? null, did: user.did ?? null };
    const token = app.jwt.sign(claims);
    if (!deps.qrLogin.authenticate(id, { userId: user.id, token })) return reply.code(410).send({ error: "SESSION_EXPIRED", message: "session no longer pending" });
    await deps.loginKeys.touch(key.id, new Date().toISOString());
    return { ok: true };
  });
```

- [ ] **Step 4: Run tests, iterate to green**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/qr-login.test.ts`
Expected: all pass. (Adjust the `auth(token)` helper usage per the Step 2 note if needed.)

- [ ] **Step 5: Typecheck + full suite + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm -s --filter @tokenlayer/api test`
Expected: clean; full suite green.
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/qr-login.test.ts
git commit -m "feat(api): device login-key enrolment + QR passwordless-login routes"
```

---

## Task 4: Web — device wallet + client + auth setSession + enrolment UI

**Files:**
- Modify: `apps/web/package.json` (dep), `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/auth.tsx`
- Create: `apps/web/src/lib/device-wallet.ts`
- Modify: `apps/web/src/components/MyProfile.tsx`

- [ ] **Step 1: Add dep** — `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web add @noble/ed25519`

- [ ] **Step 2: Device wallet** — create `apps/web/src/lib/device-wallet.ts`:
```ts
import * as ed from "@noble/ed25519";

const PRIV_KEY = "tokenlayer.deviceKey"; // hex-encoded 32-byte private key (self-custody; never sent)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function didKeyFromPub(pub: Uint8Array): string {
  const prefixed = new Uint8Array(pub.length + 2); prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  return "did:key:z" + base58(prefixed);
}

export function hasDeviceKey(): boolean { return !!localStorage.getItem(PRIV_KEY); }

/** Return (creating + persisting if needed) this device's self-custody key. */
export async function getOrCreateDeviceKey(): Promise<{ did: string; sign: (msg: string) => Promise<string> }> {
  let hex = localStorage.getItem(PRIV_KEY);
  if (!hex) { hex = toHex(ed.utils.randomPrivateKey()); localStorage.setItem(PRIV_KEY, hex); }
  const priv = fromHex(hex);
  const pub = await ed.getPublicKeyAsync(priv);
  return {
    did: didKeyFromPub(pub),
    sign: async (msg: string) => b64u(await ed.signAsync(new TextEncoder().encode(msg), priv)),
  };
}
```

- [ ] **Step 3: auth.setSession** — in `apps/web/src/auth.tsx`, add `setSession: (token: string, user: SessionUser) => void;` to `AuthState`, and implement it in the `value` object (mirroring `login`'s writes):
```ts
      setSession(token, user) {
        setToken(token);
        setUser(user);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }));
      },
```

- [ ] **Step 4: types + client** — in `apps/web/src/types.ts` add:
```ts
export interface LoginKeyInfo { id: string; did: string; label: string; createdAt: string; lastUsedAt: string | null; }
export interface QrLoginStart { sessionId: string; challenge: string; signUrl: string; qrSvg: string; expiresAt: string; }
export interface QrLoginPoll { status: "pending" | "authenticated" | "consumed" | "expired"; token?: string; user?: SessionUser; }
```
In `apps/web/src/api.ts` add:
```ts
  enrollLoginKey: (token: string, body: { did: string; label: string }) =>
    request<LoginKeyInfo>("/me/login-keys", token, { method: "POST", body: JSON.stringify(body) }),
  loginKeys: (token: string) => request<LoginKeyInfo[]>("/me/login-keys", token),
  removeLoginKey: (token: string, id: string) => request<null>(`/me/login-keys/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  qrStart: () => request<QrLoginStart>("/auth/qr/start", null, { method: "POST", body: "{}" }),
  qrPoll: (id: string) => request<QrLoginPoll>(`/auth/qr/${encodeURIComponent(id)}`, null),
  qrAuthenticate: (id: string, body: { did: string; signature: string }) =>
    request<{ ok: boolean }>(`/auth/qr/${encodeURIComponent(id)}/authenticate`, null, { method: "POST", body: JSON.stringify(body) }),
```
Import the new types.

- [ ] **Step 5: Enrolment UI** — in `apps/web/src/components/MyProfile.tsx` add a "Passwordless login" card (below the profile): a button "Set up passwordless login on this device" → `getOrCreateDeviceKey()` → `api.enrollLoginKey(token, { did, label })` (label from `navigator.userAgent` shortened) → refresh the list; a list of `api.loginKeys(token)` rows (label · did-truncated · created) each with a **Revoke** button (`api.removeLoginKey`). Show the current device's did with a "this device" marker when it matches `getOrCreateDeviceKey().did`. Surface `ApiError.message` inline.

- [ ] **Step 6: Typecheck + build + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean.
```bash
git add apps/web/src apps/web/package.json
git commit -m "feat(web): device wallet + login-key client + enrolment UI"
```

---

## Task 5: Web — login QR panel + /qr-sign page + routing

**Files:**
- Create: `apps/web/src/components/QrSign.tsx`
- Modify: `apps/web/src/components/Login.tsx`, `apps/web/src/App.tsx`

- [ ] **Step 1: QR sign page** — create `apps/web/src/components/QrSign.tsx`: reads `session` + `challenge` from `new URLSearchParams(window.location.search)`; shows "Approve sign-in on your other device?"; on approve, `getOrCreateDeviceKey()` → `sign(\`qr-login:${session}:${challenge}\`)` → `api.qrAuthenticate(session, { did, signature })`; shows success ("You can return to the other device") or the coded error. If `!hasDeviceKey()`, explain this device isn't enrolled and link to logging in normally to enrol. Standalone full-screen layout (mirror Login's centered card); does not require an app session.

- [ ] **Step 2: Login QR panel** — in `apps/web/src/components/Login.tsx` add a passwordless panel beneath the email/password form:
  - A "Sign in with QR" button → `api.qrStart()` → render `qrSvg` (via `dangerouslySetInnerHTML` of the SVG string, or an `<img src={data:image/svg+xml,...}>`) + "Scan with an enrolled device" + poll `api.qrPoll(sessionId)` every 2s; on `authenticated` with a token → `setSession(token, user)` (from `useAuth`).
  - If `hasDeviceKey()`: also a "Use this device" button → `qrStart()` → `getOrCreateDeviceKey().sign(qr-login:<id>:<challenge>)` → `api.qrAuthenticate` → poll once → `setSession`. (Single-device passwordless, no scan.)
  - Stop polling on unmount / success / expiry.

- [ ] **Step 3: Route /qr-sign** — in `apps/web/src/App.tsx`, at the VERY TOP of `App()` (before the `if (!token || !user)` gate), add:
```tsx
  if (routeKey === "qr-sign") return <QrSign />;
```
and import `QrSign`. (An enrolled device opening the QR URL reaches the sign page regardless of its own session state.)

- [ ] **Step 4: Typecheck + build + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean.
```bash
git add apps/web/src
git commit -m "feat(web): passwordless QR login panel + /qr-sign approval page"
```

---

## Task 6: Verify — full suite + live browser walkthrough + finish

**Files:** none.

- [ ] **Step 1: Full workspace gate**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s typecheck && pnpm -s --filter @tokenlayer/core test && pnpm -s --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build`
Expected: typecheck clean (all packages); core + api suites green; web builds.

- [ ] **Step 2: Boot live stack (fast, UI-focused)** — the QR-login runtime needs no chain, so use the ID-C fast-boot recipe: a throwaway DB + `CHAIN_STRICT=0`, sourcing only `DID_MASTER_KEY`/`JWT_SECRET`/escrow from `.env` (registry absent is fine — QR login doesn't anchor). Set `PUBLIC_WEB_URL=http://localhost:5173`. Start the web preview. (Leave the user's `dev.db` untouched.)

- [ ] **Step 3: Live API walkthrough (curl/script)** — log in (password) as `admin@tokenlayer.dev`; the browser can't be scripted for signing, so drive the crypto with a tiny node snippet using `@tokenlayer/core` `generateDidKey` + node `sign`: enrol the did via `POST /me/login-keys`, `POST /auth/qr/start`, sign `qr-login:<id>:<challenge>`, `POST /auth/qr/:id/authenticate`, then `GET /auth/qr/:id` → confirm a token that authenticates `GET /me`. Capture as proof.

- [ ] **Step 4: Live browser walkthrough** — in the preview: log in with a password → **My Profile → Set up passwordless login on this device** (enrols this browser's key). Log out. On the login page → **"Use this device"** → confirm passwordless entry. Then demonstrate cross-device: on the login page click **Sign in with QR**, copy the `signUrl` (or open the rendered QR's target) in the SAME browser's `/qr-sign` page (the enrolled session), approve, and watch the login page enter. Screenshot the enrolment, the passwordless login, and the QR panel.

- [ ] **Step 5: Finish the branch** — use `superpowers:finishing-a-development-branch` (verify tests pass, then present options; merge locally to `main` per this program's pattern unless the user chooses otherwise).

---

## Self-review checklist (author)

- **Spec coverage:** verify helper (T1) ✓; LoginKey + session store + env/deps (T2) ✓; enrol/list/revoke + qr start/poll/authenticate routes + signature verify + qrcode (T3) ✓; device wallet + client + setSession + enrolment UI (T4) ✓; login QR panel + qr-sign page + routing (T5) ✓; live verify (T6) ✓. Password login retained; no chain dependency.
- **Wire-format interop:** the signed message `qr-login:<sessionId>:<challenge>` is identical in the browser sign (T4 device-wallet), the api verify (T3 route), and both test signers (T1 core test, T3 api test). did:key encoding (0xed01 + base58btc) matches core's `didKeyFromPublicKey` (T4 base58 mirrors `packages/core/src/identity.ts`). base64url on both sides.
- **Type consistency:** `LoginKeyRecord`/`LoginKeyRepository` (T2) ↔ route reads (T3) ↔ web `LoginKeyInfo` (T4). `QrLoginStart`/`QrLoginPoll` (T4 web) ↔ route responses (T3). `AppDeps.{loginKeys,qrLogin,publicWebUrl}` (T2) added to ALL construction sites (T2 Step 8).
- **Security:** challenge single-use + TTL + session-bound message (no replay); verify rate-limited (`loginThrottled`); token released once (poll consumes); enrol requires auth; private key never sent. No placeholder steps — every code step has real code; the two "confirm the helper" notes are explicit implementer checks.
