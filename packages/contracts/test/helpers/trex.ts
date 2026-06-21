import { ethers } from "hardhat";
import type { Signer } from "ethers";

/**
 * Deploys a full, canonical T-REX (ERC-3643) suite using the official Tokeny +
 * ONCHAINID contracts, replicating Tokeny's deploy-full-suite fixture for
 * v4.1.6. Returns the live contracts plus helpers to onboard investors
 * (ONCHAINID identity + KYC claim + registry entry).
 */
export const KYC_TOPIC = 1n;
export const SCHEME_ECDSA = 1;
export const PURPOSE_CLAIM = 3;
export const KEYTYPE_ECDSA = 1;

export interface TrexSuite {
  token: any;
  identityRegistry: any;
  modularCompliance: any;
  claimTopicsRegistry: any;
  trustedIssuersRegistry: any;
  identityRegistryStorage: any;
  claimIssuer: any;
  idFactory: any;
  countryAllowModule: any;
  agent: Signer;
  registerInvestor: (wallet: Signer, country: number) => Promise<string>;
}

async function deploy(name: string, ...args: unknown[]): Promise<any> {
  const factory = await ethers.getContractFactory(name);
  const c = await factory.deploy(...(args as never[]));
  await c.waitForDeployment();
  return c;
}

export async function deployFullTrexSuite(): Promise<TrexSuite> {
  const [deployer, tokenAgent, claimIssuerOwner, claimSigningKey] = await ethers.getSigners();
  const abi = ethers.AbiCoder.defaultAbiCoder();

  // --- ONCHAINID infrastructure ---
  const identityImpl = await deploy("Identity", deployer.address, true);
  const idImplAuthority = await deploy("ImplementationAuthority", await identityImpl.getAddress());
  const idFactory = await deploy("IdFactory", await idImplAuthority.getAddress());

  // --- T-REX implementations ---
  const ctrImpl = await deploy("ClaimTopicsRegistry");
  const tirImpl = await deploy("TrustedIssuersRegistry");
  const irsImpl = await deploy("IdentityRegistryStorage");
  const irImpl = await deploy("IdentityRegistry");
  const mcImpl = await deploy("ModularCompliance");
  const tokenImpl = await deploy("Token");

  // --- T-REX implementation authority (reference) ---
  const trexIA = await deploy("TREXImplementationAuthority", true, ethers.ZeroAddress, ethers.ZeroAddress);
  await (
    await trexIA.addAndUseTREXVersion(
      { major: 4, minor: 0, patch: 0 },
      {
        tokenImplementation: await tokenImpl.getAddress(),
        ctrImplementation: await ctrImpl.getAddress(),
        irImplementation: await irImpl.getAddress(),
        irsImplementation: await irsImpl.getAddress(),
        tirImplementation: await tirImpl.getAddress(),
        mcImplementation: await mcImpl.getAddress(),
      },
    )
  ).wait();

  const iaAddr = await trexIA.getAddress();
  const at = async (name: string, addr: string): Promise<any> => (await ethers.getContractFactory(name)).attach(addr);

  // --- deploy proxies, then view them through the implementation ABI ---
  const ctr = await at("ClaimTopicsRegistry", await (await deploy("ClaimTopicsRegistryProxy", iaAddr)).getAddress());
  const tir = await at("TrustedIssuersRegistry", await (await deploy("TrustedIssuersRegistryProxy", iaAddr)).getAddress());
  const irs = await at("IdentityRegistryStorage", await (await deploy("IdentityRegistryStorageProxy", iaAddr)).getAddress());
  const mc = await at("ModularCompliance", await (await deploy("ModularComplianceProxy", iaAddr)).getAddress());
  const ir = await at(
    "IdentityRegistry",
    await (await deploy("IdentityRegistryProxy", iaAddr, await tir.getAddress(), await ctr.getAddress(), await irs.getAddress())).getAddress(),
  );
  const token = await at(
    "Token",
    await (
      await deploy("TokenProxy", iaAddr, await ir.getAddress(), await mc.getAddress(), "Acme Equity", "ACME", 18, ethers.ZeroAddress)
    ).getAddress(),
  );

  // --- wiring ---
  await (await irs.bindIdentityRegistry(await ir.getAddress())).wait();
  await (await token.addAgent(await tokenAgent.getAddress())).wait();
  await (await ir.addAgent(await tokenAgent.getAddress())).wait();

  // --- claim topics + trusted claim issuer ---
  await (await ctr.addClaimTopic(KYC_TOPIC)).wait();
  const claimIssuer = await deploy("ClaimIssuer", await claimIssuerOwner.getAddress());
  const signingKeyHash = ethers.keccak256(abi.encode(["address"], [await claimSigningKey.getAddress()]));
  await (await claimIssuer.connect(claimIssuerOwner).addKey(signingKeyHash, PURPOSE_CLAIM, KEYTYPE_ECDSA)).wait();
  await (await tir.addTrustedIssuer(await claimIssuer.getAddress(), [KYC_TOPIC])).wait();

  // --- modular compliance: a real CountryAllowModule ---
  const countryAllowModule = await deploy("CountryAllowModule");
  await (await countryAllowModule.initialize()).wait();
  await (await mc.addModule(await countryAllowModule.getAddress())).wait();

  // --- investor onboarding helper ---
  const registerInvestor = async (wallet: Signer, country: number): Promise<string> => {
    const walletAddr = await wallet.getAddress();
    await (await idFactory.createIdentity(walletAddr, `id-${walletAddr}`)).wait();
    const identityAddr = await idFactory.getIdentity(walletAddr);
    const identity = await at("Identity", identityAddr);

    const claimData = ethers.toUtf8Bytes("KYC approved");
    const dataHash = ethers.keccak256(abi.encode(["address", "uint256", "bytes"], [identityAddr, KYC_TOPIC, claimData]));
    const signature = await claimSigningKey.signMessage(ethers.getBytes(dataHash));
    await (
      await identity.connect(wallet).addClaim(KYC_TOPIC, SCHEME_ECDSA, await claimIssuer.getAddress(), signature, claimData, "")
    ).wait();

    await (await ir.connect(tokenAgent).registerIdentity(walletAddr, identityAddr, country)).wait();
    return identityAddr;
  };

  // allow the country we will register investors in
  await allowCountry(mc, countryAllowModule, 42);

  return {
    token,
    identityRegistry: ir,
    modularCompliance: mc,
    claimTopicsRegistry: ctr,
    trustedIssuersRegistry: tir,
    identityRegistryStorage: irs,
    claimIssuer,
    idFactory,
    countryAllowModule,
    agent: tokenAgent,
    registerInvestor,
  };
}

/** Allow a country code through the modular-compliance CountryAllowModule. */
export async function allowCountry(mc: any, module: any, country: number): Promise<void> {
  const data = module.interface.encodeFunctionData("batchAllowCountries", [[country]]);
  await (await mc.callModuleFunction(data, await module.getAddress())).wait();
}
