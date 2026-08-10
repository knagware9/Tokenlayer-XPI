import { AbiCoder, Contract, ContractFactory, getBytes, keccak256, toUtf8Bytes, ZeroAddress, type Signer, type Wallet } from "ethers";
import type { Artifact } from "./artifacts.js";

const KYC_TOPIC = 1n;
const SCHEME_ECDSA = 1;
const PURPOSE_CLAIM = 3;
const KEYTYPE_ECDSA = 1;
const DEFAULT_COUNTRY = 42;

/** Addresses of one deployed T-REX suite (one per ERC-3643 asset). */
export interface TrexSuiteRefs {
  token: string;
  identityRegistry: string;
  idFactory: string;
  claimIssuer: string;
  modularCompliance: string;
  countryAllowModule: string;
}

interface TxResponse {
  hash: string;
  wait: () => Promise<unknown>;
}

/**
 * Deploys and operates a full, official T-REX (ERC-3643) suite with a single
 * operator wallet that plays every privileged role (agent, identity-factory
 * owner, trusted claim issuer, and management key on each investor identity).
 *
 * Every transaction draws an explicit nonce from the host adapter's shared
 * counter (reserve via `nextNonce`, confirm via `bumpNonce`) so a long deploy
 * stream and the surrounding ERC-20/721 operations never collide on nonces.
 */
export class TrexManager {
  private readonly abi = AbiCoder.defaultAbiCoder();

  /**
   * @param signer the NonceManager-wrapped signer that owns nonce assignment
   * @param wallet the underlying operator wallet, for its address + claim signing
   * @param gasOverrides per-tx gas overrides (the signer owns the nonce)
   */
  constructor(
    private readonly signer: Signer,
    private readonly wallet: Wallet,
    private readonly gasOverrides: () => Record<string, unknown>,
    private readonly artifacts: Record<string, Artifact>,
  ) {}

  /** Send a contract transaction; the signer assigns the nonce. */
  private async tx(call: (overrides: Record<string, unknown>) => Promise<TxResponse>): Promise<TxResponse> {
    const response = await call(this.gasOverrides());
    await response.wait();
    return response;
  }

  // Vendor contracts have dynamic ABIs; `any` keeps the call sites readable.
  private async deploy(name: string, ...args: unknown[]): Promise<any> {
    const a = this.artifacts[name];
    if (!a) throw new Error(`trex: missing artifact '${name}'`);
    const factory = new ContractFactory(a.abi, a.bytecode, this.signer);
    const contract = await factory.deploy(...(args as never[]), this.gasOverrides());
    await contract.waitForDeployment();
    return contract;
  }

  private at(name: string, address: string): any {
    return new Contract(address, this.artifacts[name]!.abi, this.signer);
  }

