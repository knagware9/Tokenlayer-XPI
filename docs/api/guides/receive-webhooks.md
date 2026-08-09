# Receive webhooks

> **Draft.** These steps have not yet been executed end to end against a live
> deployment. They are written from the route handlers, the dispatcher and their
> tests; task D1-7 runs them verbatim and corrects whatever diverges.

Register an endpoint, verify signatures correctly, survive duplicate and
out-of-order deliveries, and recover a window you missed. Base URL throughout:
`https://<host>/api/v1`.

---

## Prerequisites

**Scopes.** Split deliberately: an integration that only *consumes* the event
log has no business rotating a signing secret or repointing a delivery URL.

| step | scope |
|---|---|
| register / update / rotate / delete / test / replay (1–2, 8–10) | `webhooks:write` |
| list endpoints, read deliveries, read the event cursor (7, 9) | `webhooks:read` |

Unlike API-key management, these routes **do** accept a machine principal: a
webhook endpoint confers no authority, it only ever receives events the org can
already read through `GET /events`. Managing your own delivery destinations with
your own key is the point.

**Organization capability envelope.** Subscribing is gated by domain:

| event types | required domain |
|---|---|
| `asset.*` | `tokenization` |
| `credential.*`, `verification.*` | `identity` |
| `proposal.executed`, `*` | none (domain-neutral) |

`403 ORG_CAPABILITY_MISSING` names the missing domain in `details.missing`.

Note the asymmetry: the envelope gates **subscribing**, not **receiving**. An
org that subscribed while entitled keeps receiving after its envelope narrows —
a capability change does not un-issue what already exists, and silently blinding
a running integration would be a worse failure than an explicit refusal at
subscribe time.

**Your endpoint URL** must be publicly routable. It is checked with an SSRF
guard at registration **and again on every URL change** — registering a public
URL and then `PATCH`ing it to `169.254.169.254` does not work
(`400 INVALID_WEBHOOK_URL`, with our own reason string, never a raw resolver
error).

**Credentials in transit.** `Authorization: Bearer …` only. Never a query
string.

---

## 1. Register an endpoint

```bash
curl -sS -i -X POST https://<host>/api/v1/orgs/$ORG_ID/webhooks \
  -H "authorization: Bearer $TL_KEY" -H 'content-type: application/json' \
  -d '{ "url": "https://hooks.example.test/tokenlayer",
        "description": "ERP sync",
        "eventTypes": ["asset.issued", "asset.transferred", "credential.issued"] }'
```

```
201 Created
{
  "endpoint": {
    "id": "whe_…", "orgId": "org_…",
    "url": "https://hooks.example.test/tokenlayer",
    "description": "ERP sync",
    "eventTypes": ["asset.issued","asset.transferred","credential.issued"],
    "useCaseKey": null, "status": "active",
    "disabledReason": null, "disabledAt": null,
    "consecutiveFailures": 0, "consecutiveGuardFailures": 0, "failingSince": null,
    "deletedAt": null, "createdBy": "usr_…", "createdAt": "2026-08-09T…",
    "lastDeliveryAt": null
  },
  "secret": "whsec_…"
}
```

**`secret` appears in this response and nowhere else, ever.** It is encrypted at
rest and no read route can produce it. Store it before you acknowledge the call
— losing it means rotating, and rotation has no overlap window.

```bash
umask 077; printf '%s' '<paste the secret>' > /etc/tokenlayer/webhook.secret
```

The event catalog is closed. The v1 types are `credential.issued`,
`credential.accepted`, `credential.rejected`, `credential.revoked`,
`verification.requested`, `verification.completed`, `asset.issued`,
`asset.transferred`, `asset.redeemed`, `proposal.executed`. Anything else is
`400 UNKNOWN_EVENT_TYPE`. `["*"]` subscribes to everything your org is entitled
to; there are no partial wildcards, no duplicates, and an empty array is a
`400`.

`useCaseKey` narrows delivery to one use case. Omit it (or send `null`) for the
whole org's stream. Sending `""` is not a filter — it is an empty string; the
server normalizes it to `null`, but do not rely on that, send `null`.

