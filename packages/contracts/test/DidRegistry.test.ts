import { expect } from "chai";
import { ethers } from "hardhat";
import { DidRegistry } from "../typechain-types";

const DID_A = "did:key:z6MkeqcuLAoB1zBoExampleAAAA";
const DID_B = "did:key:z6MkeqcuLAoB1zBoExampleBBBB";

async function deploy(): Promise<DidRegistry> {
  const Factory = await ethers.getContractFactory("DidRegistry");
  const r = await Factory.deploy();
  await r.waitForDeployment();
  return r as unknown as DidRegistry;
}

describe("DidRegistry", () => {
  it("registers an org DID and reports it active", async () => {
    const r = await deploy();
    await r.registerDid(DID_A);
    expect(await r.isActive(DID_A)).to.equal(true);
    const rec = await r.resolve(DID_A);
    expect(rec.did).to.equal(DID_A);
    expect(rec.active).to.equal(true);
    expect(rec.registeredAt).to.be.greaterThan(0n);
    expect(rec.deactivatedAt).to.equal(0n);
  });

  it("reports an unregistered DID as inactive", async () => {
    const r = await deploy();
    expect(await r.isActive(DID_B)).to.equal(false);
    expect((await r.resolve(DID_B)).registeredAt).to.equal(0n);
  });

  it("deactivates — the one thing did:key cannot express", async () => {
    const r = await deploy();
    await r.registerDid(DID_A);
    await r.deactivateDid(DID_A);
    expect(await r.isActive(DID_A)).to.equal(false);
    const rec = await r.resolve(DID_A);
    expect(rec.active).to.equal(false);
    expect(rec.deactivatedAt).to.be.greaterThan(0n);
    expect(rec.did).to.equal(DID_A); // the record survives; it is deactivated, not deleted
  });

  it("is an enumerable trust list", async () => {
    const r = await deploy();
    await r.registerDid(DID_A);
    await r.registerDid(DID_B);
    expect(await r.count()).to.equal(2n);
    // didAt returns the keccak256 KEY, so resolve by hash (resolve() takes the string).
    expect((await r.resolveByHash(await r.didAt(0))).did).to.equal(DID_A);
    expect((await r.resolveByHash(await r.didAt(1))).did).to.equal(DID_B);
  });

  it("rejects duplicate registration and unknown deactivation", async () => {
    const r = await deploy();
    await r.registerDid(DID_A);
    await expect(r.registerDid(DID_A)).to.be.revertedWithCustomError(r, "AlreadyRegistered");
    await expect(r.deactivateDid(DID_B)).to.be.revertedWithCustomError(r, "NotRegistered");
    await r.deactivateDid(DID_A);
    await expect(r.deactivateDid(DID_A)).to.be.revertedWithCustomError(r, "NotRegistered");
  });

  it("only the operator may register or deactivate — no DID squatting", async () => {
    const [, stranger] = await ethers.getSigners();
    const r = await deploy();
    await expect(r.connect(stranger).registerDid(DID_A)).to.be.revertedWithCustomError(r, "NotOperator");
    await r.registerDid(DID_A);
    await expect(r.connect(stranger).deactivateDid(DID_A)).to.be.revertedWithCustomError(r, "NotOperator");
  });

  it("emits events", async () => {
    const r = await deploy();
    await expect(r.registerDid(DID_A)).to.emit(r, "DidRegistered").withArgs(ethers.id(DID_A), DID_A);
    await expect(r.deactivateDid(DID_A)).to.emit(r, "DidDeactivated");
  });
});
