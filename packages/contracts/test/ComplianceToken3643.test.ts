import { expect } from "chai";
import { ethers } from "hardhat";
import { ComplianceToken3643 } from "../typechain-types";

async function deploy(): Promise<ComplianceToken3643> {
  const Factory = await ethers.getContractFactory("ComplianceToken3643");
  const token = await Factory.deploy("Security", "SEC", true);
  await token.waitForDeployment();
  return token as unknown as ComplianceToken3643;
}

describe("ComplianceToken3643", () => {
  it("requires identity registration (allowlist) for every holder", async () => {
    const [, alice] = await ethers.getSigners();
    const token = await deploy();
    expect(await token.allowlistEnabled()).to.equal(true);
    await expect(token.mint(alice.address, 100)).to.be.revertedWithCustomError(token, "NotAllowlisted");
    await token.setAllowed(alice.address, true);
    await token.mint(alice.address, 100);
    expect(await token.balanceOf(alice.address)).to.equal(100n);
  });

  it("blocks transfers to unregistered or frozen accounts", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy();
    await token.setAllowed(alice.address, true);
    await token.mint(alice.address, 100);
    await expect(token.transfer(alice.address, bob.address, 10)).to.be.revertedWithCustomError(token, "NotAllowlisted");
    await token.setAllowed(bob.address, true);
    await token.setFrozen(alice.address, true);
    await expect(token.transfer(alice.address, bob.address, 10)).to.be.revertedWithCustomError(token, "AccountFrozen");
  });

  it("supports operator forced transfer for recovery (bypasses freeze)", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy();
    await token.setAllowed(alice.address, true);
    await token.setAllowed(bob.address, true);
    await token.mint(alice.address, 100);
    await token.setFrozen(alice.address, true);
    await token.forcedTransfer(alice.address, bob.address, 40);
    expect(await token.balanceOf(bob.address)).to.equal(40n);
  });

  // Same whole-unit convention as ComplianceToken — see the note there.
  it("declares itself indivisible (decimals 0)", async () => {
    const token = await deploy();
    expect(await token.decimals()).to.equal(0n);
  });

  it("displays balances as the whole quantity the platform issued", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy();
    await token.setAllowed(alice.address, true);
    await token.setAllowed(bob.address, true);
    await token.mint(alice.address, 1000);
    await token.transfer(alice.address, bob.address, 250);

    const decimals = await token.decimals();
    expect(ethers.formatUnits(await token.balanceOf(alice.address), decimals)).to.equal("750");
    expect(ethers.formatUnits(await token.balanceOf(bob.address), decimals)).to.equal("250");
    expect(ethers.formatUnits(await token.totalSupply(), decimals)).to.equal("1000");
  });
});
