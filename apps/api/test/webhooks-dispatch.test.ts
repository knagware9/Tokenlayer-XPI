/**
 * The dispatcher (EN-C, C5). Every test drives `dispatchDue` directly — no
 * interval, no clock faking, no sleeping on a backoff.
 *
 * NO REAL HTTP AND NO REAL DNS. `send` is a vi.fn and the guard's resolver is a
 * stub, which is the only reason a test can assert "the guard refused, so we did
 * not send" without depending on what example.test happens to resolve to on the
 * machine running CI.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryEventRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookEndpointRepository,
} from "../src/persistence/memory/index.js";
import {
  AUTO_DISABLE_AFTER,
  AUTO_DISABLE_MIN_AGE_MS,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  dispatchDue,
} from "../src/webhooks/dispatcher.js";
import { createSecretBox } from "../src/webhooks/secret-box.js";
import { verifySignature } from "../src/webhooks/signing.js";

const box = createSecretBox("22".repeat(32));

/** A public address, so the guard passes on the merits rather than by stubbing it out. */
const okGuard = { resolve: async () => ["93.184.216.34"] };

async function fixture() {
  const events = new MemoryEventRepository();
  const webhookEndpoints = new MemoryWebhookEndpointRepository();
  const webhookDeliveries = new MemoryWebhookDeliveryRepository();
  const secret = box.mint();
  const ep = await webhookEndpoints.create({
    orgId: "org1",
    url: "https://hooks.example.test/x",
    description: null,
    eventTypes: ["*"],
    useCaseKey: null,
    secretEncrypted: box.seal(secret),
    createdBy: "u1",
  });
  const ev = await events.append({
    type: "credential.issued",
    orgId: "org1",
    useCaseKey: null,
    subjectId: "c1",
    data: { credentialId: "c1" },
  });
  const d = await webhookDeliveries.enqueue({ endpointId: ep.id, eventId: ev.id, eventSeq: ev.seq });
  return { events, webhookEndpoints, webhookDeliveries, ep, ev, d, secret };
}