## 2. Test it before a real event arrives

```bash
curl -sS -i -X POST https://<host>/api/v1/orgs/$ORG_ID/webhooks/$WH_ID/test \
  -H "authorization: Bearer $TL_KEY" -H 'content-type: application/json' -d '{}'
```

```
202 Accepted
{ "delivery": { "id": "whd_…", "endpointId": "whe_…", "eventId": "evt_…",
                "eventSeq": 8814, "status": "pending", "attempts": 0,
                "nextAttemptAt": "2026-08-09T…", "createdAt": "2026-08-09T…" },
  "event": { "id": "evt_…", "seq": 8814, "type": "ping", "occurredAt": "2026-08-09T…" } }
```

*What just happened.* **`202` means queued, not delivered** — the dispatcher
sends on its own poll. The delivery is addressed to *this endpoint only* and
bypasses subscription matching, so testing an endpoint subscribed to
`["asset.issued"]` works instead of silently doing nothing, and testing one
endpoint does not spray a ping at every wildcard endpoint in your org.

`ping` is **not** in the event catalog and cannot be subscribed to — it is a
fact about an API call, not about your business. It is still a real, org-scoped
row in the log, so it shows up in your own `GET /events`.

`409 ENDPOINT_DISABLED` means re-enable it first (step 9); a disabled endpoint's
delivery is dead on arrival, and reporting success for it would be a lie.

## 3. What a delivery looks like

```http
POST /tokenlayer HTTP/1.1
Host: hooks.example.test
Content-Type: application/json
Tokenlayer-Event-Id: evt_01J…
Tokenlayer-Delivery-Id: whd_01J…
Tokenlayer-Event-Type: asset.issued
Tokenlayer-Signature: t=1786000000,v1=9f2c…

{"id":"evt_01J…","seq":8815,"type":"asset.issued","occurredAt":"2026-08-09T10:14:02.113Z","orgId":"org_…","useCaseKey":"globex-bond","subjectId":"ast_…","data":{…}}
```

- `seq` — a **global** monotonic counter and your cursor. Gaps in *your* stream
  are other tenants' events, not lost ones.
- `subjectId` — the id of the thing the event is about (asset, credential,
  verification request).
- `data` — per-type payload. Treat unknown keys as forward-compatible additions;
  do not reject on them.

**Redirects are not followed.** A `3xx` from your endpoint counts as a failed
attempt, never a hop. Only `2xx` counts as delivered — `< 400` would treat a
`302` to a redirector as success.

## 4. Verify the signature — over the raw bytes

`Tokenlayer-Signature` is `t=<unix-seconds>,v1=<hex>` where the hex is
**HMAC-SHA256 of `` `${t}.${rawBody}` `` under your endpoint secret**.

**The mistake almost everyone makes first is verifying a re-serialized object.**
Your framework parses the JSON, you `JSON.stringify` it back, you HMAC that, and
it does not match — because key order, whitespace and number formatting are not
guaranteed to round-trip. **You must HMAC the exact bytes that arrived**, which
means capturing the raw body *before* any JSON body parser touches it.

The timestamp is inside the signed material on purpose: signing the body alone
would let anyone who captured one delivery re-stamp `t=` and replay it forever,
because the freshness check would itself be unauthenticated.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 300; // clock-skew budget, not a security dial

export function verify(secret, header, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  // Parse parameters BY NAME, not by position: v1= is a version prefix and the
  // scheme may gain parameters. Ignore any you do not recognise.
  const parts = new Map();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const rawT = parts.get("t");
  const v1 = parts.get("v1");
  if (!rawT || !v1) return false;            // Number("") is 0, not NaN — check emptiness first
  const t = Number(rawT);
  if (!Number.isFinite(t)) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const got = Buffer.from(v1, "hex");
  // Length check FIRST: timingSafeEqual throws on a length mismatch, and this
  // header is attacker-controlled — that would turn a false into a 500.
  return expected.length === got.length && timingSafeEqual(expected, got);
}
```

Wiring the raw body in Express and Fastify:

```js
// Express — raw buffer for this route only, before express.json()
app.post("/tokenlayer", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");            // the exact bytes
  if (!verify(SECRET, req.get("Tokenlayer-Signature") ?? "", raw)) return res.sendStatus(401);
  const event = JSON.parse(raw);                    // parse only AFTER verifying
  …
});
```

```js
// Fastify — keep the raw payload alongside the parsed one
fastify.addContentTypeParser("application/json", { parseAs: "string" },
  (req, body, done) => { req.rawBody = body; done(null, JSON.parse(body)); });
