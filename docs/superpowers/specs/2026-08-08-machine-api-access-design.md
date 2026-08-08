# Machine API Access — Org-Scoped API Keys (EN-B) — Design

**Goal:** Let any existing application call the platform's REST API without a human login — org-owned API keys bound to a **service user**, carrying **coarse scopes** that can only narrow what that user could do, minted immediately by an OrgAdmin (secret shown once, hashed at rest), revocable and rotatable, rate-limited per key, and **scoped by the EN-A capability envelope for free**. Second sub-project of the Enterprise program (EN-A..F).

**Program context:** The API is already REST under `/api/v1` with an OpenAPI document, but the only way in is `POST /auth/login` with a human's password — there is no machine credential at all. EN-A gave every Organization a governed capability envelope enforced at nine gates. EN-B adds the machine principal that those gates already know how to judge.

**Tech stack:** apps/api (a new `ApiKey` model + a key-aware auth preHandler + key management routes + per-key throttle), apps/web (a Developers surface for key lifecycle). **No core change** — the RBAC and envelope predicates already exist. New dependency: none (bcrypt and the crypto module are already in use).

---

## The seam — why this is small

`requireUser` (`apps/api/src/http/support.ts:31`) already verifies a JWT, **re-reads the principal from the database every request**, and rewrites `request.user` into a `TokenClaims` shape. Every route, RBAC check, maker-checker gate and EN-A envelope check reads that one shape and nothing else.

EN-B therefore does **not** add an authorization model. It adds a second way to *arrive* at the same principal:

```
Authorization: Bearer <jwt>      → existing path → TokenClaims
Authorization: Bearer tl_live_…  → NEW key path  → TokenClaims (+ scopes)
```

The preHandler becomes `requirePrincipal`: sniff the credential, resolve it, populate `request.user` identically. Consequence: **every existing gate applies to keys unchanged, including all nine EN-A gates** — an org tightened to `roles: []` cannot issue via an API key any more than via a browser, with no per-route work and no chance of missing a gate. This is the whole reason the envelope was built first.

## The model

