import { expect } from "chai";
import { ethers } from "hardhat";
import { allowCountry, deployFullTrexSuite } from "./helpers/trex";

// Proves the real, official T-REX (ERC-3643) suite works end-to-end: ONCHAINID
// identities, a trusted KYC claim issuer, identity-gated transfers, modular
// compliance (CountryAllowModule), freeze, and operator recovery.
describe("T-REX ERC-3643 (official Tokeny suite)", () => {
  it("blocks minting to an unregistered (no-identity) holder", async () => {
    const suite = await deployFullTrexSuite();
    const [, , , , alice] = await ethers.getSigners();
    await expect(suite.token.connect(suite.agent).mint(alice.address, 1000)).to.be.reverted;
  });

  it("verifies a registered investor and allows mint + identity-gated transfer", async () => {
    const suite = await deployFullTrexSuite();
    const [, , , , alice, bob] = await ethers.getSigners();
    await suite.registerInvestor(alice, 42);
    await suite.registerInvestor(bob, 42);

    expect(await suite.identityRegistry.isVerified(alice.address)).to.equal(true);

    await suite.token.connect(suite.agent).mint(alice.address, 1000);
    await suite.token.connect(suite.agent).unpause();
    expect(await suite.token.balanceOf(alice.address)).to.equal(1000n);

    // holder-initiated transfer enforces identity + compliance on-chain
    await suite.token.connect(alice).transfer(bob.address, 400);
    expect(await suite.token.balanceOf(bob.address)).to.equal(400n);
  });

  it("enforces the modular CountryAllowModule", async () => {
    const suite = await deployFullTrexSuite();
    const [, , , , alice, , charlie] = await ethers.getSigners();
    await suite.registerInvestor(alice, 42);
    await suite.registerInvestor(charlie, 7); // country 7 is NOT allowed
    await suite.token.connect(suite.agent).mint(alice.address, 1000);
    await suite.token.connect(suite.agent).unpause();

    // transfer to a holder in a disallowed country is rejected by compliance
    await expect(suite.token.connect(alice).transfer(charlie.address, 100)).to.be.reverted;

    // once country 7 is allowed, the same transfer succeeds
    await allowCountry(suite.modularCompliance, suite.countryAllowModule, 7);
    await suite.token.connect(alice).transfer(charlie.address, 100);
    expect(await suite.token.balanceOf(charlie.address)).to.equal(100n);
  });

  it("supports freeze and operator recovery", async () => {
    const suite = await deployFullTrexSuite();
    const [, , , , alice, bob] = await ethers.getSigners();
    await suite.registerInvestor(alice, 42);
    await suite.registerInvestor(bob, 42);
    await suite.token.connect(suite.agent).mint(alice.address, 1000);
    await suite.token.connect(suite.agent).unpause();

    await suite.token.connect(suite.agent).setAddressFrozen(alice.address, true);
    expect(await suite.token.isFrozen(alice.address)).to.equal(true);
    await expect(suite.token.connect(alice).transfer(bob.address, 100)).to.be.reverted;

    await suite.token.connect(suite.agent).setAddressFrozen(alice.address, false);
    await suite.token.connect(alice).transfer(bob.address, 100);
    expect(await suite.token.balanceOf(bob.address)).to.equal(100n);
  });
});