```

The 300-second tolerance does **not** stop a replay inside the window — that is
inherent to a stateless MAC. Which is what step 5 is for.

## 5. Handle at-least-once and out-of-order

Delivery is **at least once**. Retries, replays and the recovery path in step 7
all mean you will see the same event more than once. It is also **not ordered**:
retries with jitter, parallel dispatch and backfill mean event `8820` can arrive
before `8815`.

Two rules, and they are not optional:

1. **Dedupe on `Tokenlayer-Event-Id`.** It is stable across every retry and
   replay of the same event. Record it in a uniquely-indexed table inside the
   same transaction as your side effect, and treat a duplicate-key violation as
   "already processed, return 200". Do **not** dedupe on
   `Tokenlayer-Delivery-Id` — that changes per delivery row and would let a
   replay through.
2. **Order by `seq`, never by arrival.** For state that must be monotonic
   (latest status, current holder), store the `seq` you last applied for that
   subject and ignore anything with a lower one.

```js
async function handle(event) {
  const claimed = await db.tryInsert("processed_events", { event_id: event.id });
  if (!claimed) return;                            // duplicate — already done
  const last = await db.lastSeqFor(event.subjectId);
  if (last !== null && event.seq <= last) return;  // stale — a newer fact already applied
  await applyAndRecordSeq(event);
}
```

**Answer `2xx` quickly and do the work asynchronously.** A slow handler burns
the delivery timeout and turns into a retry.

## 6. Retries

Six attempts with delays of 30s, 2m, 10m, 1h and 6h before attempts 2–6 — about
eight hours end to end — each with ±20% jitter so a backlog that failed together
does not retry together and knock your server over again on recovery.

After the sixth failed attempt the delivery is `dead` and will not be attempted
again unless you replay it (step 10) or recover it through the cursor (step 7).

## 7. Recover a window you missed

The durable event log is the reason an integration can stay correct without
receiving every webhook. `after` is **exclusive** (`seq > after`).

```bash
curl -sS "https://<host>/api/v1/events?after=8814&limit=100" \
  -H "authorization: Bearer $TL_KEY"
```

```
200 OK
{ "events": [
    { "seq": 8815, "id": "evt_…", "type": "asset.issued", "orgId": "org_…",
      "useCaseKey": "globex-bond", "subjectId": "ast_…", "data": { … },
      "occurredAt": "2026-08-09T…" },
    …
  ],
  "nextAfter": 8912 }
```

The loop is `after = nextAfter`, and it never re-reads and never skips. **An
empty page returns your own cursor back unchanged**, so polling a quiet log is
idempotent:

```bash
AFTER=$(cat ./cursor 2>/dev/null || echo 0)
while :; do
  PAGE=$(curl -sS "https://<host>/api/v1/events?after=$AFTER&limit=500" \
          -H "authorization: Bearer $TL_KEY")
  echo "$PAGE" | jq -c '.events[]' | while read -r e; do process "$e"; done
  AFTER=$(echo "$PAGE" | jq -r .nextAfter)
  printf '%s' "$AFTER" > ./cursor
  [ "$(echo "$PAGE" | jq '.events | length')" -eq 0 ] && sleep 30
