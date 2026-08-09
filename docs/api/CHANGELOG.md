# XI Tokenize API — changelog

Changes to the **public REST surface** under `/api/v1`, newest first. This file
is for people writing code against the API. Every entry tries to answer two
questions and nothing else: *what changed*, and *what must I do differently?*

Where a change could break a working integration it is marked **ACTION
REQUIRED**. Where we are not certain whether something was breaking, the entry
says what was checked rather than claiming a verdict.

The published reference is the OpenAPI document at `GET /openapi.json` (Swagger
UI at `/docs`). Its machine-readable surface — which credentials each route
accepts, which scope a key needs, which status codes it can answer — is
committed at `apps/api/openapi.snapshot.json`, so any change to it appears in a
diff. That file is generated, not written by hand; see the header of
`apps/api/src/http/openapi-snapshot.ts` for what it does and does not promise.

---

## Unreleased — documentation corrections (EN-D1)

No behaviour changed. The **document** changed, and in one place it had been
telling you something false.

- **`bearerFormat: "JWT"` was declared for all access.** The document described a
  single credential, `bearerAuth`, with `bearerFormat: JWT`. That is correct for
  a human session token from `POST /auth/login`, and **wrong for an organization
  API key**: `tl_live_…` values are opaque secrets. There is no payload to
  decode, no expiry to read out of them, and no claims inside. If you wrote code
  that base64-decodes a key, or that reads an expiry from one to decide when to
  rotate, that code was never going to work — the document told you it would.

  There are now two schemes. `bearerAuth` (human session JWT) keeps
  `bearerFormat: JWT`. `apiKeyAuth` (org API key) deliberately declares **no**
  `bearerFormat`. Both still travel in the same `Authorization: Bearer …` header.

- **Per-route credentials are now documented.** Previously every route advertised
  `bearerAuth` alone, so the document said machine access did not exist while the
  server was serving it. Each route now advertises the credentials it actually
  accepts, and every key-callable route names the scope it requires in its
  description. These are now checked against the server's own scope gate on every
  build, so the document cannot silently drift from it again.

- **Response shapes are documented.** Most routes previously published "returns an
  object" and named no field. The integration surface now enumerates what it
  returns. This was additive only — no response schema was narrowed, and that is
  enforced by a test, because narrowing one would silently strip fields from live
  responses.

- **Tags, version, server.** All 23 tag groups are described (API Keys, Webhooks,
  Credentials and Verification previously rendered ungrouped); `info.version` is
  read from the package rather than frozen at `1.0.0`; the document now carries a
  `servers` entry, so generated clients and the "Try it" button have a base URL.

- **`/docs` and `/openapi.json` now exist in production**, behind a session or an
  API key. Previously they were registered only outside production, so a
  production deployment answered 404. If you were relying on that 404 as a
  signal, it is now a 401 for an anonymous caller.

---

## 2026-08-09 — Webhooks & events (EN-C)

Merge `b2555b0`. You no longer have to poll. The platform records what happened
in a durable, globally ordered event log and pushes it to your endpoints.

**New endpoints** (all org-scoped; `:id` is your organization id):

| Method | Path | Scope |
|---|---|---|
| `POST` | `/orgs/:id/webhooks` | `webhooks:write` |
| `GET` | `/orgs/:id/webhooks` | `webhooks:read` |
| `PATCH` | `/orgs/:id/webhooks/:whId` | `webhooks:write` |
| `POST` | `/orgs/:id/webhooks/:whId/rotate` | `webhooks:write` |
| `DELETE` | `/orgs/:id/webhooks/:whId` | `webhooks:write` |
| `POST` | `/orgs/:id/webhooks/:whId/test` | `webhooks:write` |
| `GET` | `/orgs/:id/webhooks/:whId/deliveries` | `webhooks:read` |
| `POST` | `/orgs/:id/webhooks/:whId/deliveries/:dId/replay` | `webhooks:write` |
| `GET` | `/events?after=<seq>` | `webhooks:read` |

Two new API-key scopes, `webhooks:read` and `webhooks:write`. They are split so
that an integration which only consumes the cursor cannot rotate a signing secret
or repoint a delivery URL. **Keys minted before this release do not carry them** —
mint or rotate a key with the scopes you need.

