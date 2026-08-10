import { expect } from "chai";
import { ethers } from "hardhat";
import { ComplianceToken } from "../typechain-types";

async function deploy(allowlistEnabled: boolean): Promise<ComplianceToken> {
  const Factory = await ethers.getContractFactory("ComplianceToken");
  const token = await Factory.deploy("Demo", "DEMO", allowlistEnabled);
  await token.waitForDeployment();
  return token as unknown as ComplianceToken;
}

describe("ComplianceToken", () => {
  it("mints and tracks balances + supply", async () => {
    const [, alice] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 1000);
    expect(await token.balanceOf(alice.address)).to.equal(1000n);
    expect(await token.totalSupply()).to.equal(1000n);
  });

  it("moves tokens between accounts", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 1000);
    await token.transfer(alice.address, bob.address, 400);
    expect(await token.balanceOf(alice.address)).to.equal(600n);
    expect(await token.balanceOf(bob.address)).to.equal(400n);
  });

  it("burns and reduces supply", async () => {
    const [, alice] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 1000);
    await token.burn(alice.address, 250);
    expect(await token.totalSupply()).to.equal(750n);
  });

  it("reverts transfers over balance", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 100);
    await expect(token.transfer(alice.address, bob.address, 101)).to.be.revertedWithCustomError(
      token,
      "InsufficientBalance",
    );
  });

  it("blocks transfers from a frozen account", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 100);
    await token.setFrozen(alice.address, true);
    expect(await token.isFrozen(alice.address)).to.equal(true);
    await expect(token.transfer(alice.address, bob.address, 10)).to.be.revertedWithCustomError(token, "AccountFrozen");
    await token.setFrozen(alice.address, false);
    await token.transfer(alice.address, bob.address, 10);
    expect(await token.balanceOf(bob.address)).to.equal(10n);
  });

  it("enforces the allowlist when enabled", async () => {
    const [, alice, carol] = await ethers.getSigners();
    const token = await deploy(true);
    await expect(token.mint(alice.address, 100)).to.be.revertedWithCustomError(token, "NotAllowlisted");
    await token.setAllowed(alice.address, true);
    await token.mint(alice.address, 100);
    await expect(token.transfer(alice.address, carol.address, 10)).to.be.revertedWithCustomError(token, "NotAllowlisted");
    await token.setAllowed(carol.address, true);
    await token.transfer(alice.address, carol.address, 10);
    expect(await token.balanceOf(carol.address)).to.equal(10n);
  });

  it("only the operator can mutate state", async () => {
    const [, alice] = await ethers.getSigners();
    const token = await deploy(false);
    await expect(token.connect(alice).mint(alice.address, 100)).to.be.revertedWithCustomError(token, "NotOperator");
  });

  // The platform mints whole units — an initialSupply of "1000" is 1000 units,
  // not 1000 × 10^18 — so the token must declare itself indivisible. With
  // decimals() == 0 a wallet, explorer or formatUnits() renders exactly the
  // quantity the platform accounts for.
  it("declares itself indivisible (decimals 0)", async () => {
    const token = await deploy(false);
    expect(await token.decimals()).to.equal(0n);
  });

  it("displays balances as the whole quantity the platform issued", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const token = await deploy(false);
    await token.mint(alice.address, 1000);
    await token.transfer(alice.address, bob.address, 250);

    const decimals = await token.decimals();
    expect(ethers.formatUnits(await token.balanceOf(alice.address), decimals)).to.equal("750");
    expect(ethers.formatUnits(await token.balanceOf(bob.address), decimals)).to.equal("250");
    expect(ethers.formatUnits(await token.totalSupply(), decimals)).to.equal("1000");
  });
});