/** Make a settled delivery due again, so the next pass picks it up. */
async function makeDue(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.webhookDeliveries.update(f.d.id, { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
}

/**
 * `n` MORE queued events for the same endpoint — a backlog. This is the shape of
 * the burst attack: one dispatch pass settles all of them, so a counter with no
 * time floor is exhausted in a single pass.
 */
async function backlog(f: Awaited<ReturnType<typeof fixture>>, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const ev = await f.events.append({
      type: "credential.issued",
      orgId: "org1",
      useCaseKey: null,
      subjectId: `c${i + 2}`,
      data: { credentialId: `c${i + 2}` },
    });
    await f.webhookDeliveries.enqueue({ endpointId: f.ep.id, eventId: ev.id, eventSeq: ev.seq });
  }
}

const agoMs = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe("dispatcher", () => {
  it("delivers a signed payload that the documented verify recipe accepts", async () => {
    const f = await fixture();
    let seen: { url: string; body: string; headers: Record<string, string> } | null = null;
    const send = vi.fn(async (url: string, body: string, headers: Record<string, string>) => {
      seen = { url, body, headers };
      return { status: 200 };
    });

    const handled = await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    expect(handled).toBe(1);

    const call = seen as unknown as { url: string; body: string; headers: Record<string, string> };
    expect(call.url).toBe("https://hooks.example.test/x");
    expect(call.headers["Tokenlayer-Event-Id"]).toBe(f.ev.id);
    expect(call.headers["Tokenlayer-Delivery-Id"]).toBe(f.d.id);
    expect(call.headers["Tokenlayer-Event-Type"]).toBe("credential.issued");

    // The whole secret chain in one assertion: mint → seal → open → sign →
    // verify. If any link were wrong (a secret stored plaintext, the box opened
    // with the wrong key, the signature computed over a different body) this
    // fails, and it fails using the exact function we hand integrators.
    expect(verifySignature(f.secret, call.headers["Tokenlayer-Signature"]!, call.body)).toBe(true);
    // ...and it is a real MAC, not a constant: a different secret must not verify.
    expect(verifySignature(box.mint(), call.headers["Tokenlayer-Signature"]!, call.body)).toBe(false);

    expect(JSON.parse(call.body)).toMatchObject({ id: f.ev.id, seq: f.ev.seq, type: "credential.issued", orgId: "org1" });

    const settled = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(settled.status).toBe("delivered");
    expect(settled.responseStatus).toBe(200);
    expect(settled.claimedAt).toBeNull();
    expect(settled.claimedBy).toBeNull();
  });

  it("a 500 schedules a retry, and the backoff GROWS with each attempt", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 500 }));

    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    const after1 = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(after1.status).toBe("failed");
    expect(after1.attempts).toBe(1);
    expect(after1.responseStatus).toBe(500);
    // ±20% jitter, so bound both sides rather than assert an exact instant.
    const delay1 = Date.parse(after1.nextAttemptAt) - Date.now();
    expect(delay1).toBeGreaterThan(BACKOFF_MS[0] * 0.75);
    expect(delay1).toBeLessThan(BACKOFF_MS[0] * 1.25);

    // The SECOND attempt must wait meaningfully longer. Checking only attempt 1
    // would pass just as happily against a constant 30s backoff, which is the
    // whole point of a schedule.
    await makeDue(f);
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    const after2 = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(after2.attempts).toBe(2);
    const delay2 = Date.parse(after2.nextAttemptAt) - Date.now();
    expect(delay2).toBeGreaterThan(BACKOFF_MS[1] * 0.75);
    expect(delay2).toBeLessThan(BACKOFF_MS[1] * 1.25);
    // Even at worst-case jitter (1.2 × 30s vs 0.8 × 120s) the growth is visible.
    expect(delay2).toBeGreaterThan(delay1 * 2);

    await makeDue(f);
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    const after3 = (await f.webhookDeliveries.findById(f.d.id))!;
    const delay3 = Date.parse(after3.nextAttemptAt) - Date.now();
    expect(delay3).toBeGreaterThan(BACKOFF_MS[2] * 0.75);
    expect(delay3).toBeLessThan(BACKOFF_MS[2] * 1.25);
  });

  it("a 3xx is a FAILURE — a redirect is never a hop", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 302 }));
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });

    const d = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(d.status).toBe("failed");
    expect(d.responseStatus).toBe(302);
    expect(d.responseError).toMatch(/302/);
    // A redirect that counted as success would also reset the health counter,
    // hiding a permanently misconfigured endpoint from the auto-disable rule.
    expect((await f.webhookEndpoints.findById(f.ep.id))!.consecutiveFailures).toBe(1);
  });

  it("reaches dead after MAX_ATTEMPTS and stops being due", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 500 }));
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await makeDue(f);
      await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    }

    const dead = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(MAX_ATTEMPTS);
    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    // Dead is terminal: it must never come back round, whatever the clock says.
    expect(await f.webhookDeliveries.listDue(new Date(Date.now() + 86_400_000).toISOString(), 10)).toHaveLength(0);
    await makeDue(f);
    expect(await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" })).toBe(0);
    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("auto-disables at AUTO_DISABLE_AFTER failures once the run is OLDER than the floor", async () => {
    const f = await fixture();
    // The count is one short AND the run has been going for two hours: both
    // conditions are about to be true together, which is the only way to disable.
    await f.webhookEndpoints.update(f.ep.id, {
      consecutiveFailures: AUTO_DISABLE_AFTER - 1,
      failingSince: agoMs(2 * 60 * 60_000),
    });
    const send = vi.fn(async () => ({ status: 500 }));
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.status).toBe("disabled");
    expect(ep.consecutiveFailures).toBe(AUTO_DISABLE_AFTER);
    expect(ep.disabledReason).toMatch(/consecutive/i);
    expect(ep.disabledReason).toContain(String(AUTO_DISABLE_AFTER));
    expect(ep.disabledAt).not.toBeNull();
  });

  it("a BURST cannot disable: AUTO_DISABLE_AFTER failures inside the min-age window leave it active", async () => {
    // THE ATTACK, PINNED. A backlog of exactly AUTO_DISABLE_AFTER events settles
    // in ONE pass (batchSize defaults to 20 too), so the count alone is fully
    // exhausted while the failure run is only milliseconds old. Before the time
    // floor this permanently disabled the endpoint; a 30-second outage during a
    // rolling deploy was enough.
    const f = await fixture();
    await backlog(f, AUTO_DISABLE_AFTER - 1); // + the fixture's own = AUTO_DISABLE_AFTER
    const send = vi.fn(async () => ({ status: 500 }));

    const handled = await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1", batchSize: 100 });
    expect(handled).toBe(AUTO_DISABLE_AFTER);

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.consecutiveFailures).toBe(AUTO_DISABLE_AFTER); // the count IS exhausted
    expect(ep.status).toBe("active"); // ...and it still must not disable
    expect(ep.disabledReason).toBeNull();
    expect(ep.disabledAt).toBeNull();
    // The clock started at the first failure of the run and is barely old.
    expect(ep.failingSince).not.toBeNull();
    expect(Date.now() - Date.parse(ep.failingSince!)).toBeLessThan(AUTO_DISABLE_MIN_AGE_MS);

    // And it stays active on the very next failure too — nothing about a burst
    // is merely deferred by one attempt.
    await makeDue(f);
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });
    expect((await f.webhookEndpoints.findById(f.ep.id))!.status).toBe("active");
  });

  it("stops short of auto-disabling one failure early", async () => {
    const f = await fixture();
    await f.webhookEndpoints.update(f.ep.id, { consecutiveFailures: AUTO_DISABLE_AFTER - 2 });
    await dispatchDue({ ...f, secretBox: box, send: async () => ({ status: 500 }), guard: okGuard, workerId: "w1" });

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.consecutiveFailures).toBe(AUTO_DISABLE_AFTER - 1);
    expect(ep.status).toBe("active");
    expect(ep.disabledReason).toBeNull();
  });

  it("a success resets the consecutive-failure counter", async () => {
    const f = await fixture();
    await f.webhookEndpoints.update(f.ep.id, { consecutiveFailures: 5 });
    await dispatchDue({ ...f, secretBox: box, send: async () => ({ status: 200 }), guard: okGuard, workerId: "w1" });

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.consecutiveFailures).toBe(0);
    expect(ep.status).toBe("active");
    expect(ep.lastDeliveryAt).not.toBeNull();
  });

  it("a success CLEARS failingSince, so a later run starts its clock fresh", async () => {
    const f = await fixture();
    // An old run, nearly at the threshold and well past the age floor: one more
    // failure would have disabled it.
    await f.webhookEndpoints.update(f.ep.id, {
      consecutiveFailures: AUTO_DISABLE_AFTER - 1,
      failingSince: agoMs(5 * 60 * 60_000),
    });
    await dispatchDue({ ...f, secretBox: box, send: async () => ({ status: 200 }), guard: okGuard, workerId: "w1" });
    const healthy = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(healthy.failingSince).toBeNull();
    expect(healthy.consecutiveFailures).toBe(0);

    // A NEW run must date from now, not inherit the five-hour-old clock — else a
    // single delivery after a recovery would disable on the strength of history
    // the endpoint has already disproved.
    await backlog(f, AUTO_DISABLE_AFTER);
    await dispatchDue({
      ...f, secretBox: box, send: async () => ({ status: 500 }), guard: okGuard, workerId: "w1", batchSize: 100,
    });
    const failing = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(failing.consecutiveFailures).toBe(AUTO_DISABLE_AFTER);
    expect(failing.status).toBe("active");
    expect(Date.now() - Date.parse(failing.failingSince!)).toBeLessThan(AUTO_DISABLE_MIN_AGE_MS);
  });

  it("GUARD/DNS rejections never disable, however many — but the delivery still dies", async () => {
    // An attacker who can degrade DNS for the endpoint's hostname (or briefly
    // point it at a private address) must not be able to switch off a
    // competitor's integration without sending the victim a single packet.
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 200 }));
    const rebound = { resolve: async () => ["127.0.0.1"] };
    await f.webhookEndpoints.update(f.ep.id, { failingSince: agoMs(5 * 60 * 60_000) }); // an ancient clock too
    await backlog(f, AUTO_DISABLE_AFTER * 2);

    await dispatchDue({ ...f, secretBox: box, send, guard: rebound, workerId: "w1", batchSize: 100 });

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(send).not.toHaveBeenCalled();
    expect(ep.consecutiveGuardFailures).toBeGreaterThanOrEqual(AUTO_DISABLE_AFTER);
    expect(ep.consecutiveFailures).toBe(0); // the endpoint counter is untouched
    expect(ep.status).toBe("active");
    expect(ep.disabledReason).toBeNull();

    // Still not disabled after MAX_ATTEMPTS more rounds — and the DELIVERY does
    // die, so a genuinely rebound endpoint is not retried forever either.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await makeDue(f);
      await dispatchDue({ ...f, secretBox: box, send, guard: rebound, workerId: "w1", batchSize: 100 });
    }
    expect((await f.webhookDeliveries.findById(f.d.id))!.status).toBe("dead");
    expect((await f.webhookEndpoints.findById(f.ep.id))!.status).toBe("active");
  });

  it("the guard-failure run resets as soon as the guard passes again", async () => {
    const f = await fixture();
    await dispatchDue({
      ...f, secretBox: box, send: async () => ({ status: 200 }), guard: { resolve: async () => ["127.0.0.1"] }, workerId: "w1",
    });
    expect((await f.webhookEndpoints.findById(f.ep.id))!.consecutiveGuardFailures).toBe(1);

    // The guard passing BREAKS the run even though the send then failed — the
    // counter means consecutive guard refusals, not "failures of any kind".
    await makeDue(f);
    await dispatchDue({ ...f, secretBox: box, send: async () => ({ status: 500 }), guard: okGuard, workerId: "w1" });
    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.consecutiveGuardFailures).toBe(0);
    expect(ep.consecutiveFailures).toBe(1);
  });

  it("REFUSES to send when the guard rejects at DELIVERY time (DNS rebinding)", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 200 }));
    // The endpoint was registered while the name resolved publicly; it now points
    // at loopback. Registration-time checking alone cannot see this.
    const rebound = { resolve: async () => ["127.0.0.1"] };
    await dispatchDue({ ...f, secretBox: box, send, guard: rebound, workerId: "w1" });

    expect(send).not.toHaveBeenCalled();
    const d = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(1);
    expect(d.responseStatus).toBeNull();
    expect(d.responseError).toMatch(/loopback|not publicly routable/i);
    // The refusal is recorded, but in its OWN counter: it is evidence about DNS,
    // not about whether the integrator's server is healthy, and it must never
    // feed the counter that can switch an org's endpoint off.
    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.consecutiveGuardFailures).toBe(1);
    expect(ep.consecutiveFailures).toBe(0);
    expect(ep.failingSince).toBeNull();
  });

  it("a claimed delivery is invisible to a second concurrent dispatcher", async () => {
    const f = await fixture();
    // Slow enough that both passes are in flight at once: without the CAS claim
    // both would read the same pending row and both would POST it.
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200 };
    });
    const [a, b] = await Promise.all([
      dispatchDue({ ...f, secretBox: box, send: slow, guard: okGuard, workerId: "w1" }),
      dispatchDue({ ...f, secretBox: box, send: slow, guard: okGuard, workerId: "w2" }),
    ]);

    expect(a + b).toBe(1); // exactly one worker handled it
    expect(slow).toHaveBeenCalledTimes(1); // and the integrator saw it exactly once
    expect((await f.webhookDeliveries.findById(f.d.id))!.status).toBe("delivered");
    expect((await f.webhookEndpoints.findById(f.ep.id))!.consecutiveFailures).toBe(0);
  });

  it("dead-letters immediately when the endpoint is gone, without sending", async () => {
    const f = await fixture();
    const send = vi.fn(async () => ({ status: 200 }));
    await f.webhookEndpoints.update(f.ep.id, { deletedAt: new Date().toISOString() });
    await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" });

    expect(send).not.toHaveBeenCalled();
    const d = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(d.status).toBe("dead");
    expect(d.responseError).toMatch(/no longer deliverable/i);
    expect(d.claimedBy).toBeNull();
  });

  it("a transport error is a normal retryable failure, not a crashed pass", async () => {
    const f = await fixture();
    const send = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" })).resolves.toBe(1);

    const d = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(d.status).toBe("failed");
    expect(d.responseError).toMatch(/socket hang up/);
    expect(d.responseStatus).toBeNull();
  });

  it("reclaims a delivery stranded inflight by a crashed worker", async () => {
    const f = await fixture();
    // What a killed process leaves behind: inflight, claimed, invisible to listDue.
    await f.webhookDeliveries.update(f.d.id, {
      status: "inflight",
      claimedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      claimedBy: "dead-worker",
    });
    expect(await f.webhookDeliveries.listDue(new Date().toISOString(), 10)).toHaveLength(0);

    const send = vi.fn(async () => ({ status: 200 }));
    expect(await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" })).toBe(1);
    expect((await f.webhookDeliveries.findById(f.d.id))!.status).toBe("delivered");
  });

  it("a ROTATED master key is OUR fault: it disables NOTHING and says so honestly", async () => {
    // FINAL-REVIEW FIX (MEDIUM). `secretBox.open` used to be evaluated INSIDE
    // the send `try`, so a GCM open failure was caught by the same handler as a
    // TLS reset and classified as evidence about the integrator's server.
    // env.ts actively advises setting WEBHOOK_MASTER_KEY (it otherwise falls
    // back to DID_MASTER_KEY) and there is no re-encryption path, so following
    // our own advice on a live deployment attempted zero HTTP sends and then
    // disabled EVERY org's endpoint with the reason "N consecutive delivery
    // failures" — a claim that is false and sends an operator to audit somebody
    // else's server.
    //
    // Same class the guard refusal was already hardened for: a failure whose
    // cause is on OUR side must never disable someone else's endpoint.
    const f = await fixture();
    const rotated = createSecretBox("33".repeat(32)); // the secret was sealed under `box`
    // On the brink: one endpoint-attributable failure with a two-hour-old run
    // would disable it, so the ONLY thing keeping it alive is the classification.
    await f.webhookEndpoints.update(f.ep.id, {
      consecutiveFailures: AUTO_DISABLE_AFTER - 1,
      failingSince: agoMs(2 * 60 * 60_000),
    });
    const send = vi.fn(async () => ({ status: 200 }));
    await backlog(f, AUTO_DISABLE_AFTER * 2); // and a backlog large enough to exhaust any counter

    const handled = await dispatchDue({
      ...f, secretBox: rotated, send, guard: okGuard, workerId: "w1", batchSize: 100,
    });
    expect(handled).toBe(AUTO_DISABLE_AFTER * 2 + 1);
    expect(send).not.toHaveBeenCalled(); // not one packet left this process

    const ep = (await f.webhookEndpoints.findById(f.ep.id))!;
    expect(ep.status).toBe("active");
    expect(ep.disabledReason).toBeNull();
    expect(ep.disabledAt).toBeNull();
    // BOTH counters and the clock are untouched: an attempt that never reached
    // the network is evidence about neither the endpoint nor DNS.
    expect(ep.consecutiveFailures).toBe(AUTO_DISABLE_AFTER - 1);
    expect(ep.consecutiveGuardFailures).toBe(0);
    expect(Date.now() - Date.parse(ep.failingSince!)).toBeGreaterThan(AUTO_DISABLE_MIN_AGE_MS);

    // The delivery records the REAL reason, and does not impersonate one.
    const d = (await f.webhookDeliveries.findById(f.d.id))!;
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(1);
    expect(d.responseStatus).toBeNull();
    expect(d.responseError).toMatch(/WEBHOOK_MASTER_KEY/);
    expect(d.responseError).toMatch(/PLATFORM configuration fault/);
    expect(d.responseError).not.toMatch(/endpoint returned/);

    // …and it is a retryable failure, so restoring the key drains the backlog
    // rather than leaving the operator with nothing but dead rows.
    await makeDue(f);
    expect(await dispatchDue({ ...f, secretBox: box, send, guard: okGuard, workerId: "w1" })).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await f.webhookDeliveries.findById(f.d.id))!.status).toBe("delivered");
  });

  it("imports NO configuration, so this file collects in a checkout with no .env", async () => {
    // FINAL-REVIEW FIX (MEDIUM), and the reason it is asserted on the SOURCE:
    // the defect was invisible from inside a passing run. `dispatcher.ts`
    // imported `../env.js` at module scope, `env.ts` throws when JWT_SECRET is
    // absent, and `.env` is gitignored — so in a clone, in CI or in a fresh
    // worktree THIS ENTIRE FILE failed to collect and all of its tests silently
    // did not run, while the suite still reported green (579 tests without a
    // .env, 595 with). Configuration now enters through `createHttpSender` from
    // server.ts, and this pins that it stays that way.
    const src = await readFile(new URL("../src/webhooks/dispatcher.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+"\.\.\/env\.js"/);
    // Nor the lazy version of the same coupling.
    expect(src).not.toMatch(/process\.env/);
  });
});
