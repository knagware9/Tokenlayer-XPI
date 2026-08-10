/**
 * The first background worker in this codebase (EN-C). The shape here is the
 * precedent, so three things are deliberate.
 *
 * 1. `dispatchDue()` IS THE WHOLE WORKER MINUS THE TIMER. Tests drive it
 *    directly, which is why no test in this suite needs a fake clock, a live
 *    interval, or a sleep. `startDispatcher` is called from server.ts and
 *    nowhere else — never from `buildApp` — so the test harness cannot
 *    accidentally start a timer that outlives the test that created it.
 *
 * 2. EVERY DELIVERY IS CLAIMED WITH A COMPARE-AND-SET BEFORE ANY HTTP HAPPENS,
 *    mirroring ProposalRepository.claimDecided. `listDue` is a read, so two
 *    instances polling the same table WILL both see the same row; the claim is
 *    the only thing that stops both POSTing it. That makes a second API instance
 *    SAFE (it cannot double-send) but not COORDINATED (no fair distribution, and
 *    every instance still polls). An operator running replicas sets
 *    WEBHOOKS_ENABLED=0 on all but one.
 *
 * 3. THE URL GUARD RUNS AGAIN HERE, not just at registration. See url-guard.ts:
 *    a name that resolved publicly when the endpoint was saved can resolve to
 *    127.0.0.1 an hour later. Re-checking immediately before the send shrinks
 *    that window from hours to milliseconds. It does NOT close it — the HTTP
 *    client performs its own resolution afterwards, and closing the gap for real
 *    means pinning the validated address and connecting to that, which is a
 *    client-level change this task does not make.
 *
 * 4. AUTO-DISABLE IS A SAFETY VALVE, NOT A SILENCING PRIMITIVE. Switching an
 *    org's endpoint off is a denial of service we perform on ourselves, so it
 *    needs more than a number. Two properties keep it honest, and both were
 *    added after the first version of this file shipped without them:
 *      - A WALL-CLOCK FLOOR. A purely consecutive count is exhaustible by a
 *        burst — the default batch size and AUTO_DISABLE_AFTER are both 20, so
 *        one pass over a backlog could have disabled an endpoint whose server
 *        was down for the length of a rolling deploy. The failure run must ALSO
 *        have persisted for AUTO_DISABLE_MIN_AGE_MS.
 *      - ONLY FAILURES WE CAN ATTRIBUTE TO THE ENDPOINT COUNT. Guard/DNS
 *        refusals are tracked in their own counter and disable nothing, because
 *        their cause sits outside our trust boundary — an attacker who can
 *        degrade resolution for the endpoint's hostname would otherwise silence
 *        an integrator without sending the victim a single packet. The same rule
 *        caught a THIRD case later: a signing secret we cannot decrypt, which is
 *        a fault entirely on our side of the boundary (a WEBHOOK_MASTER_KEY
 *        rotation), and which used to be classified as the integrator's fault
 *        and disable every endpoint on the platform. See the send loop below.
 *
 *    NOTE that this counter counts ATTEMPTS, not whole dead-lettered deliveries
 *    — see AUTO_DISABLE_AFTER, where the choice and the design doc's earlier
 *    wording are reconciled.
 *
 * WHAT THIS DESIGN DOES NOT DO. The dispatcher is in-process: while the API is
 * down, events are still recorded by the emit path but nothing is delivered, and
 * the backlog only drains when a process comes back. There is no separate queue
 * and no delivery from a standby. The documented recovery path for an integrator
 * that missed deliveries is the cursor API (`GET /events?after=`), not this
 * worker.
 */
import { randomUUID } from "node:crypto";
import type { EventRepository, WebhookDeliveryRepository, WebhookEndpointRepository } from "../persistence/types.js";
import type { SecretBox } from "./secret-box.js";
import { signatureHeader } from "./signing.js";
import { checkUrl, type UrlGuardOptions } from "./url-guard.js";

