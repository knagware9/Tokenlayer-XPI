import { ethers } from "hardhat";

/** Deploys a sample ComplianceToken to the configured network for manual poking. */
async function main(): Promise<void> {
  const Factory = await ethers.getContractFactory("ComplianceToken");
  const token = await Factory.deploy("Sample", "SMPL", true);
  await token.waitForDeployment();
  console.log("ComplianceToken deployed at:", await token.getAddress());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
