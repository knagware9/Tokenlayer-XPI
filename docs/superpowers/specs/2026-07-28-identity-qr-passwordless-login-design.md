# Identity Domain — Passwordless DID-Signature (QR) Login (ID-D) — Design

**Goal:** Let a user sign in **without a password** by proving control of a **device-held DID key**, and use a **QR code** to bridge that proof to a second, unenrolled device. A user enrols a device once (its browser generates a self-custody Ed25519 keypair and registers only the public `did:key`); thereafter that device authenticates by signing a server challenge, and can authorise a new device via QR.

**Program context:** ID-D is sub-project 4 of the 5-part Identity program (one XI app, two pluggable domains): **ID-A** credential use-case engine (MERGED) · **ID-B** issuer/holder/verifier runtime (MERGED) · **ID-C** entity wallet + My Credentials (MERGED) · **ID-D** passwordless QR login (this spec) · **ID-E** pluggable domain shell.

**Tech stack:** packages/core (server-side Ed25519 verify — reused, unchanged), apps/api (Fastify + Prisma/SQLite + Vitest — LoginKey model, QR-session store, routes, `qrcode`), apps/web (React + Vite + Tailwind — a browser device-wallet using `@noble/ed25519`, enrolment + login + sign UIs).

---

## The custodial-key reconciliation (why a device key)

The platform's identity DIDs are **custodial**: each Ed25519 seed is stored server-side, AES-256-GCM-encrypted under `DID_MASTER_KEY`. A genuine *passwordless DID-signature* login requires the **signing device to hold its own private key** — the server signing on the user's behalf would only be authorisation, not proof of device possession. Since a custodial seed must never leave the server, ID-D introduces a **separate, self-custody device login key**:

- The **identity DID** (custodial, used for VCs) is **never** used for login and is unchanged.
- A **device login key** is a fresh Ed25519 keypair generated in the browser; the **private key stays in the browser** (localStorage), and only the public `did:key` is registered on the account.

Bootstrapping is inherent: a user logs in once with a password to **enrol** a device; after that, that device logs in passwordlessly and can authorise other devices by QR. Password login is retained (bootstrap + fallback).

---

## Scope

**In scope (ID-D):**
- A browser device-wallet: generate / store / sign with a self-custody Ed25519 key; derive its `did:key`.
- Enrolment: register a device's public `did:key` as a **login key** on the account (authenticated); list + revoke login keys.
- Passwordless login on an enrolled device (sign a challenge → token).
- QR cross-device login: an enrolled device signs a challenge shown as a QR on an unenrolled device, which then logs in.

**Out of scope (later / deferred):**
- Replacing password login (kept as bootstrap + fallback).
- Multi-instance/persistent QR-session store (in-memory single-instance is fine for the demo, matching the existing `ChallengeStore`).
- Native mobile app / camera scanning (the QR encodes a URL an enrolled browser opens; camera scanning by a phone opens that URL in its enrolled session — no in-app scanner is built).
- Recovery of a lost device beyond **revoke the key + re-enrol** (no key escrow — the whole point is self-custody).
- Domain selector — **ID-E**.

---

## Architecture

Four layers, building on the existing auth (`POST /auth/login` → `app.jwt.sign(claims)`):

1. **Browser device-wallet (web)** — `@noble/ed25519` key gen + sign; `did:key` encode; local private-key storage.
2. **Persistence (api)** — a `LoginKey` model (userId → registered device DIDs) + an in-memory QR-login **session store** (challenge, status, minted token).
3. **Routes (api)** — enrol / list / revoke login keys; QR session `start` / `poll` / `authenticate`.
4. **Web** — enrolment (My Profile), a login-page QR + one-tap panel, and a `/qr-sign` approval page.

The unifying primitive: a **challenge-response**. The server issues a single-use challenge bound to a session; a device holding a registered login key signs it; the server verifies the Ed25519 signature against the key's `did:key` and, if it maps to a user, mints that user's normal JWT.

---

## 1. Crypto

