import { describe, expect, it } from "vitest";
import { MemoryEventRepository, MemoryWebhookDeliveryRepository, MemoryWebhookEndpointRepository } from "../src/persistence/memory.js";

const endpointInput = {
  orgId: "org1", url: "https://example.test/hook", description: null,
  eventTypes: ["credential.issued"], useCaseKey: null,
  secretEncrypted: "ct", createdBy: "u1",
};

describe("event repository", () => {
  it("assigns a strictly increasing seq and a distinct public id", async () => {
    const repo = new MemoryEventRepository();
    const a = await repo.append({ type: "credential.issued", orgId: "org1", useCaseKey: null, subjectId: "c1", data: { a: 1 } });
    const b = await repo.append({ type: "asset.issued", orgId: "org1", useCaseKey: null, subjectId: "a1", data: {} });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.id).not.toEqual(b.id);
    expect(a.data).toEqual({ a: 1 });
  });

  it("listAfter is exclusive, seq-ordered, org-filtered and limited", async () => {
    const repo = new MemoryEventRepository();
    const a = await repo.append({ type: "credential.issued", orgId: "org1", useCaseKey: null, subjectId: null, data: {} });
    await repo.append({ type: "credential.issued", orgId: "org2", useCaseKey: null, subjectId: null, data: {} });
    const c = await repo.append({ type: "asset.issued", orgId: "org1", useCaseKey: null, subjectId: null, data: {} });
    const mine = await repo.listAfter(0, { orgId: "org1", limit: 10 });
    expect(mine.map((e) => e.seq)).toEqual([a.seq, c.seq]);
    expect(await repo.listAfter(a.seq, { orgId: "org1", limit: 10 })).toHaveLength(1);
    expect(await repo.listAfter(0, { orgId: "org1", limit: 1 })).toHaveLength(1);
    expect(await repo.listAfter(0, { orgId: "org1", type: "asset.issued", limit: 10 })).toHaveLength(1);
  });
});

describe("delivery repository", () => {
  it("enqueue is idempotent on (endpoint, event)", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const a = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const b = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    expect(b.id).toEqual(a.id);
    expect(await repo.listByEndpoint("e1", 10)).toHaveLength(1);
  });

  it("claim is a compare-and-set: the second caller gets null", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const d = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const now = new Date().toISOString();
    expect(await repo.claim(d.id, "worker-a", now)).not.toBeNull();
    expect(await repo.claim(d.id, "worker-b", now)).toBeNull();
  });

  it("reclaimStale returns inflight rows to pending", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const d = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    await repo.claim(d.id, "dead-worker", "2020-01-01T00:00:00.000Z");
    expect(await repo.reclaimStale("2021-01-01T00:00:00.000Z")).toBe(1);
    expect((await repo.findById(d.id))!.status).toBe("pending");
  });

  it("listDue excludes future, delivered and dead rows", async () => {
    const repo = new MemoryWebhookDeliveryRepository();
    const due = await repo.enqueue({ endpointId: "e1", eventId: "ev1", eventSeq: 1 });
    const later = await repo.enqueue({ endpointId: "e1", eventId: "ev2", eventSeq: 2 });
    await repo.update(later.id, { nextAttemptAt: "2999-01-01T00:00:00.000Z", status: "failed" });
    const done = await repo.enqueue({ endpointId: "e1", eventId: "ev3", eventSeq: 3 });
    await repo.update(done.id, { status: "delivered" });
    const ids = (await repo.listDue(new Date().toISOString(), 10)).map((d) => d.id);
    expect(ids).toEqual([due.id]);
  });
});

describe("endpoint repository", () => {
  it("listActive excludes disabled and soft-deleted endpoints", async () => {
    const repo = new MemoryWebhookEndpointRepository();
    const live = await repo.create(endpointInput);
    const off = await repo.create(endpointInput);
    const gone = await repo.create(endpointInput);
    await repo.update(off.id, { status: "disabled", disabledReason: "too many failures" });
    await repo.update(gone.id, { deletedAt: new Date().toISOString() });
    expect((await repo.listActive()).map((e) => e.id)).toEqual([live.id]);
  });

  it("listByOrg(null) lists platform-scope endpoints, not every org's", async () => {
    const repo = new MemoryWebhookEndpointRepository();
    await repo.create(endpointInput);
    const plat = await repo.create({ ...endpointInput, orgId: null });
    expect((await repo.listByOrg(null)).map((e) => e.id)).toEqual([plat.id]);
  });
});
