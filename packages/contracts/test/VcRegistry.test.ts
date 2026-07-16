import { expect } from "chai";
import { ethers } from "hardhat";
import { VcRegistry } from "../typechain-types";

const ID = ethers.id("cred-1");        // keccak256 of the credential id
const HASH = ethers.id("a.b.c");       // keccak256 of the VC-JWT
const ISSUED = 1_800_000_000n;
const EXPIRES = 1_800_000_000n + 31_536_000n;

async function deploy(): Promise<VcRegistry> {
  const Factory = await ethers.getContractFactory("VcRegistry");
  const r = await Factory.deploy();
  await r.waitForDeployment();
  return r as unknown as VcRegistry;
}

describe("VcRegistry", () => {
  it("anchors a commitment and reports its status", async () => {
    const r = await deploy();
    await r.anchor(ID, HASH, ISSUED, EXPIRES);
    const s = await r.statusOf(ID);
    expect(s.exists).to.equal(true);
    expect(s.revoked).to.equal(false);
    expect(s.vcHash).to.equal(HASH);
    expect(s.issuedAt).to.equal(ISSUED);
    expect(s.expiresAt).to.equal(EXPIRES);
    expect(s.revokedAt).to.equal(0n);
  });

  it("reports exists=false for an unknown id — an absent record is NOT a negative revocation", async () => {
    const r = await deploy();
    const s = await r.statusOf(ethers.id("never-anchored"));
    expect(s.exists).to.equal(false);
    expect(s.revoked).to.equal(false); // callers MUST branch on `exists`, not on `revoked`
    expect(s.vcHash).to.equal(ethers.ZeroHash);
  });

  it("revokes and timestamps", async () => {
    const r = await deploy();
    await r.anchor(ID, HASH, ISSUED, EXPIRES);
    await r.revoke(ID);
    const s = await r.statusOf(ID);
    expect(s.revoked).to.equal(true);
    expect(s.revokedAt).to.be.greaterThan(0n);
  });

  it("rejects a duplicate anchor", async () => {
    const r = await deploy();
    await r.anchor(ID, HASH, ISSUED, EXPIRES);
    await expect(r.anchor(ID, HASH, ISSUED, EXPIRES)).to.be.revertedWithCustomError(r, "AlreadyAnchored");
  });

  it("rejects revoking an unknown or already-revoked credential", async () => {
    const r = await deploy();
    await expect(r.revoke(ID)).to.be.revertedWithCustomError(r, "NotAnchored");
    await r.anchor(ID, HASH, ISSUED, EXPIRES);
    await r.revoke(ID);
    await expect(r.revoke(ID)).to.be.revertedWithCustomError(r, "AlreadyRevoked");
  });

  it("only the operator may anchor or revoke", async () => {
    const [, stranger] = await ethers.getSigners();
    const r = await deploy();
    await expect(r.connect(stranger).anchor(ID, HASH, ISSUED, EXPIRES)).to.be.revertedWithCustomError(r, "NotOperator");
    await r.anchor(ID, HASH, ISSUED, EXPIRES);
    await expect(r.connect(stranger).revoke(ID)).to.be.revertedWithCustomError(r, "NotOperator");
  });

  it("emits events", async () => {
    const r = await deploy();
    await expect(r.anchor(ID, HASH, ISSUED, EXPIRES)).to.emit(r, "VcAnchored").withArgs(ID, HASH);
    await expect(r.revoke(ID)).to.emit(r, "VcRevoked");
  });
});