**Service user.** A key is bound to a `User` row in the org, created by the same `POST /orgs/:id/users` path an OrgAdmin already uses, so it carries a real `role`, optional `useCaseKey`, `orgId` and DID/membership credential. Two additions to `UserRecord`: `kind: "human" | "service"` (default `"human"`, absent ⇒ human — the EN-A null-as-legacy pattern) and nothing else. A service user has **no usable password** (the password hash is a random unguessable value; `POST /auth/login` rejects `kind === "service"` outright with 403 `SERVICE_ACCOUNT` so a key's user can never be driven interactively).

**ApiKey** (new Prisma model + memory/prisma repos, full parity checklist):

| field | notes |
|---|---|
| `id` | `ak_…` — the public identifier, safe to log and display |
| `orgId` | owning org (nullable only for platform-owned keys, PlatformAdmin-minted) |
| `userId` | the bound service user — the principal this key becomes |
| `name` | human label ("ERP invoice sync") |
| `prefix` | first 8 chars of the secret, stored plainly for display/lookup (`tl_live_a1b2c3d4…`) |
| `secretHash` | bcrypt hash of the full secret — the secret itself is never stored |
| `scopes` | JSON string[] — coarse scopes (below) |
| `expiresAt` | nullable; null = no expiry |
| `lastUsedAt` | touched on use (throttled write — see below) |
| `revokedAt`, `revokedBy` | null until revoked |
| `createdAt`, `createdBy` | audit |

**Secret format:** `tl_live_<22 chars base62>` from `crypto.randomBytes`, plus a short checksum suffix so an obviously-malformed key is rejected before any hash work. Returned **once** on create/rotate, never retrievable again; the UI says so in the response and on screen.

**Verification path:** parse prefix → look up by prefix (indexed) → reject if revoked/expired → `bcrypt.compare` the full secret → load the bound user → reject if inactive → build `TokenClaims` exactly as `requireUser` does, plus `request.apiKey = {id, scopes}`. bcrypt at cost 12 is ~100ms; a **process-local LRU of verified prefix→{keyId, hash-verified-at}** with a short TTL keeps hot integration traffic fast without ever caching the secret itself. (Rejected: cheap unsalted SHA-256 lookup — a leaked database would then yield working keys.)

## Scopes — coarse, narrowing-only

A closed list, in core alongside the other policy vocabulary so both API and web share it:

```
credentials:read  credentials:issue  credentials:revoke
verifications:read  verifications:request  verifications:verify
assets:read  assets:issue  assets:transfer
users:read  users:onboard
org:read
```

Plus the wildcard `*` meaning "everything this service user's role allows".

**The invariant: scopes only ever NARROW.** Authorization is `roleAllows(user) && envelopeAllows(org) && scopeAllows(key)`. A key with `credentials:issue` bound to a user who cannot issue still cannot issue. This makes scopes safe to hand to integrators and impossible to use for escalation.

**Enforcement point:** a `requireScope("credentials:issue")` preHandler composed onto the routes that matter (the mutating identity/tokenization endpoints + their reads). Requests authenticated by JWT have no key and **bypass the scope check entirely** — scopes are a property of keys, not of humans. Missing scope ⇒ 403 `INSUFFICIENT_SCOPE` with `details: {required, granted}`.

**The EN-A carry-forward:** EN-A deliberately deferred *use-time* binding re-checks for desk principals (an already-minted desk Verifier keeps working if its use case's binding is later edited). Machine keys make that staleness materially worse — a key runs unattended for months. So EN-B adds the deferred re-check **for key-authenticated requests only**, at the two desk gates (`resolveIssuer`'s scoped-operator branch and the desk-verifier branch): when `request.apiKey` is present, re-verify the org's binding against the current config. Human sessions keep today's behavior, so no existing test changes and no surprise lockouts for interactive desks.

## Management API

All under the org scope guard (`orgScoped`), OrgAdmin for their own org, PlatformAdmin anywhere:

- `POST /orgs/:id/api-keys` — body `{name, role, useCaseKey?, scopes, expiresAt?}`. Creates the service user (reusing the existing member-creation path, so `canCreateOrgMember`, the EN-A envelope filter and the EN-A binding check all apply), then the key. **201 with the secret — the only time it exists.** Audited.
- `GET /orgs/:id/api-keys` — list (id, name, prefix, scopes, role, lastUsedAt, expiresAt, revokedAt). Never the secret or hash.
- `POST /orgs/:id/api-keys/:keyId/rotate` — new secret, same key identity/scopes/user; old secret dead immediately. 200 with the new secret. Audited.
- `DELETE /orgs/:id/api-keys/:keyId` — revoke (soft: sets `revokedAt`, keeps the audit trail). The bound service user is deactivated when its last key is revoked. Audited.

**Rate limiting:** per-key token bucket (default 600 req/min, configurable via env), returning 429 `RATE_LIMITED` with `Retry-After`. Reuses the in-process pattern of the existing login throttle; documented as per-instance, not cluster-wide (honest limitation, same as today's login throttle).

**`lastUsedAt`** is written at most once per minute per key (compare-then-write) so a busy integration doesn't turn every call into a database write.

## Web — Developers surface

A new `developers` nav item (shared domain, OrgAdmin + PlatformAdmin): the key table (name, prefix, scopes as pills, role, last used, expiry, status), a create dialog (name, role picker filtered by the EN-A envelope exactly like member-add, scope checkboxes with plain-language descriptions, optional expiry), and a **one-time secret panel** with copy-to-clipboard and an explicit "this will not be shown again" warning that requires an acknowledgement before dismissing. Rotate and Revoke actions with confirmation. A short "Using your key" snippet showing the `Authorization: Bearer` header against a real endpoint.

## Error handling

- Bad/unknown/revoked/expired key ⇒ **401 `UNAUTHORIZED`** with a generic message — never distinguish "unknown" from "revoked" (that would be an oracle).
- Valid key, insufficient scope ⇒ 403 `INSUFFICIENT_SCOPE` (`{required, granted}`).
- Valid key, org envelope forbids ⇒ the existing 403 `ORG_CAPABILITY_MISSING` — unchanged, because the gate is unchanged.
- Rate limited ⇒ 429 `RATE_LIMITED` + `Retry-After`.
- Service user attempting interactive login ⇒ 403 `SERVICE_ACCOUNT`.
- Malformed `Authorization` ⇒ today's 401, unchanged.

**Secret hygiene:** the secret is never logged, never in an audit payload, never in an error message, and never returned by any read route. The audit records the key **id**, never the prefix+secret. Fastify request logging must not serialize the `Authorization` header (verify the current logger config; add a redaction if absent).

## Testing

- **api (auth seam):** a key authenticates and reaches an endpoint its role allows; a revoked key, an expired key, a key whose service user was deactivated, and a garbage key each 401 with the same body; a service user cannot log in interactively; JWT requests are unaffected (the existing suite is the oracle).
- **api (scopes):** `credentials:issue` key issues; the same key cannot revoke (403 `INSUFFICIENT_SCOPE`); `*` behaves as the role allows; **narrowing-only proven** — a key with `credentials:issue` on a Verifier-role service user still 403s on the role gate, not the scope gate.
- **api (envelope carry-forward):** a key belonging to an org tightened to `roles: []` gets `ORG_CAPABILITY_MISSING` on issuance — the EN-A gate firing through the key path with no new code; and the new use-time binding re-check refuses a key whose org was unbound from the use case after minting, while an equivalent human session still succeeds.
- **api (management):** OrgAdmin creates/lists/rotates/revokes for their own org; a foreign OrgAdmin 403s; the secret appears exactly once and never in list/get; rotation invalidates the old secret and keeps scopes; revocation deactivates the last-key service user; rate limit trips at the configured ceiling.
- **web:** tsc + build; live walkthrough — mint a key in the browser, then use it from a plain `curl`/fetch (no cookie, no JWT) to issue a credential end-to-end and see it anchored on-chain; rotate and confirm the old secret 401s; revoke and confirm the new one does too.

## Verification / done

Full core (untouched) + api suites green + web tsc/build + the live Besu walkthrough above, with **the integration exercised as a real external client** (a script holding nothing but the key string), then finish the branch (`feat/api-keys` → main).

## Alternatives considered

- **Keys as a standalone principal type with their own permission list** — duplicates the RBAC model, requires touching every gate, and risks exactly the class of miss EN-A's final review caught. Binding to a service user makes the nine gates apply by construction.
- **Keys as the organization itself** — every route expects a user role; retrofitting an org-principal path across the whole API is a large, high-risk change for no capability gain.
- **Fine-grained per-endpoint scopes** — a large surface to define and keep synchronized with routes; coarse resource:action scopes cover least-privilege for real integrations and stay explainable in docs.
- **Approval-gated key creation** — the governance that matters (what the org may do at all) already sits in the EN-A envelope, which a key can never exceed; requiring a second admin per integration adds friction without adding authority.
- **Unsalted hash for O(1) lookup** — faster, but a leaked database yields working credentials. Prefix-indexed bcrypt with a verified-prefix cache gets the performance without that exposure.
- **JWT-shaped machine tokens (client-credentials grant)** — heavier to operate (introspection, refresh, clock skew) and gives integrators an expiring credential to babysit; opaque revocable keys are the norm for this kind of platform API and revoke instantly.