- **Server verify (reuse):** `packages/core/src/identity.ts` already exposes `publicKeyFromDidKey(did): KeyObject` and node-crypto Ed25519 verify (`verify(null, msg, key, sig)` as used by `verifyJwtSignature`). ID-D adds one thin exported helper **in core** — `verifyDidSignature(did: string, message: string, signatureB64u: string): boolean` — that builds the public key from the `did:key` (returns false on a malformed did rather than throwing) and verifies raw Ed25519 over `message`'s UTF-8 bytes. Existing functions are unchanged; this is the only core addition.
- **Browser sign (new, `apps/web`):** `@noble/ed25519` for `generateKey`/`sign`; a ~30-line inline base58btc encoder to build `did:key:z<base58btc(0xed 0x01 || pubkey)>` from the raw public key. The signed **message** is a canonical string binding the session: `qr-login:<sessionId>:<challenge>`. Signatures are base64url. Raw Ed25519 (RFC 8032, no pre-hash) on both sides interops.

## 2. Persistence

**`LoginKey`** (Prisma model + memory/prisma repos + `AppDeps.loginKeys`):
```
model LoginKey {
  id         String   @id @default(cuid())
  userId     String
  did        String   @unique   // the device's public did:key
  label      String              // e.g. "Chrome on MacBook"
  createdAt  DateTime @default(now())
  lastUsedAt DateTime?
  @@index([userId])
}
```
Repo: `create`, `listByUser(userId)`, `getByDid(did)`, `get(id)`, `remove(id)`, `touch(id, at)`.

**QR-login session store** (in-memory, `apps/api/src/qr-login-sessions.ts`, mirroring `identity-challenges.ts`; `nowMs` injectable for tests):
```
interface QrLoginSession {
  id: string; challenge: string;
  status: "pending" | "authenticated" | "consumed" | "expired";
  userId: string | null; token: string | null;
  createdAt: string; expiresAt: string;
}
createMemoryQrLoginStore(ttlMs = 3*60_000, nowMs = Date.now):
  start(): QrLoginSession                       // new pending session + challenge
  get(id): QrLoginSession | null                // marks expired past TTL
  authenticate(id, { userId, token }): boolean  // pending → authenticated (once)
  consume(id): QrLoginSession | null            // authenticated → consumed, returns it once
```
Wired into `AppDeps.qrLogin` (like `challenges`).

## 3. Routes (api)

- `POST /me/login-keys` (auth) — body `{ did, label }`. Validates the `did` is a well-formed `did:key` ed25519 (reject otherwise, 400); rejects a `did` already registered (409 `KEY_ENROLLED`). Creates a `LoginKey` for `claims.id`. `201 { id, did, label, createdAt }`.
- `GET /me/login-keys` (auth) → the caller's enrolled devices `[{ id, did, label, createdAt, lastUsedAt }]`.
- `DELETE /me/login-keys/:id` (auth) — only the owner may remove; `204`. (404 if not theirs.)
- `POST /auth/qr/start` (public) → `{ sessionId, challenge, signUrl, qrSvg, expiresAt }`. `signUrl = ${webUrl}/qr-sign?session=<id>&challenge=<challenge>`; `qrSvg` = server-rendered QR (node `qrcode.toString(signUrl, { type: "svg" })`) encoding `signUrl`. `webUrl` resolves from a new optional `PUBLIC_WEB_URL` env, falling back to the first configured CORS origin (`corsOrigins[0]`), default `http://localhost:5173` — wired into `AppDeps` alongside the existing `publicApiUrl`.
- `GET /auth/qr/:id` (public poll) → `{ status, token?, user? }`. On `authenticated`, returns the token + user **once** and `consume`s the session (subsequent polls read `consumed`). Never returns the token twice.
- `POST /auth/qr/:id/authenticate` (public, rate-limited via the existing login throttle) — body `{ did, signature }`. Steps: load the session (404/410 if missing/expired); resolve `LoginKey` by `did` (401 `UNKNOWN_KEY`); `verifyDidSignature(did, "qr-login:<id>:<challenge>", signature)` (401 `BAD_SIGNATURE`); load the owning user (401 if inactive); mint `app.jwt.sign(claims)`; `qrLogin.authenticate(id, { userId, token })`; `loginKeys.touch`. `200 { ok: true }`. The device that started the session receives the token via its poll.