/** Delays BEFORE attempts 2..6 — six attempts spanning ~8h. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/**
 * Consecutive failed ATTEMPTS — not whole dead-lettered deliveries — that are
 * attributable to the endpoint, and which must ALSO satisfy
 * AUTO_DISABLE_MIN_AGE_MS below.
 *
 * "Attempts" is the deliberate choice, and the design doc used to say the
 * opposite. The reason it said deliveries was the burst — a count alone is
 * exhausted by one pass over a backlog — and the time floor answers that
 * directly and better. Counting whole deliveries instead would mean ~8h of
 * retries per unit, so an abandoned low-volume endpoint would keep being
 * retried for weeks before the valve tripped.
 */
export const AUTO_DISABLE_AFTER = 20;
/**
 * How long a failure run must have PERSISTED before auto-disable may fire.
 *
 * Without this, auto-disable is a silencing primitive rather than a safety
 * valve. A purely consecutive counter with no time floor is exhausted by a
 * BURST: the default batch size is also 20, so one dispatch pass over a backlog
 * of 20 queued events could permanently disable an endpoint whose server was
 * down for the thirty seconds of a rolling deploy. Requiring the run to have
 * been failing for an hour means the count and the clock must BOTH agree, and no
 * amount of backlog can substitute for elapsed time.
 */
export const AUTO_DISABLE_MIN_AGE_MS = 60 * 60_000;
/**
 * How long a row may sit `inflight` before another pass takes it back. A worker
 * that is killed mid-send leaves its claim behind, and without this the row is
 * stranded forever: `listDue` only ever returns pending|failed. Comfortably
 * larger than any single attempt can take (webhooksTimeoutMs, default 10s).
 */
const STALE_CLAIM_MS = 120_000;

/** Cap on the response body we read before discarding it. */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

export interface DispatchDeps {
  events: EventRepository;
  webhookEndpoints: WebhookEndpointRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  secretBox: SecretBox;
  send: Sender;
  guard: UrlGuardOptions;
  workerId: string;
  batchSize?: number;
}

/**
 * ±20% jitter. Without it, a backlog that failed together retries together: the
 * endpoint comes back up, takes the whole backlog in one burst, falls over
 * again, and the schedule keeps them synchronised forever. Spreading the retries
 * is what lets a recovering endpoint actually recover.
 */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * The real sender, as a FACTORY rather than a constant, so this module imports
 * no configuration at all.
 *
 * The timeout is the only thing here that was ever configurable, and reading it
 * from `env.js` at module scope made importing this file a boot-time assertion:
 * `env.ts` throws when JWT_SECRET is absent, `.env` is gitignored, and so in a
 * clone, in CI or in a fresh worktree the DISPATCHER TEST FILE FAILED TO
 * COLLECT — sixteen tests, including every auto-disable and CAS-claim proof,
 * silently did not run while the suite still reported all green. A worker whose
 * security evidence only exists on the author's machine has no security
 * evidence. Configuration is therefore read exactly once, in server.ts, where
 * the process already depends on `env` anyway, and handed in.
 */
