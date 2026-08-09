# Webhooks & Events (EN-C) — Design

**Goal:** Stop integrators polling. The platform records what happened in a durable, globally ordered **event log**, and pushes those events to org-configured HTTPS endpoints as **HMAC-signed deliveries** with bounded retries — with a cursor API so an integrator that was offline can pull exactly what it missed. Third sub-project of the Enterprise program (EN-A..F).

**Program context:** EN-A gave every Organization a governed capability envelope enforced at nine gates. EN-B added the machine principal (org-scoped API keys) that those gates already judge, so an external application can *call in*. EN-C is the other direction: the platform *calls out*. Together they close the integration loop.

**Tech stack:** apps/api (three new models, an emit helper, the first background worker in this codebase, webhook management + event routes), packages/core (the closed event catalog, shared by API and web; two new API scopes), apps/web (a Webhooks section on the existing Developers surface). No new runtime dependency — `node:crypto` for HMAC, `fetch` for delivery, and the existing AES-256-GCM keystore for secret storage.

---

## Why a separate outbox, not the audit log

The audit log answers "was this history rewritten?" — it is **per-asset hash-chained** (`AuditLog.@@unique([assetId, seq])`, `prevHash`, `hash`) and anchored on-ledger by HA-B. The event log answers "what happened, in order, since cursor N?".

Deriving deliveries from the audit log fails on both counts: `seq` is per-asset, so there is no global cursor; and `assetId` is nullable, so every credential, verification, org and governance row has **no chain position at all**. It would also give delivery concerns a say in a tamper-evident structure built for a different job.

So EN-C adds an `Event` table with a global monotonic sequence. The audit log is untouched.

**Rejected alternative — write the outbox from inside the audit sink** (one emit point, guaranteed no drift): it makes `RepositoryAuditSink` do two jobs and couples every audit write to event concerns. The drift risk is instead handled by a coverage test (below), the same way EN-B's `scope-coverage.test.ts` handles route drift.

## The three models

**`Event`** — an immutable fact. Full persistence parity (Prisma schema, record type, row type, mapper, create literals, both memory and prisma repos).

| field | notes |
|---|---|
| `seq` | `Int @id @default(autoincrement())` — the **cursor**. See the SQLite note below. |
| `id` | `String @unique @default(cuid())` — the public, stable event id sent to integrators |
| `type` | one of the closed catalog (below) |
| `orgId` | **the single owning org** — the tenancy key. Nullable only for platform-scope events. |
| `useCaseKey` | nullable; lets an endpoint narrow to one programme |
| `subjectId` | nullable; the credential/asset/verification id the event is about |
| `data` | JSON payload, redacted (below) |
| `occurredAt` | when the act happened |

**SQLite/Prisma constraint:** `@default(autoincrement())` is only valid on an `@id Int` field, which is why `seq` is the primary key and the public `id` is a separate unique cuid. The memory repo emulates the counter.

**`WebhookEndpoint`** — an org's declared interest.

| field | notes |
|---|---|
| `id`, `orgId`, `url`, `description` | `orgId` null = platform-scope, PlatformAdmin only |
| `eventTypes` | JSON string[]; `["*"]` allowed |
| `useCaseKey` | nullable filter |
| `secretEncrypted` | AES-256-GCM under `DID_MASTER_KEY` — **not** a hash. See below. |
| `status` | `active` \| `disabled` (auto or manual), with `disabledReason`, `disabledAt` |
| `consecutiveFailures` | drives auto-disable |
| `createdBy`, `createdAt`, `lastDeliveryAt` | audit |

**`WebhookDelivery`** — one attempt chain for one (event, endpoint) pair.

| field | notes |
|---|---|
| `id`, `endpointId`, `eventId` | `@@unique([endpointId, eventId])` — the fan-out idempotency key |
| `status` | `pending` \| `inflight` \| `delivered` \| `failed` \| `dead` |
| `attempts`, `nextAttemptAt`, `lastAttemptAt` | retry state |
| `responseStatus`, `responseError`, `durationMs` | last outcome, for the UI |
| `claimedAt`, `claimedBy` | CAS claim, so two API instances cannot double-send |

## The secret cannot be hashed

EN-B bcrypt-hashes API keys because the platform only ever needs to **verify** a secret someone presents. HMAC signing is the opposite: the dispatcher must **reproduce** the secret to sign every delivery. A bcrypt hash makes signing impossible; plaintext at rest means one database read hands over every integrator's signing key.

So the secret is stored **encrypted with AES-256-GCM under `DID_MASTER_KEY`**, reusing the envelope the keystore already applies to custodial DID seeds. It is generated server-side, returned **once** on create and on rotate, and never retrievable again — the same one-time ceremony EN-B's Developers surface already implements. `GET` routes never return it or the ciphertext.