## 4. Web

- **Device wallet** (`apps/web/src/lib/device-wallet.ts`): `getOrCreateDeviceKey()` (generate + persist the private key to localStorage under a stable key; return `{ did, sign(message): Promise<string> }`), `hasDeviceKey()`, `deviceDid()`. Private key never leaves the browser.
- **Enrolment** — in `MyProfile` (or a dedicated "Passwordless login" card): "Set up passwordless login on this device" → `getOrCreateDeviceKey()` → `POST /me/login-keys { did, label }` (label auto-derived from the UA); shows the device DID + a list of enrolled devices (`GET /me/login-keys`) each with **Revoke** (`DELETE`).
- **Login page** — a "Sign in with QR / passwordless" panel:
  - `POST /auth/qr/start` → render `qrSvg` + poll `GET /auth/qr/:id` every ~2s; on `authenticated`, store `{ token, user }` and enter the app.
  - If **this** browser is already enrolled (`hasDeviceKey()`), also show **"Use this device"** — sign the challenge locally and `POST …/authenticate` immediately (single-device passwordless, no scan).
- **`/qr-sign` page** (reached by opening the QR's `signUrl` on an enrolled device) — reads `session` + `challenge` from the query, shows "Approve sign-in as <device>?", signs `qr-login:<session>:<challenge>` with the local key, `POST /auth/qr/:id/authenticate { did, signature }`, shows success/failure. If the device isn't enrolled, it prompts to enrol first.

## Data flow

Enrol (once, authenticated): browser generates a key → registers its `did:key`. Passwordless login: the login page starts a session (challenge + QR) → an enrolled device signs `qr-login:<id>:<challenge>` → the server verifies against the registered `did:key` → mints the user's JWT → the waiting page polls and enters the app. Single-device: the enrolled login page signs its own challenge and logs in directly.

## Error handling

Coded, HTTP-mapped: `BAD_DID` (400, malformed `did:key`), `KEY_ENROLLED` (409), `UNKNOWN_KEY` (401, `did` not registered), `BAD_SIGNATURE` (401), `SESSION_EXPIRED` (410), `SESSION_NOT_FOUND` (404), `ACCOUNT_SUSPENDED` (401, inactive owner), `TOO_MANY_REQUESTS` (429, throttle). The web login/sign pages surface the coded message inline. The token is released exactly once (poll consumes it).

## Security

- Challenge single-use + short TTL (3 min); the signed message binds `sessionId + challenge` (no cross-session replay). Verify endpoint rate-limited (reuse `loginThrottled`).
- Enrolment requires an authenticated session — only the account owner registers keys on their account. `did` is globally unique (a device key maps to exactly one user).
- The private key never leaves the browser; the server stores only public `did`s and verifies signatures. A lost device → the owner revokes its LoginKey.
- The minted JWT is the user's normal session token (same claims/authority as a password login) — passwordless login is an alternative bootstrap, not a privilege change.

## Testing

- **api (behavioural):** enrol a key → `start` → sign the challenge with a test Ed25519 key (node crypto, matching the browser wire format) → `authenticate` 200 → poll returns a token that authenticates a follow-up `GET /me`; bad signature → 401 `BAD_SIGNATURE`; unknown did → 401 `UNKNOWN_KEY`; expired/replayed challenge → 410/consumed; a revoked key can't authenticate; enrolling a malformed did → 400; duplicate did → 409; the token is returned only once (second poll shows `consumed`).
- **web:** tsc + build; a browser walkthrough — enrol this device, log out, passwordless "Use this device" login, and a cross-device QR sign-in (open the `signUrl` in the enrolled session to approve, watch the other page log in).
- **crypto interop:** an api test signs with node `sign(null, msg, privKey)` and verifies via `verifyDidSignature`, proving the wire format the browser produces is accepted.

## Verification / done

Full api suite green (with the new tests) + web tsc/build + a live browser walkthrough of enrol → passwordless login → cross-device QR sign-in, then finish the branch. ID-E (domain shell) is the last identity sub-project.
