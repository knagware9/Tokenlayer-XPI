/**
 * THE ANCHOR IS THE ONLY WITNESS TO WHAT THE CHAIN USED TO SAY.
 *
 * `verifyChain` cannot catch a fully consistent rewrite — recompute every hash
 * from genesis and the chain is internally perfect. The on-ledger anchor is the
 * sole remaining check, so anything that lets an attacker acquire a fresh
 * anchor for rewritten history defeats the whole mechanism.
 *
 * Found in a live deployment: one asset carried THREE anchors at seq 4, the
 * first genuine and two written after a tamper, and the code consulted exactly
 * one of them chosen by an unspecified SQL row order.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestAppWithRepos, V1, loginAs, auth } from "./helpers.js";
import type { AppDeps } from "../src/context.js";

async function seeded(): Promise<{ app: FastifyInstance; deps: AppDeps; admin: string; assetId: string }> {
  const h = await buildTestAppWithRepos();
  const admin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
  const issuer = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
  const res = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(issuer),
    payload: { useCaseKey: "carbon-credit", name: "ANCHOR-1", chainId: "fabric", initialSupply: "100", treasuryAccount: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
  });
  expect(res.statusCode).toBe(201);
  return { app: h.app, deps: h.deps, admin, assetId: res.json().asset.id };
}

const verify = async (app: FastifyInstance, admin: string, assetId: string) =>
  (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/audit/verify`, headers: auth(admin) })).json();

describe("an anchor cannot be displaced by a later one", () => {
  it("a stale anchor that DISAGREES still fails verification, even under a newer agreeing one", async () => {
    const { app, deps, admin, assetId } = await seeded();

    // The genuine attestation, taken before the (hypothetical) rewrite. Its hash
    // does not match the chain — that is precisely what a rewrite looks like
    // from the anchor's point of view.
    await deps.auditAnchors.create({ assetId, seq: 1, hash: "0x" + "de1e7ed".padEnd(64, "0"), txHash: "0xold", chainId: "fabric" });

    // The attacker's move: get a NEW anchor at a higher seq that matches the
    // rewritten chain. Before the fix this displaced the one above — the code
    // read only the highest-seq anchor — and the asset reported clean.
    //
    // SEQ IS 0-BASED, so the head sits at `count - 1`. Getting that wrong makes
    // the anchor point at an entry that does not exist, which fails for the
    // wrong reason and would pass with or without the fix.
    const v0 = await verify(app, admin, assetId);
    await deps.auditAnchors.create({ assetId, seq: v0.count - 1, hash: v0.head, txHash: "0xnew", chainId: "fabric" });

    const v = await verify(app, admin, assetId);
    expect(v.valid, "the chain itself is internally fine — that is the point").toBe(true);
    expect(v.anchorConsistent, "a newer anchor must not overwrite an older attestation").toBe(false);

    const summary = (await app.inject({ method: "GET", url: `${V1}/audit/verify`, headers: auth(admin) })).json();
    expect(summary.tampered.some((t: { assetId: string }) => t.assetId === assetId)).toBe(true);
  });

  it("latest() reports the FIRST attestation at a seq, not whichever row came back", async () => {
    const { app, deps, admin, assetId } = await seeded();
    const headSeq = (await verify(app, admin, assetId)).count - 1;
    await deps.auditAnchors.create({ assetId, seq: headSeq, hash: "0xfirst", txHash: "0xtx1", chainId: "fabric" });
    await deps.auditAnchors.create({ assetId, seq: headSeq, hash: "0xsecond", txHash: "0xtx2", chainId: "fabric" });

    const v = await verify(app, admin, assetId);
    expect(v.lastAnchor.txHash, "the original attestation speaks for the seq").toBe("0xtx1");
    // And list() sees both, which is why the disagreement above is caught.
    expect((await deps.auditAnchors.list(assetId)).length).toBe(2);
  });
});

describe("anchoring refuses to bless a changed head", () => {
  it("re-anchoring an UNCHANGED head is a no-op — no duplicate row, no transaction", async () => {
    const { app, deps, admin, assetId } = await seeded();

    const first = await app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(admin), payload: {} });
    expect(first.json().anchored.some((a: { assetId: string }) => a.assetId === assetId)).toBe(true);
    const after = (await deps.auditAnchors.list(assetId)).length;

    const second = await app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(admin), payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json().anchored.some((a: { assetId: string }) => a.assetId === assetId), "nothing moved").toBe(false);
    expect(second.json().unchanged.some((a: { assetId: string }) => a.assetId === assetId)).toBe(true);
    // THE ACCUMULATION THIS STOPS: every call used to append a row, which is how
    // a live asset ended up with three anchors at one seq.
    expect(await deps.auditAnchors.list(assetId).then((l) => l.length), "no duplicate anchor").toBe(after);
  });

  it("re-anchoring a CHANGED head at an anchored seq is refused, not recorded", async () => {
    const { app, deps, admin, assetId } = await seeded();

    // An anchor at the current head's seq whose hash disagrees — i.e. the chain
    // was rewritten after it was taken.
    const v0 = await verify(app, admin, assetId);
    await deps.auditAnchors.create({ assetId, seq: v0.count - 1, hash: "0x" + "beef".padEnd(64, "0"), txHash: "0xstale", chainId: "fabric" });
    const before = (await deps.auditAnchors.list(assetId)).length;

    const res = await app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(admin), payload: {} });
    expect(res.statusCode).toBe(200);
    const refused = res.json().refused.find((r: { assetId: string }) => r.assetId === assetId);
    expect(refused, "a mismatched head must be reported, not silently re-anchored").toBeTruthy();
    expect(refused.reason).toBe("ANCHOR_MISMATCH");
    expect(res.json().anchored.some((a: { assetId: string }) => a.assetId === assetId)).toBe(false);

    // The crucial part: NO new attestation was written. Recording one would be
    // an on-chain statement that the rewritten history is genuine.
    expect(await deps.auditAnchors.list(assetId).then((l) => l.length)).toBe(before);
    expect((await verify(app, admin, assetId)).anchorConsistent, "still detected as tampered").toBe(false);
  });
});