If `DID_MASTER_KEY` is absent the API already refuses to boot for custodial seeds; webhook secrets inherit that.

## SSRF is the primary attack surface

For the first time, an org-supplied string tells the server where to send an HTTP request **from inside the network**. Without a guard an OrgAdmin points an endpoint at `http://169.254.169.254/` (cloud metadata) or `http://localhost:8545` (the operator's own Besu node) and turns the API into a proxy.

`apps/api/src/webhooks/url-guard.ts`, applied **at registration and again immediately before every delivery attempt**:

- **HTTPS only.** `http://` is accepted only for loopback hosts and only when `WEBHOOKS_ALLOW_INSECURE=1` (dev/test).
- **Resolve, then check every resolved address.** Reject loopback (`127/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), broadcast/multicast/unspecified. Literal-IP hosts are checked directly.
- **Re-resolve at delivery time.** Checking only at registration is defeated by DNS rebinding — a name that resolved publicly at registration can resolve to `127.0.0.1` an hour later.
- **No redirects followed** (`redirect: "manual"`); a 3xx is a delivery failure, not a hop.
- **10s timeout** per attempt via `AbortSignal.timeout`; response body read is capped at 8 KB and discarded (only the status is recorded).
- No credentials in the URL (`user:pass@`), no non-standard ports below 1024 other than 443.

This guard is pure and unit-testable independently of any HTTP.

## The signature

```
Tokenlayer-Event-Id:    evt_...            (idempotency key — integrators MUST dedupe on this)
Tokenlayer-Delivery-Id: whd_...            (this attempt chain)
Tokenlayer-Event-Type:  credential.issued
Tokenlayer-Signature:   t=1754697600,v1=<hex hmac-sha256(`${t}.${rawBody}`, secret)>
```

The timestamp is **inside the signed material**, so a captured delivery cannot be replayed later against a verifier that checks freshness. The documented verification recipe (in the Developers surface and the delivery detail view): recompute over the raw body — not a re-serialized object — reject if `|now - t| > 300s`, and compare with a constant-time equality.

`v1=` is a version prefix so the scheme can change without breaking verifiers.

## Delivery semantics — stated honestly

- **At-least-once.** Retries and the `@@unique([endpointId, eventId])` fan-out key mean an endpoint can legitimately see the same event twice. Integrators dedupe on `Tokenlayer-Event-Id`.
- **Ordering is best-effort per endpoint and NOT guaranteed.** Retries reorder by construction: event 5 failing while 6 succeeds delivers 6 first. The spec says so rather than implying a guarantee the retry policy contradicts. Integrators who need order use `seq` from the payload, or the cursor API.
- **Retry schedule:** attempt at 0s, then +30s, +2m, +10m, +1h, +6h — six attempts over ~8h, each with ±20% jitter so a recovering endpoint is not thundered. Then `dead`.
- **Auto-disable:** 20 consecutive failed delivery *attempts* **whose run is also at least an hour old** disables the endpoint with a reason, and it must be re-enabled explicitly. Without this, one abandoned integration retries forever. This clause originally said "deliveries (not attempts)", and the reason was the burst: attempts alone are exhaustible by one pass over a backlog, so a 30-second outage during a rolling deploy could have disabled a healthy endpoint. That is now answered directly by `AUTO_DISABLE_MIN_AGE_MS`, which the first version of the dispatcher did not have — the count **and** the clock must agree, and no backlog substitutes for elapsed time. Counting attempts under a time floor is also the sharper signal: counting whole dead-lettered deliveries would take ~8h per delivery, so a low-volume abandoned endpoint would run for weeks before the valve tripped. Only failures **attributable to the endpoint** count: a URL-guard/DNS refusal and an unopenable signing secret are tracked separately and disable nothing.
- **2xx is success.** Anything else, including 3xx, is a failure.

## The dispatcher — the first background worker here

`apps/api/src/webhooks/dispatcher.ts`: a `setInterval` loop (default 2s, `WEBHOOKS_POLL_MS`) that selects due deliveries (`status in (pending, failed)` and `nextAttemptAt <= now`), **claims each with a compare-and-set** to `inflight` — mirroring the `claimDecided` CAS already used for proposals — then attempts, records, and reschedules.

Started from `server.ts`, not `app.ts`, so the test harness never starts a live worker; tests drive `dispatchDue()` directly, which is the whole worker minus the timer. Stopped on `SIGTERM`/`SIGINT`: the handler cancels the ticker and then **awaits the pass that is already running**, within a bounded grace, so an orderly shutdown does not strand the rows that pass has claimed. That is a best effort, not a guarantee — a `SIGKILL`, a crash, or a pass still running when the grace expires all leave rows `inflight`. The actual guarantee is the sweep at the top of every pass, which reclaims anything `inflight` longer than the stale threshold.

**Two limitations, written down rather than papered over:**
1. It is in-process, so events accumulate but are not delivered while the API is down. The cursor API is the recovery path.
2. The CAS claim makes multiple instances **safe** (no double-send) but not **coordinated** (no fair distribution). `WEBHOOKS_ENABLED=0` lets an operator run replicas with exactly one dispatcher.

## Event catalog (closed, in core)

`packages/core/src/events.ts` — a closed `EVENT_TYPES` list with a derived `EventType` union, so an unknown type cannot compile, and both API and web share it (the same shape as `API_SCOPES`).

**Identity:** `credential.issued`, `credential.accepted`, `credential.rejected`, `credential.revoked`, `verification.requested`, `verification.completed`
**Tokenization:** `asset.issued`, `asset.transferred`, `asset.redeemed`
**Governance:** `proposal.executed`

Ten types. `organization.*`, `member.*`, `apikey.*` and capability changes are **deliberately excluded from v1** — they are governance facts about the org rather than integration events, and each needs its own tenancy argument. Adding one later is a catalog entry plus an emit site.

## Payload redaction

Reuses EN-B's rule, which was learned the hard way: `passwordHash` never leaves the server, and neither does credential material (JWT proofs, custodial seeds, secrets). An event payload carries **identifiers and status**, plus the claim keys already visible to the owning org — not the signed credential. When an integrator needs the credential it fetches it with its EN-B key, which re-runs every authorization gate.

A test asserts no serialized event ever contains `passwordHash`, `secretHash`, `didSeedEncrypted`, or a `tl_live_` string.

## Tenancy, and how it meets EN-A/EN-B

- **One owning org per event.** Delivery selects an endpoint when **either** `endpoint.orgId === event.orgId` **or** `endpoint.orgId === null` (a platform-scope endpoint), and the endpoint's optional `useCaseKey` filter matches. The two arms are deliberately different rules, not one comparison: a null-vs-null equality would make every org-scoped endpoint match every platform-scope event, which is exactly the `null === null` class of bug the EN-B final review found in the user-management predicate. The selection is written as an explicit disjunction with a test for the null/null case.

  A platform-scope endpoint is created only by a PlatformAdmin and receives every event in the system — it is explicit, never a fallback for an org whose `orgId` failed to resolve.
- **EN-A envelope gates *subscribing*, not *receiving*.** An identity-only org cannot subscribe to `asset.*` (403 `ORG_CAPABILITY_MISSING`, the existing error). But an org that already performed an act keeps receiving events about it after its envelope tightens — the envelope governs what an org may *do*, and EN-A is explicitly non-retroactive.
- **EN-B scopes:** two additions to the closed list — `webhooks:read` and `webhooks:write` — so an integration can manage its own endpoints. Every new route is `authScoped(...)` or justified in `DELIBERATELY_UNSCOPED`; `scope-coverage.test.ts` (now covering all routes, reads included) enforces this.
- **`GET /events` is scoped to the caller's org** exactly like the endpoint list, and requires `webhooks:read`.

## Routes

All org-scoped routes under the existing `orgScoped` guard (OrgAdmin for their own org, PlatformAdmin anywhere):

- `POST /orgs/:id/webhooks` — `{url, eventTypes, useCaseKey?, description?}` → **201 with the secret, the only time it exists**. URL guard + envelope check + catalog validation. Audited (id only, never the secret).
- `GET /orgs/:id/webhooks` — list; never the secret or ciphertext.
- `PATCH /orgs/:id/webhooks/:whId` — url / eventTypes / re-enable. Re-runs the URL guard.
- `POST /orgs/:id/webhooks/:whId/rotate` — new secret, same endpoint identity. Audited.
- `DELETE /orgs/:id/webhooks/:whId` — soft delete (keeps the delivery history).
- `POST /orgs/:id/webhooks/:whId/test` — sends a synthetic `ping` event to prove the wiring end to end before real traffic.
- `GET /orgs/:id/webhooks/:whId/deliveries` — paged, with status/response/attempt counts.
- `POST /orgs/:id/webhooks/:whId/deliveries/:dId/replay` — resets one delivery to `pending`. Audited.
- `GET /events?after=<seq>&type=&limit=` — **the cursor API**. Org-scoped, `seq`-ordered, capped page size.

## Web — Webhooks on the Developers surface

EN-B already established Developers as the integration home, so this is a second section there rather than a new nav item (no new nav classification, so no repeat of the ID-N self-lockout).

Endpoint table (url, event types as pills, status, last delivery, consecutive failures); a create form with the event-type checkboxes **filtered by the org's EN-A envelope**, reusing the shared `lib/capabilities` module the role picker already uses; the one-time secret panel reusing EN-B's reveal-counter component and nav guard; a "Send test event" button; and a deliveries drawer showing status, response code, attempt count, next attempt, and a Replay button, plus the signature-verification recipe with a copyable snippet.

An auto-disabled endpoint says **why** and offers Re-enable — the EN-B lesson that an affordance must not be offered where the server will refuse it, and that a status must explain itself.

## Error handling

- Unknown event type on subscribe → 400 `UNKNOWN_EVENT_TYPE` with the valid list.
- URL fails the guard → 400 `INVALID_WEBHOOK_URL` with the specific reason (scheme / private address / redirect), never a raw resolver error.
- Subscribing outside the envelope → 403 `ORG_CAPABILITY_MISSING` (unchanged shape).
- Missing scope on a key → 403 `INSUFFICIENT_SCOPE` (unchanged).
- Replay of a delivery not owned by the caller's org → 404, not 403 (no existence oracle, matching `scopedProposal`).
- Delivery failures are **never** surfaced as API errors — they are delivery state.

## Testing

- **core:** the catalog is closed and total; `webhooks:read`/`webhooks:write` behave under `scopeAllows`, including the `webhooks:*` wildcard.
- **url-guard (pure):** a table of hostile URLs — metadata IP, loopback by name and by literal, private ranges, IPv6 loopback, CGNAT, credentials-in-URL, `http://` to a public host — each rejected with its reason; public HTTPS accepted; **and a rebinding case where registration resolves public but delivery resolves private**, proving the second check exists.
- **signing (pure):** known-vector HMAC; a body byte-flip changes the signature; a timestamp change changes it; verification with the documented recipe succeeds.
- **dispatcher:** drives `dispatchDue()` against a stub HTTP client — success marks delivered; 500 schedules a retry with growing backoff; six failures reach `dead`; 20 consecutive failed attempts auto-disable **once the run is older than the floor**, and a burst of 20 inside the floor does not; a guard/DNS refusal and an unopenable signing secret each fail the attempt while disabling nothing; a claimed row is invisible to a second concurrent dispatcher (the CAS proven by two interleaved calls); a stale `inflight` row is reclaimed.
- **emit coverage:** a test asserting every `EVENT_TYPES` entry has at least one emit site in `apps/api/src` — the anti-drift guard that justifies not writing events from the audit sink.
- **tenancy:** an event for org A is never delivered to an endpoint of org B; a `useCaseKey`-filtered endpoint receives only that programme; a platform endpoint receives both; `GET /events` refuses a foreign org.
- **redaction:** no serialized event contains `passwordHash`, `secretHash`, `didSeedEncrypted` or `tl_live_`.
- **web:** tsc + build + component tests for the envelope-filtered checkboxes and the reveal counter.
- **live walkthrough:** a real HTTPS-less local receiver started on a loopback port with `WEBHOOKS_ALLOW_INSECURE=1`, registered as an endpoint; issue a credential on real Besu; assert the receiver got `credential.issued` with a signature that **independently verifies** against the secret shown once; kill the receiver, issue again, watch the retry schedule and the dead-letter; replay it and see it land; then prove the cursor API returns exactly the events the receiver missed.

## Verification / done

Full core + api + web suites green, web tsc/build, the live Besu walkthrough above with an independently verified HMAC, a browser pass on the Webhooks section, then the final whole-branch review — which, per EN-A and EN-B, hunts independently rather than re-checking this document's own list. Then finish the branch (`feat/webhooks` → main).

## Alternatives considered

- **Deriving events from the audit log** — no global cursor (per-asset `seq`, null for non-asset rows) and couples delivery to a tamper-evident structure. Covered above.
- **Synchronous delivery on the request path** — a hanging integrator endpoint becomes the platform's latency, and a failed delivery is simply lost.
- **External queue (Redis/BullMQ)** — scales and survives restarts, but adds an infrastructure dependency and a second deployable to a repo that has neither. The outbox shape means this can be swapped in later without touching emit sites.
- **Per-event secrets or asymmetric signing** — HMAC with a per-endpoint shared secret is what integrators already know from Stripe/GitHub; asymmetric signing would spare the platform from holding a reversible secret, but requires integrators to fetch and pin a public key, which is a materially higher integration cost for this audience.
- **Long-polling instead of webhooks** — still polling, just cheaper; the cursor API covers the recovery case without making it the primary mode.