export function createHttpSender(timeoutMs: number): Sender {
  return async (url, body, headers) => {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: { ...headers, "content-type": "application/json" },
      // A SECURITY CONTROL, not a preference. The URL guard only ever inspects
      // the REGISTERED url; a 302 to http://169.254.169.254/ would send the next
      // hop to an address that has been through no check at all, turning this
      // server into the org's proxy for its own metadata service. Refusing to
      // follow redirects is what keeps "the URL we validated" and "the URL we
      // requested" the same string. A 3xx is a failed attempt, never a hop.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status is part of the delivery contract, so the body is read
    // purely to release the socket — and read BOUNDED. `res.text()` would buffer
    // whatever the endpoint chooses to send, so an integrator streaming an
    // endless body could pin this worker's memory and hold the pass open until
    // the timeout. Reading a capped prefix and then cancelling bounds both.
    const reader = res.body?.getReader();
    if (reader) {
      try {
        let read = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          read += value?.byteLength ?? 0;
          if (read >= MAX_RESPONSE_BYTES) break;
        }
      } catch {
        /* a truncated or aborted body says nothing about delivery — the status did */
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return { status: res.status };
  };
}

/** One pass. Returns how many deliveries this worker actually handled. */
export async function dispatchDue(deps: DispatchDeps): Promise<number> {
  const now = new Date();
  // Crash recovery FIRST, so a row stranded inflight by a killed worker is back
  // in the pending set before this pass reads the due list.
  await deps.webhookDeliveries.reclaimStale(new Date(now.getTime() - STALE_CLAIM_MS).toISOString());

  const due = await deps.webhookDeliveries.listDue(now.toISOString(), deps.batchSize ?? 20);
  let handled = 0;

  for (const row of due) {
    // CLAIM BEFORE ANYTHING ELSE. `row` is a snapshot from a plain read; between
    // that read and here another worker may have taken it. The claim is the
    // compare-and-set, and `null` means we lost — skip without touching the row.
    const claimed = await deps.webhookDeliveries.claim(row.id, deps.workerId, new Date().toISOString());
    if (!claimed) continue;
    handled += 1;

    const endpoint = await deps.webhookEndpoints.findById(claimed.endpointId);
    const event = await deps.events.findById(claimed.eventId);
    // No retry schedule can fix any of these: the destination or the payload is
    // gone, or the org has switched the endpoint off. Dead immediately, with a
    // reason an operator can read, rather than six attempts at nothing.
    if (!endpoint || !event || endpoint.status !== "active" || endpoint.deletedAt !== null) {
      await deps.webhookDeliveries.update(claimed.id, {
        status: "dead",
        responseError: !event ? "event no longer exists" : "endpoint is no longer deliverable",
        claimedAt: null,
        claimedBy: null,
      });
      continue;
    }

    const attempts = claimed.attempts + 1;
    const startedAt = Date.now();
    let ok = false;
    let guardRefused = false;
    let responseStatus: number | null = null;
    let responseError: string | null = null;

    // OPEN THE SIGNING SECRET BEFORE THE SEND, AND OUTSIDE ITS try.
    //
    // This is not a tidiness move. Inside the try, a GCM open failure was caught
    // by the same `catch` as a TLS reset and classified as evidence about the
    // INTEGRATOR'S SERVER. So rotating WEBHOOK_MASTER_KEY — which env.ts
    // actively advises, with no key-versioning or re-encryption path — made
    // every stored secret unopenable, and the dispatcher answered by attempting
    // zero HTTP sends and then DISABLING EVERY ORG'S ENDPOINT with the reason
    // "20 consecutive delivery failures over N minutes". That reason is false,
    // and it sends an operator to audit an integrator's server over a mistake
    // made on our side of the boundary.
    //
    // It is the same class the guard refusal was already hardened for: A FAILURE
    // WHOSE CAUSE IS OURS MUST NEVER DISABLE SOMEONE ELSE'S ENDPOINT. So it gets
    // its own category, below, and touches neither health counter.
    let secret: string | null = null;
    try {
      secret = deps.secretBox.open(endpoint.secretEncrypted);
    } catch (err) {
      responseError =
        "signing secret could not be decrypted — this is a PLATFORM configuration fault, " +
        "not a fault of this endpoint (check WEBHOOK_MASTER_KEY): " +
        (err instanceof Error ? err.message : String(err));
    }
    const secretUnavailable = secret === null;

    // RE-CHECK THE URL (see the header note). A guard rejection is a FAILED
    // ATTEMPT, not a silent skip: it burns an attempt and is recorded with its
    // reason, so a delivery to a name that has genuinely moved onto a private
    // address still dead-letters at MAX_ATTEMPTS and shows the operator why.
    // What it must NOT do is count toward auto-disable — see below.
    //
    // An unopenable secret is treated the same way on the RETRY axis: it burns
    // an attempt and eventually dead-letters, rather than pinning the row
    // pending and re-running a doomed decrypt on every poll forever. Six
    // attempts span ~8h, which is a working day for an operator to restore the
    // key and let the backlog drain; anything still queued after that is
    // recoverable through the cursor API, the documented catch-up path.
    //
    // Nested rather than flattened so the compiler enforces the ordering too:
    // there is no path to `signatureHeader` that has not already proved the
    // secret opened.
    const verdict = secret === null ? null : await checkUrl(endpoint.url, deps.guard);
    if (secret === null || verdict === null) {
      /* secret already reported above — not one packet is sent */
    } else if (!verdict.ok) {
      guardRefused = true;
      responseError = verdict.reason;
    } else {
      const body = JSON.stringify({
        id: event.id,
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        orgId: event.orgId,
        useCaseKey: event.useCaseKey,
        subjectId: event.subjectId,
        // EN-D2. A delivered fact says which environment it came from. The
        // consumer does NOT have to read it to be safe — a test event is only
        // ever handed to a test endpoint — but a body that cannot say so is a
        // body nobody can assert on, and an integrator who wants the belt as
        // well as the braces should not have to call back to get it.
        mode: event.mode,
        data: event.data,
      });
      // Signed at SEND time, not at enqueue time: the timestamp inside the MAC is
      // what the integrator's freshness check compares against, and a signature
      // minted when the row was queued would be hours stale by the last retry.
      // The SECRET, though, was opened above — only the MAC is computed here, so
      // nothing inside this try can fail for a reason that is ours.
      const t = Math.floor(Date.now() / 1000);
      try {
        const res = await deps.send(endpoint.url, body, {
          "Tokenlayer-Event-Id": event.id,
          "Tokenlayer-Delivery-Id": claimed.id,
          "Tokenlayer-Event-Type": event.type,
          "Tokenlayer-Signature": signatureHeader(secret, t, body),
        });
        responseStatus = res.status;
        // 2xx ONLY. `< 400` would count a 302 as delivered, which is precisely
        // the redirect we refuse to follow — we would be marking "we handed this
        // to a redirector and stopped" as success.
        ok = res.status >= 200 && res.status < 300;
        if (!ok) responseError = `endpoint returned ${res.status}`;
      } catch (err) {
        // A transport failure (DNS, TLS, timeout, reset) is a normal retryable
        // attempt, not a worker crash — one unreachable endpoint must not stop
        // the pass for every other endpoint in the batch.
        responseError = err instanceof Error ? err.message : String(err);
      }
    }

    const exhausted = !ok && attempts >= MAX_ATTEMPTS;
    await deps.webhookDeliveries.update(claimed.id, {
      status: ok ? "delivered" : exhausted ? "dead" : "failed",
      attempts,
      lastAttemptAt: new Date().toISOString(),
      // Only a row that will be retried gets a new due time. Leaving the old one
      // in place on a settled row keeps the history honest about when it was last
      // scheduled, and `listDue` ignores delivered/dead anyway.
      nextAttemptAt:
        ok || exhausted
          ? claimed.nextAttemptAt
          : new Date(Date.now() + withJitter(BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!)).toISOString(),
      responseStatus,
      responseError,
      durationMs: Date.now() - startedAt,
      // ALWAYS release the claim. A settled row that keeps claimedAt would be
      // reclaimed as "stale" two minutes later and look like a stuck delivery.
      claimedAt: null,
      claimedBy: null,
    });

    // ── Endpoint health ──────────────────────────────────────────────────────
    //
    // TWO COUNTERS, because the two ways an attempt fails are evidence about
    // different things.
    //
    // A non-2xx answer (or an unreachable host) is evidence about THE
    // INTEGRATOR'S SERVER, and enough of it, for long enough, justifies
    // switching the endpoint off. A guard refusal is evidence about DNS — or
    // about an attacker — and says nothing about whether the integrator's server
    // is healthy. Crucially it is the one leg an attacker can pull WITHOUT
    // TOUCHING THE VICTIM AT ALL: degrade resolution for the endpoint's
    // hostname, or briefly point it at a private address, and a single shared
    // counter would disable a perfectly good endpoint with no traffic sent to
    // it. That would make our own SSRF defence into a silencing primitive. So
    // guard refusals are counted separately and acted on by NOBODY here: the
    // delivery still retries on the normal schedule and still dies at
    // MAX_ATTEMPTS. A large consecutiveGuardFailures is for an operator to SEE,
    // not for this worker to act on.
    //
    // `consecutiveFailures` is read from the snapshot taken before the send, so
    // two workers settling two deliveries to the SAME endpoint at the same
    // instant can lose one increment. That costs at most a slightly later
    // auto-disable and never a wrong disable — the right way round for a counter
    // whose only consequence is switching an org's endpoint off.
    const settledAt = new Date().toISOString();
    // THE ONLY FAILURE THAT COUNTS AGAINST AN ENDPOINT IS ONE WE CAN ATTRIBUTE
    // TO IT. Three ways an attempt fails, and only one of them is evidence about
    // the integrator: a non-2xx or an unreachable host. A guard refusal is
    // evidence about DNS (or about an attacker), and an unopenable signing
    // secret is evidence about OUR OWN key configuration — in that case not a
    // single packet left this process, so there is nothing the endpoint could
    // have done differently. Counting either would turn a fault on our side of
    // the boundary into an outage on someone else's.
    const endpointFailed = !ok && !guardRefused && !secretUnavailable;
    // A guard refusal or an unopenable secret leaves the endpoint counter and
    // its clock exactly where they were: neither is evidence of failure, and
    // neither is evidence of health.
    const failures = ok ? 0 : endpointFailed ? endpoint.consecutiveFailures + 1 : endpoint.consecutiveFailures;
    // "Consecutive" is meant literally: the guard passing at all breaks a run of
    // guard refusals, whether or not the send that followed it succeeded. An
    // attempt that never reached the guard leaves this run untouched too.
    const guardFailures = guardRefused
      ? endpoint.consecutiveGuardFailures + 1
      : secretUnavailable
        ? endpoint.consecutiveGuardFailures
        : 0;
    // The clock starts at the FIRST failure of a run and is not restarted by
    // later failures in it, so `settledAt - failingSince` is the true age of the
    // run rather than the age of the most recent failure.
    const failingSince = ok ? null : endpointFailed ? (endpoint.failingSince ?? settledAt) : endpoint.failingSince;

    // BOTH the count AND the elapsed time must agree. The count alone is
    // exhaustible by a burst — one pass over a 20-row backlog — which is exactly
    // the attack the time floor exists to defeat. On the very first failure of a
    // run `failingSince` is `settledAt`, so the age is zero and no burst,
    // however large, can disable anything.
    const runAgeMs = failingSince ? Date.parse(settledAt) - Date.parse(failingSince) : 0;
    const shouldDisable = failures >= AUTO_DISABLE_AFTER && runAgeMs >= AUTO_DISABLE_MIN_AGE_MS;

    await deps.webhookEndpoints.update(endpoint.id, {
      consecutiveFailures: failures,
      consecutiveGuardFailures: guardFailures,
      failingSince,
      lastDeliveryAt: settledAt,
      ...(shouldDisable
        ? {
            status: "disabled" as const,
            disabledReason: `${failures} consecutive failed delivery attempts over ${Math.round(runAgeMs / 60_000)} minutes`,
            disabledAt: settledAt,
          }
        : {}),
    });
  }
  return handled;
}

/**
 * Start the poller. The returned stop function is ASYNC and settles only once
 * any pass that was already running has finished.
 *
 * That await is the point. A synchronous `clearInterval` cancels the TIMER, not
 * the pass, so a SIGTERM handler that called it and then exited immediately
 * killed the process mid-send, leaving every row that pass had claimed sitting
 * `inflight` — the exact thing shutdown is supposed to avoid, while the comment
 * claimed it was avoided. Awaiting the pass makes the claim true for a pass that
 * completes. It is not a guarantee for every case: a caller that gives up
 * waiting, or a real crash, still strands claims, and the honest backstop for
 * those is `reclaimStale` at the top of the next pass (STALE_CLAIM_MS).
 */
export function startDispatcher(deps: Omit<DispatchDeps, "workerId">, pollMs: number): () => Promise<void> {
  // Per-process, so `claimedBy` on a stuck row names which instance stranded it.
  const workerId = `wh-${randomUUID().slice(0, 8)}`;
  let running = false;
  // Always a settled promise between passes, so stop() never waits on nothing.
  let pass: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    // Passes must never overlap: a slow pass plus a short interval would stack
    // workers that all share one workerId, and a row this worker already claimed
    // would look like its own to the overlapping pass.
    if (running) return;
    running = true;
    pass = (async () => {
      try {
        await dispatchDue({ ...deps, workerId });
      } catch (err) {
        // A pass that throws must not kill the interval — the next tick retries.
        console.error("[webhooks] dispatch pass failed", err);
      } finally {
        running = false;
      }
    })();
  }, pollMs);
  // The poller must not be the reason the process refuses to exit.
  timer.unref?.();
  return async () => {
    // Cancel FIRST, so no new pass can start while we wait for the current one.
    clearInterval(timer);
    await pass;
  };
}