done
```

`limit` defaults to 100 and caps at 500. `type` filters to one event type.

**Feed recovered events through the same deduped handler as webhook deliveries.**
That is the whole point: the cursor and the webhook carry the same object with
the same `id`, so a correct handler cannot tell them apart and does not need to.

Two properties of the log worth knowing before you trust it:

- **It is org-grained, not use-case-grained.** A use-case-scoped member of your
  org reads *all* of your org's events, including use cases they cannot
  otherwise see. Webhook *endpoints* can narrow by `useCaseKey`; the cursor
  cannot.
- **A principal with no org reads nothing** — an empty page and its own cursor
  back, forever. If your loop never advances, check that the key's bound service
  user actually belongs to an org.

## 8. Rotate the signing secret

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/webhooks/$WH_ID/rotate \
  -H "authorization: Bearer $TL_KEY" -H 'content-type: application/json' -d '{}'
```

```
200 OK
{ "endpoint": { "id": "whe_…", … }, "secret": "whsec_…" }
```

**There is no overlap window, deliberately.** The moment this returns,
deliveries are signed with the new secret and the old one verifies nothing. A
grace period would mean a leaked secret stays valid for exactly as long as the
window, which is the opposite of what rotation is for. Deploy the new secret
promptly; if you cannot deploy atomically, accept either secret in your verifier
for the duration of your own rollout — but rotate *after* the code that accepts
both is live, not before.

## 9. Auto-disabled endpoints — and which counter moved

An endpoint is auto-disabled only when **both** conditions hold:

- `consecutiveFailures >= 20`, **and**
- the current failure run has persisted for at least **60 minutes**
  (`failingSince`).

The time floor exists because a count alone is exhausted by a burst: a backlog
of 20 queued events dispatched in one pass would otherwise permanently disable
an endpoint whose server was down for the thirty seconds of a rolling deploy.
The count and the clock must both agree.

**Two counters, and only one of them can disable you:**

| field | counts | can auto-disable? |
|---|---|---|
| `consecutiveFailures` | **your server** answered non-2xx, or was unreachable (DNS, TLS, timeout, reset, a `3xx`) | **yes** |
| `consecutiveGuardFailures` | **our own URL guard refused to send** — your hostname did not resolve, or resolved somewhere not publicly routable | **never** |

If `consecutiveGuardFailures` is climbing and `consecutiveFailures` is not, the
problem is your DNS or where your name points, and **not one packet reached your
server** — do not go auditing your handler's logs for requests that were never
made. A guard refusal still burns a delivery attempt, so those deliveries do
eventually `dead`-letter; they simply never switch the endpoint off.

A third category is ours: if the platform cannot decrypt your signing secret,
that is a platform configuration fault. It burns attempts and touches **neither**
counter, and `responseError` on the delivery says so explicitly.

Read the state:

```bash
curl -sS https://<host>/api/v1/orgs/$ORG_ID/webhooks -H "authorization: Bearer $TL_KEY" \
  | jq '.endpoints[] | { id, url, status, disabledReason, disabledAt,
                         consecutiveFailures, consecutiveGuardFailures, failingSince }'
```

```json
{ "id": "whe_…", "url": "https://hooks.example.test/tokenlayer",
  "status": "disabled",
  "disabledReason": "24 consecutive failed delivery attempts over 97 minutes",
  "disabledAt": "2026-08-09T…",
  "consecutiveFailures": 24, "consecutiveGuardFailures": 0,
  "failingSince": "2026-08-09T…" }
```

`disabledReason: "disabled by an administrator"` means a human switched it off.
`"deleted"` means it was soft-deleted — the row survives so its delivery history
has a destination to point at, but it receives nothing and cannot be re-enabled
into service.

**Fix your endpoint first, then re-enable:**

```bash
curl -sS -X PATCH https://<host>/api/v1/orgs/$ORG_ID/webhooks/$WH_ID \
  -H "authorization: Bearer $TL_KEY" -H 'content-type: application/json' \
  -d '{ "status": "active" }'
```

```
200 OK
{ "endpoint": { "id": "whe_…", "status": "active",
                "disabledReason": null, "disabledAt": null,
                "consecutiveFailures": 0, "consecutiveGuardFailures": 0,
                "failingSince": null, … } }
```