### Verifying a delivery

Every delivery carries these headers:

```
Tokenlayer-Event-Id:    <cuid>     the stable event id — dedupe on this
Tokenlayer-Delivery-Id: <cuid>     this attempt chain
Tokenlayer-Event-Type:  asset.issued
Tokenlayer-Signature:   t=<unix-seconds>,v1=<hex hmac-sha256>
```

`v1` is `HMAC-SHA256(secret, "<t>.<raw request body>")`, hex-encoded.

**Verify over the RAW body — the exact bytes you received.** If your framework
parses JSON and you re-serialize it to check the signature, key order or number
formatting will differ and every delivery will fail verification. Capture the raw
body before parsing.

Parse the header **by parameter name, not by position**: `v1=` is a version
prefix, and a future scheme may add parameters. Ignore ones you do not know.

Check that `t` is within your tolerance of now (we use 300 seconds, a clock-skew
budget). The timestamp is inside the signed material, so it cannot be re-stamped
by an attacker who captured a delivery — but a captured delivery **can** be
replayed verbatim inside that window, which is why the next point matters.

The signing secret is returned **once**, in the response to create or rotate. It
is never retrievable afterwards. Store it before you acknowledge the call.

### Delivery semantics — read this before you write your handler

- **At least once, not exactly once.** Deduplicate on `Tokenlayer-Event-Id` and
  make your handler idempotent. Verify the signature *first*, then ignore an id
  you have already processed.
- **Ordering is not guaranteed.** Deliveries are retried independently, so a
  later event can arrive before an earlier one. If you need order, sort by the
  `seq` in the payload, or reconcile from `GET /events?after=`.
- Respond **2xx** to acknowledge. Anything else — including a 3xx redirect — is
  a failed attempt. Retries back off at roughly 30s, 2m, 10m, 1h, 6h (6 attempts
  total), then the delivery is dead-lettered and visible in the deliveries list.
- An endpoint that keeps failing is auto-disabled and says so; re-enable it with
  `PATCH`.

### The payload and the cursor

The delivery body is the event itself:
`{ id, seq, type, occurredAt, orgId, useCaseKey, subjectId, data }`.

`GET /events?after=<seq>` returns `{ events, nextAfter }` — pass `nextAfter` back
as `after` to advance. It is the recovery path for anything you missed while
offline, and it is org-grained: you see your organization's events, including
those of use cases you cannot otherwise read. `seq` is a global counter, so the
gaps between your own rows are not an error — they are other tenants' events,
which you never see.

v1 event types: `credential.issued`, `credential.accepted`, `credential.rejected`,
`credential.revoked`, `verification.requested`, `verification.completed`,
`asset.issued`, `asset.transferred`, `asset.redeemed`, `proposal.executed`.
Subscribe with `["*"]` or an explicit list; an unknown type is rejected at
registration with `400 UNKNOWN_EVENT_TYPE`, so a typo fails immediately rather
than silently never firing. Organization, membership and API-key governance
events are deliberately **not** in v1.

---

## 2026-08-09 — Org-scoped API keys (EN-B)

Merge `7aef94c`. Machine access, without a human password.

Before this release the only way in was `POST /auth/login` with a person's
credentials. Now an OrgAdmin can mint a key:

```
Authorization: Bearer tl_live_…
```

The value is an **opaque secret**. It is not a JWT: nothing in it is decodable,
there is no readable expiry, and it is shown exactly once at creation or
rotation — we store only a hash. If you lose it, rotate.

**Managing keys is a human act.** `POST /orgs/:id/api-keys`, its `…/rotate` and
`DELETE /orgs/:id/api-keys/:keyId` accept a **session only**; calling them with a
key returns `403 MACHINE_PRINCIPAL`. A key can never mint another key, which is
the one path that could widen access. Relatedly, the service user a key is bound
to cannot log in: `POST /auth/login` refuses it with `403 SERVICE_ACCOUNT`.

### ACTION REQUIRED — scopes gate READS, not just writes

This is the one that will surprise you. A key carries coarse scopes, and **reads
require a read scope**:

```
credentials:read   credentials:issue    credentials:revoke
verifications:read verifications:request verifications:verify
assets:read        assets:issue         assets:transfer
users:read         users:onboard
org:read
webhooks:read      webhooks:write        (added by EN-C)
usecases:provision
```

A key minted with `assets:issue` alone **cannot** call `GET /assets`,
`GET /assets/:id` or `GET /analytics`; it gets `403 INSUFFICIENT_SCOPE` with
`details: { required, granted }`. The same applies to `credentials:read`,
`users:read`, `org:read` and `verifications:read`. If you mint keys
least-privilege — and you should — enumerate the *reads* your integration makes,
not only its writes. `*` grants everything the bound service user is allowed.

*What was verified:* read-gating landed in commit `424f875` **on the EN-B branch
before it was merged** (merge `7aef94c`), so no released version of the API ever
served ungated reads to a key. Nothing broke retroactively. It is flagged here
because "scopes gate mutations" is the reasonable assumption, and acting on it
produces a key that 403s on its first `GET`. The published document now names the
required scope in each route's description, and `openapi.snapshot.json` records
it per route.

### Scopes can only narrow

Authorization is `role AND organization capability envelope AND key scope`. A
scope never grants anything the bound service user could not already do, so a
`credentials:issue` key attached to a user who may not issue still cannot issue.
Every check that applies to that person applies to the key: their role, their
organization's envelope (see EN-A), and maker-checker on anything that mutates.

Practical consequence: if a key returns `403` and the scope is right, look at the
service user's role and the organization's capabilities next.

### Other things to expect

- **Maker-checker still applies.** Most mutations answer **`202` with a
  proposal**, not with the object you asked to create. Read `proposal.id` and
  follow it to a terminal state. A checker can reject it, in which case the
  object never exists. Treating a 202 as a completed create is the most common
  mistake made against this API.
- **Rate limiting.** Per key, default 600 requests/minute, `429 RATE_LIMITED`
  with `Retry-After`. Honest limitation: the counter is per API instance, not
  cluster-wide.
- **Revocation is immediate**, and rotation kills the old secret at once.

---

## 2026-08-08 — Organization capability envelope (EN-A)

Merge `ddcced3`. Each organization now has an explicit, auditable grant of what
it may do: which **domains** it operates (`tokenization`, `identity`) and which
**operating roles** it plays (`Issuer`, `Holder`, `Verifier`).

An act outside that envelope is refused with **`403 ORG_CAPABILITY_MISSING`**,
and the message names the missing capability. It applies regardless of how
privileged the caller is — a PlatformAdmin acting for an org without the `Issuer`
role still cannot issue on its behalf. It is enforced at the existing gates
rather than by new middleware, so it applies uniformly to sessions and (since
EN-B) to API keys.

**Existing integrations were not affected.** An organization with no envelope has
`capabilities: null`, which means *unrestricted* — the two predicates that decide
every check return `true` for `null`
(`packages/core/src/org-capabilities.ts`). No data migration ran and no
organization was tightened by the release itself. An envelope arrives only when a
PlatformAdmin sets one, or when a new organization requests one at signup.

The one distinction worth knowing: **`[]` is not `null`.** An explicit empty
array is fully restrictive, not "unset". An org set to `roles: []` can do nothing
that needs an operating role.

Surface changes:

- `POST /orgs/register` accepts an optional `capabilities: { domains, roles }`.
  Absent means `null`, so older clients keep working unchanged. Unknown or
  duplicated entries are rejected with `INVALID_CAPABILITIES`.
- `PATCH /orgs/:id/capabilities` — PlatformAdmin only; sets or replaces the
  envelope directly, audited as `org-capabilities-set`.
- `POST /orgs/:id/capabilities/request` — an OrgAdmin asks for a different
  envelope; this creates a proposal (`202`) that a PlatformAdmin approves. The
  requester cannot approve their own.
- Organization responses now carry `capabilities`, and the login/session response
  carries `orgCapabilities`, so a client can hide what the org may not do rather
  than discovering it as a 403.

If you receive `403 ORG_CAPABILITY_MISSING`, no retry and no scope change will
help: the organization needs the capability granted.
