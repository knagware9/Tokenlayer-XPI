import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES } from "@tokenlayer/core";
import { describe, expect, it } from "vitest";
import { emitEvent } from "../src/shared/events.js";
import {
  MemoryEventRepository,
  MemoryWebhookDeliveryRepository,
  MemoryWebhookEndpointRepository,
} from "../src/persistence/memory.js";
import type { AppDeps } from "../src/context.js";

/**
 * ANTI-DRIFT. The spec chose an explicit outbox over deriving events from the
 * audit sink, and the cost of that choice is that a future author can add a
 * catalog entry and forget to emit it — a subscription that silently never
 * fires. This test makes the omission a build failure, the same way
 * scope-coverage.test.ts makes an ungated route a build failure.
 *
 * STRENGTHENED past the obvious version: a bare `src.includes('"credential.revoked"')`
 * also matches the type name sitting in a doc comment, a schema enum, or a
 * `validateEventTypes` fixture — none of which emit anything. So this scans only
 * the text of `emitEvent(` CALLS, with whole-line comments stripped first. A
 * catalog entry that appears everywhere in the codebase except inside an
 * emitEvent call still fails, which is the case that actually matters.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** How far past `emitEvent(` a call's `type:` literal can plausibly sit. */
const CALL_WINDOW = 700;

function allSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(`${dir}/${e.name}`, "utf8"));
    }
  };
  walk(SRC);
  return out.join("\n");
}

/**
 * Drop WHOLE-LINE comments only. Stripping trailing `//` would also eat the rest
 * of any line holding a `https://` literal, which is worse than the leak it
 * closes; a stray event name is realistically written in prose, on its own line.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** Every catalog type appearing as a string literal inside some `emitEvent(` call. */
function emittedTypes(): Set<string> {
  const src = stripLineComments(allSource());
  const found = new Set<string>();
  for (let i = src.indexOf("emitEvent("); i !== -1; i = src.indexOf("emitEvent(", i + 1)) {
    const window = src.slice(i, i + CALL_WINDOW);
    for (const t of EVENT_TYPES) if (window.includes(`"${t}"`)) found.add(t);
  }
  return found;
}

describe("event emit coverage", () => {
  it("every catalog type has at least one emit site", () => {
    const emitted = emittedTypes();
    const missing = EVENT_TYPES.filter((t) => !emitted.has(t));
    expect(missing, `catalog types with no emit site: ${missing.join(", ")}`).toEqual([]);
  });

  it("the scan is anchored to emitEvent calls, not to the whole file", () => {
    // Guards the guard: if `emitEvent(` ever disappears (renamed helper, emit
    // path deleted wholesale) the window scan would find nothing and the test
    // above would fail loudly rather than vacuously pass.
    expect(emittedTypes().size).toBeGreaterThan(0);
  });
});

// --- behaviour ------------------------------------------------------------

const depsFor = () =>
  ({
    events: new MemoryEventRepository(),
    webhookEndpoints: new MemoryWebhookEndpointRepository(),
    webhookDeliveries: new MemoryWebhookDeliveryRepository(),
  }) as unknown as AppDeps;

const endpoint = (over: Partial<Parameters<MemoryWebhookEndpointRepository["create"]>[0]>) => ({
  orgId: "org1",
  url: "https://example.test/hook",
  description: null,
  eventTypes: ["credential.issued"],
  useCaseKey: null,
  secretEncrypted: "ct",
  createdBy: "u1",
  ...over,
});

/** Silences the deliberate console.error in the swallow test. */
const quiet = { error: () => {} };