*What just happened.* Re-enabling **resets all five bookkeeping fields
together**, including `failingSince`. That matters: the values that caused the
disable still satisfy the disable condition, so flipping `status` alone would
re-disable the endpoint on its very next failed attempt — which looks exactly
like the re-enable silently doing nothing.

Events that fanned out while the endpoint was disabled were dead-lettered on
arrival and are **not** re-queued by re-enabling. Recover that window with
`GET /events?after=` (step 7).

`PATCH` also takes `url`, `description`, `eventTypes` and `useCaseKey`. Send
`null` to clear `description` or `useCaseKey`. Changing `eventTypes` re-runs the
capability check, and changing `url` re-runs the SSRF guard.

## 10. Inspect and replay individual deliveries

```bash
curl -sS "https://<host>/api/v1/orgs/$ORG_ID/webhooks/$WH_ID/deliveries?limit=100" \
  -H "authorization: Bearer $TL_KEY"
```

```
200 OK
{ "deliveries": [
    { "id": "whd_…", "endpointId": "whe_…", "eventId": "evt_…", "eventSeq": 8815,
      "status": "dead", "attempts": 6,
      "nextAttemptAt": "2026-08-09T…", "lastAttemptAt": "2026-08-09T…",
      "responseStatus": 502, "responseError": "endpoint returned 502",
      "durationMs": 411, "createdAt": "2026-08-09T…" }
  ] }
```

`responseStatus` is what **your** server answered. A delivery row carries no
event payload — read the body from `GET /events`, which applies its own org
scope.

```bash
curl -sS -X POST \
  https://<host>/api/v1/orgs/$ORG_ID/webhooks/$WH_ID/deliveries/$DELIVERY_ID/replay \
  -H "authorization: Bearer $TL_KEY" -H 'content-type: application/json' -d '{}'
```

```
200 OK
{ "delivery": { "id": "whd_…", "status": "pending", "attempts": 0, "nextAttemptAt": "2026-08-09T…", … } }
```

A replay resets `attempts` to zero, so it gets the full retry schedule rather
than dying on its next attempt. `409 DELIVERY_INFLIGHT` means a dispatcher is
mid-POST on that row right now — wait and retry rather than forcing it, or you
invite a double send.

A delivery id belonging to another org answers `404`, not `403`. So does an
endpoint id. That is deliberate: a `403` would be an existence oracle, letting
one org confirm which ids another org holds by reading status codes.

---

## Verify it independently

"My handler logged a 200" is not proof that you have every event.

**1. Reconcile your store against the platform's log.** Walk the cursor from
`0` (or from your integration's start) and compare the set of event ids the
platform has against the set you recorded:

```bash
curl -sS "https://<host>/api/v1/events?after=0&limit=500" -H "authorization: Bearer $TL_KEY" \
  | jq -r '.events[].id' | sort > platform-ids.txt
your-store-dump | sort > my-ids.txt
comm -23 platform-ids.txt my-ids.txt   # events the platform has and you missed
comm -13 platform-ids.txt my-ids.txt   # events you have and the platform does not — investigate
```

The first list should be empty. If it is not, your dedupe or your cursor is
wrong; recover with step 7 and fix it before you trust the integration. The
second list should also be empty — anything there means you invented an event id
or crossed tenants.

**2. Confirm the underlying fact, not the notification.** An event is a claim
that something happened; the thing itself is readable independently. For an
`asset.issued`, `GET /assets/{subjectId}` and check `totalSupply`, which is read
live from the ledger — then take its `txHash` from `GET /assets/{id}/audit` and
pull the receipt from the chain's own RPC. For a `credential.issued`, the
public, unauthenticated `GET /credentials/{subjectId}/status` should answer
`source: "chain"` and `anchored: true`.

**3. Prove your verifier actually rejects.** Take one delivery you received,
flip a single byte of the body, and re-run your verification with the original
signature. It must fail. Then re-`JSON.parse`/`JSON.stringify` the body and
verify *that* — if it passes, you are verifying a re-serialized object and got
lucky with key order, and you will find out in production instead.
