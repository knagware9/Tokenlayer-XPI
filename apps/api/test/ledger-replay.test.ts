import { describe, it, expect } from "vitest";
import { V1, loginAs, auth, buildTestAppWithRepos, onboardUser, approveAssetForTest } from "./helpers.js";
import { rehydrateSimulatedLedgers } from "../src/tokenization/ledger-replay.js";

const INVESTOR_WALLET = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded account, unlinked
const inv = (n: string) => ({ invoiceNumber: n, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" });

describe("rehydrateSimulatedLedgers — surviving a simulated-chain restart", () => {
  it("restores totalSupply, balances, and allow/freeze after the contract is redeployed (wiped) under it", async () => {
    const { app, deps } = await buildTestAppWithRepos();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    // Issued by the platform (not m1.admin, the invoice desk's own
    // UseCaseAdmin) so m1.admin remains free to DECIDE this asset's
    // due-diligence review below — review-decision refuses a creator
    // deciding their own asset.
    const issued = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: { useCaseKey: "invoice-tokenization", name: "REPLAY-1", chainId: "fabric", initialSupply: "1000", metadata: inv("REPLAY-1"), sale: { unitPrice: "100", currency: "CBDC-INR" } },
    });
    expect(issued.statusCode).toBe(202);
    const assetId = issued.json().asset.id as string;
    await approveAssetForTest(app, assetId, "invoice-tokenization");
    const asset = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();

    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/freeze`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/unfreeze`, headers: auth(admin), payload: { account: INVESTOR_WALLET } }); // exercise + then undo, so it's not still frozen
    await onboardUser(app, admin, platform, { email: "inv.replay@x.dev", password: "secret1", role: "Buyer", walletAddress: INVESTOR_WALLET, kyc: { legalName: "Inv Replay", country: "IN" } });
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: INVESTOR_WALLET, currency: "CBDC-INR", amount: "100000" } });
    const investorToken = await loginAs(app, "inv.replay@x.dev", "secret1");
    const buy = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(investorToken), payload: { quantity: "150" } });
    expect(buy.statusCode).toBe(200);

    // Baseline, before any wipe.
    const before = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(before.totalSupply).toBe("1000");
    const accountsBefore = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(admin) })).json();
    const investorRowBefore = accountsBefore.find((a: { address: string }) => a.address.toLowerCase() === INVESTOR_WALLET.toLowerCase());
    expect(investorRowBefore.balance).toBe("150");
    expect(investorRowBefore.allowed).toBe(true);
    expect(investorRowBefore.frozen).toBe(false);

    // Simulate the exact effect of a process restart: seedUseCases re-deploys
    // every simulated-chain use case contract on boot, which wipes the
    // in-memory ledger's balances/supply/compliance state for that contractRef
    // back to empty — the DB rows (asset, audit) are completely untouched.
    const useCaseDef = await deps.useCases.get("invoice-tokenization");
    await deps.engine.deployUseCaseContract(useCaseDef, "fabric");

    // Sanity-check the wipe on the RAW LEDGER directly, bypassing the API: its
    // totalSupply/accounts fields are folded from the audit log (untouched by
    // this wipe, on purpose — see assetStateOf), so they would not show it.
    const ref = { id: assetId, chainId: asset.chainId, contractRef: asset.contractRef };
    const wipedAdapter = deps.chains.resolveAdapter("fabric");
    expect(await wipedAdapter.totalSupply(ref)).toBe("0");
    expect(await wipedAdapter.balanceOf(ref, INVESTOR_WALLET)).toBe("0");
    // The API layer stays correct straight through the wipe — it never observed it.
    const duringWipe = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(duringWipe.totalSupply).toBe("1000");

    const result = await rehydrateSimulatedLedgers(deps);
    expect(result.contracts).toBeGreaterThan(0);

    const after = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}`, headers: auth(admin) })).json();
    expect(after.totalSupply).toBe("1000");
    const accountsAfter = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/accounts`, headers: auth(admin) })).json();
    const investorRowAfter = accountsAfter.find((a: { address: string }) => a.address.toLowerCase() === INVESTOR_WALLET.toLowerCase());
    expect(investorRowAfter.balance).toBe("150");
    expect(investorRowAfter.allowed).toBe(true); // allow survived the freeze/unfreeze round-trip
    expect(investorRowAfter.frozen).toBe(false); // unfreeze was the last compliance event, not freeze

    // The Buyer can transact again post-replay — proves the restored state is
    // live ledger state, not just a read-only illusion at the API layer.
    const sell = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/transfer`, headers: auth(admin), payload: { from: INVESTOR_WALLET, to: asset.treasuryAccount, amount: "10" } });
    expect(sell.statusCode).toBe(200);
  });

  it("is a no-op when no asset has been issued yet", async () => {
    // seedUseCases seeds use-case DEFINITIONS at boot, not Asset rows — no
    // `POST /assets` has run in this fresh app, so there is nothing to group.
    const { deps } = await buildTestAppWithRepos();
    const result = await rehydrateSimulatedLedgers(deps);
    expect(result).toEqual({ contracts: 0, entries: 0 });
  });
});
