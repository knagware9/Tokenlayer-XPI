import { expect } from "chai";
import { ethers } from "hardhat";
import { ComplianceNFT } from "../typechain-types";

async function deploy(allowlistEnabled: boolean): Promise<ComplianceNFT> {
  const Factory = await ethers.getContractFactory("ComplianceNFT");
  const token = await Factory.deploy("Cert", "CERT", allowlistEnabled);
  await token.waitForDeployment();
  return token as unknown as ComplianceNFT;
}

describe("ComplianceNFT", () => {
  it("mints, tracks owner + supply, and enumerates", async () => {
    const [, alice] = await ethers.getSigners();
    const nft = await deploy(false);
    await nft.mintToken(alice.address, 1, "ipfs://one");
    expect(await nft.ownerOf(1)).to.equal(alice.address);
    expect(await nft.totalSupply()).to.equal(1n);
    expect(await nft.balanceOf(alice.address)).to.equal(1n);
    expect((await nft.tokensOf(alice.address)).map((t) => Number(t))).to.deep.equal([1]);
  });

  it("transfers and burns by token id", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const nft = await deploy(false);
    await nft.mintToken(alice.address, 1, "");
    await nft.transferToken(alice.address, bob.address, 1);
    expect(await nft.ownerOf(1)).to.equal(bob.address);
    expect(await nft.balanceOf(alice.address)).to.equal(0n);
    await nft.burnToken(1);
    expect(await nft.ownerOf(1)).to.equal(ethers.ZeroAddress);
    expect(await nft.totalSupply()).to.equal(0n);
  });

  it("rejects transferring a token the sender does not own", async () => {
    const [, alice, bob, carol] = await ethers.getSigners();
    const nft = await deploy(false);
    await nft.mintToken(alice.address, 7, "");
    await expect(nft.transferToken(bob.address, carol.address, 7)).to.be.revertedWithCustomError(nft, "NotOwner");
  });

  it("blocks transfers from a frozen account", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const nft = await deploy(false);
    await nft.mintToken(alice.address, 1, "");
    await nft.setFrozen(alice.address, true);
    await expect(nft.transferToken(alice.address, bob.address, 1)).to.be.revertedWithCustomError(nft, "AccountFrozen");
  });

  it("enforces the allowlist when enabled", async () => {
    const [, alice] = await ethers.getSigners();
    const nft = await deploy(true);
    await expect(nft.mintToken(alice.address, 1, "")).to.be.revertedWithCustomError(nft, "NotAllowlisted");
    await nft.setAllowed(alice.address, true);
    await nft.mintToken(alice.address, 1, "");
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it("only the operator can mutate state", async () => {
    const [, alice] = await ethers.getSigners();
    const nft = await deploy(false);
    await expect(nft.connect(alice).mintToken(alice.address, 1, "")).to.be.revertedWithCustomError(nft, "NotOperator");
  });
});