describe("emitEvent", () => {
  it("writes the event and fans out ONLY to matching endpoints", async () => {
    const deps = depsFor();
    const mine = await deps.webhookEndpoints.create(endpoint({}));
    const otherOrg = await deps.webhookEndpoints.create(endpoint({ orgId: "org2" }));
    const wrongType = await deps.webhookEndpoints.create(endpoint({ eventTypes: ["asset.issued"] }));

    await emitEvent(deps, {
      type: "credential.issued",
      orgId: "org1",
      useCaseKey: null,
      subjectId: "cred1",
      data: { credentialId: "cred1" },
    });

    const [ev] = await deps.events.listAfter(0, { orgId: "org1", limit: 10 });
    expect(ev.type).toBe("credential.issued");
    expect(ev.subjectId).toBe("cred1");

    expect(await deps.webhookDeliveries.listByEndpoint(mine.id, 10)).toHaveLength(1);
    expect(await deps.webhookDeliveries.listByEndpoint(otherOrg.id, 10)).toHaveLength(0);
    expect(await deps.webhookDeliveries.listByEndpoint(wrongType.id, 10)).toHaveLength(0);
  });

  it("fan-out happens at emit: an endpoint registered LATER gets nothing", async () => {
    // Pins the design choice — (endpointId, eventId) is the idempotency key, so
    // rows must exist by the time the dispatcher looks. Catching up is the
    // cursor API's job, not the fan-out's.
    const deps = depsFor();
    await emitEvent(deps, { type: "asset.issued", orgId: "org1", subjectId: "a1", data: {} });
    const late = await deps.webhookEndpoints.create(endpoint({ eventTypes: ["*"] }));
    expect(await deps.webhookDeliveries.listByEndpoint(late.id, 10)).toHaveLength(0);
  });

  it("a platform-scope event reaches platform endpoints, never an org's", async () => {
    const deps = depsFor();
    const platform = await deps.webhookEndpoints.create(endpoint({ orgId: null, eventTypes: ["*"] }));
    const org = await deps.webhookEndpoints.create(endpoint({ orgId: "org1", eventTypes: ["*"] }));
    await emitEvent(deps, { type: "verification.requested", orgId: null, subjectId: "vr1", data: {} });
    expect(await deps.webhookDeliveries.listByEndpoint(platform.id, 10)).toHaveLength(1);
    expect(await deps.webhookDeliveries.listByEndpoint(org.id, 10)).toHaveLength(0);
  });

  it("normalizes an empty-string orgId/useCaseKey to null, not to a matchable value", async () => {
    // "" is what an org-less desk operator's verification request stores. If it
    // survived into the row it would become a value `endpointMatches` can match
    // on — the ""-vs-null gate bypass, again.
    const deps = depsFor();
    await emitEvent(deps, { type: "verification.requested", orgId: "", useCaseKey: "", subjectId: "vr1", data: {} });
    const [ev] = await deps.events.listAfter(0, { limit: 10 });
    expect(ev.orgId).toBeNull();
    expect(ev.useCaseKey).toBeNull();
  });

  it("NEVER throws into the caller — observing must not break acting", async () => {
    const deps = depsFor();
    deps.events.append = async () => {
      throw new Error("outbox is down");
    };
    await expect(
      emitEvent(deps, { type: "credential.issued", orgId: "org1", data: {} }, quiet),
    ).resolves.toBeUndefined();
  });

  it("NEVER throws when fan-out itself fails, and the event is still recorded", async () => {
    const deps = depsFor();
    await deps.webhookEndpoints.create(endpoint({}));
    deps.webhookDeliveries.enqueue = async () => {
      throw new Error("delivery table is down");
    };
    await expect(
      emitEvent(deps, { type: "credential.issued", orgId: "org1", data: {} }, quiet),
    ).resolves.toBeUndefined();
    expect(await deps.events.listAfter(0, { orgId: "org1", limit: 10 })).toHaveLength(1);
  });

  it("refuses to persist credential material", async () => {
    const deps = depsFor();
    await emitEvent(deps, {
      type: "credential.issued",
      orgId: "org1",
      subjectId: "cred1",
      data: {
        credentialId: "cred1",
        vcJwt: "eyJhbGciOiJFZERTQSJ9.SIGNED_CREDENTIAL",
        holder: { email: "a@b.test", passwordHash: "$2b$10$BCRYPTBCRYPTBCRYPT" },
        endpoints: [{ secret: "whsec_TOPSECRET" }],
      },
    });
    const [ev] = await deps.events.listAfter(0, { orgId: "org1", limit: 10 });
    const blob = JSON.stringify(ev.data);
    expect(blob).not.toContain("SIGNED_CREDENTIAL");
    expect(blob).not.toContain("BCRYPT");
    expect(blob).not.toContain("TOPSECRET");
    // …and the harmless neighbours survive, so redaction is a filter, not a wipe.
    expect(ev.data.credentialId).toBe("cred1");
    expect((ev.data.holder as { email: string }).email).toBe("a@b.test");
  });

  it("redacts a live API key wherever it appears as a value", async () => {
    const deps = depsFor();
    await emitEvent(deps, {
      type: "asset.issued",
      orgId: "org1",
      data: { note: "tl_live_abcdefghijklmnop", nested: { keys: ["tl_live_zzzz"] } },
    });
    const [ev] = await deps.events.listAfter(0, { orgId: "org1", limit: 10 });
    expect(JSON.stringify(ev.data)).not.toContain("tl_live_");
  });
});