  /** Stands up a fresh suite and returns its addresses. The token starts unpaused. */
  async deploySuite(name: string, symbol: string): Promise<TrexSuiteRefs> {
    const op = this.wallet.address;

    const identityImpl = await this.deploy("Identity", op, true);
    const oidIA = await this.deploy("OidImplementationAuthority", await identityImpl.getAddress());
    const idFactory = await this.deploy("IdFactory", await oidIA.getAddress());

    const impls = {
      tokenImplementation: await (await this.deploy("Token")).getAddress(),
      ctrImplementation: await (await this.deploy("ClaimTopicsRegistry")).getAddress(),
      irImplementation: await (await this.deploy("IdentityRegistry")).getAddress(),
      irsImplementation: await (await this.deploy("IdentityRegistryStorage")).getAddress(),
      tirImplementation: await (await this.deploy("TrustedIssuersRegistry")).getAddress(),
      mcImplementation: await (await this.deploy("ModularCompliance")).getAddress(),
    };
    const trexIA = await this.deploy("TREXImplementationAuthority", true, ZeroAddress, ZeroAddress);
    await this.tx((ov) => trexIA.addAndUseTREXVersion({ major: 4, minor: 0, patch: 0 }, impls, ov));
    const iaAddr = await trexIA.getAddress();

    const ctr = this.at("ClaimTopicsRegistry", await (await this.deploy("ClaimTopicsRegistryProxy", iaAddr)).getAddress());
    const tir = this.at("TrustedIssuersRegistry", await (await this.deploy("TrustedIssuersRegistryProxy", iaAddr)).getAddress());
    const irs = this.at("IdentityRegistryStorage", await (await this.deploy("IdentityRegistryStorageProxy", iaAddr)).getAddress());
    const mc = this.at("ModularCompliance", await (await this.deploy("ModularComplianceProxy", iaAddr)).getAddress());
    const ir = this.at(
      "IdentityRegistry",
      await (await this.deploy("IdentityRegistryProxy", iaAddr, await tir.getAddress(), await ctr.getAddress(), await irs.getAddress())).getAddress(),
    );
    const token = this.at(
      "Token",
      // 0 decimals: the platform mints and accounts in whole units, so a wallet
      // or explorer renders exactly the quantity the platform issued.
      await (await this.deploy("TokenProxy", iaAddr, await ir.getAddress(), await mc.getAddress(), name, symbol, 0, ZeroAddress)).getAddress(),
    );

    const irAddr = await ir.getAddress();
    await this.tx((ov) => irs.bindIdentityRegistry(irAddr, ov));
    await this.tx((ov) => token.addAgent(op, ov));
    await this.tx((ov) => ir.addAgent(op, ov));

    await this.tx((ov) => ctr.addClaimTopic(KYC_TOPIC, ov));
    const claimIssuer = await this.deploy("ClaimIssuer", op);
    const claimIssuerAddr = await claimIssuer.getAddress();
    await this.tx((ov) => claimIssuer.addKey(keccak256(this.abi.encode(["address"], [op])), PURPOSE_CLAIM, KEYTYPE_ECDSA, ov));
    await this.tx((ov) => tir.addTrustedIssuer(claimIssuerAddr, [KYC_TOPIC], ov));

    const countryAllowModule = await this.deploy("CountryAllowModule");
    const moduleAddr = await countryAllowModule.getAddress();
    await this.tx((ov) => countryAllowModule.initialize(ov));
    await this.tx((ov) => mc.addModule(moduleAddr, ov));
    const allowData = countryAllowModule.interface.encodeFunctionData("batchAllowCountries", [[DEFAULT_COUNTRY]]);
    await this.tx((ov) => mc.callModuleFunction(allowData, moduleAddr, ov));

    await this.tx((ov) => token.unpause(ov));

    return {
      token: await token.getAddress(),
      identityRegistry: irAddr,
      idFactory: await idFactory.getAddress(),
      claimIssuer: claimIssuerAddr,
      modularCompliance: await mc.getAddress(),
      countryAllowModule: moduleAddr,
    };
  }

  /** Onboards an investor: ONCHAINID identity (operator-controlled) + KYC claim + registry entry. */
  async registerInvestor(refs: TrexSuiteRefs, account: string, country = DEFAULT_COUNTRY): Promise<{ identity: string; txHash: string }> {
    if (refs.idFactory === ZeroAddress) {
      throw new Error("trex: full suite not loaded (idFactory unknown); issue ERC-3643 assets within one session");
    }
    const op = this.wallet.address;
    const idFactory = this.at("IdFactory", refs.idFactory);
    const ir = this.at("IdentityRegistry", refs.identityRegistry);

    let identityAddr = (await idFactory.getIdentity(account)) as string;
    if (identityAddr === ZeroAddress) {
      // ONCHAINID management keys are keccak256(address), not raw addresses.
      const opKeyHash = keccak256(this.abi.encode(["address"], [op]));
      await this.tx((ov) => idFactory.createIdentityWithManagementKeys(account, `tl-${account}`, [opKeyHash], ov));
      identityAddr = (await idFactory.getIdentity(account)) as string;
    }

    const identity = this.at("Identity", identityAddr);
    const claimData = toUtf8Bytes("KYC approved");
    const dataHash = keccak256(this.abi.encode(["address", "uint256", "bytes"], [identityAddr, KYC_TOPIC, claimData]));
    const signature = await this.wallet.signMessage(getBytes(dataHash));
    const claimTx = await this.tx((ov) => identity.addClaim(KYC_TOPIC, SCHEME_ECDSA, refs.claimIssuer, signature, claimData, "", ov));

    let txHash = claimTx.hash;
    if (!(await ir.contains(account))) {
      const reg = await this.tx((ov) => ir.registerIdentity(account, identityAddr, country, ov));
      txHash = reg.hash;
    }
    return { identity: identityAddr, txHash };
  }

  async removeInvestor(refs: TrexSuiteRefs, account: string): Promise<string> {
    const ir = this.at("IdentityRegistry", refs.identityRegistry);
    if (await ir.contains(account)) {
      const tx = await this.tx((ov) => ir.deleteIdentity(account, ov));
      return tx.hash;
    }
    return "";
  }

  async isVerified(refs: TrexSuiteRefs, account: string): Promise<boolean> {
    return this.at("IdentityRegistry", refs.identityRegistry).isVerified(account);
  }

  token(refs: TrexSuiteRefs): any {
    return this.at("Token", refs.token);
  }
}
