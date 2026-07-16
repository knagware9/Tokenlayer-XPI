# On-Chain DID/VC Registry + Revocation Anchoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make credential status verifiable independently of our API — commitments and revocation anchored on Besu, org DIDs registered on-chain, and the public status endpoint answering from chain state.

**Architecture:** Two `immutable operator`-guarded Solidity contracts store commitments only (`keccak256` hashes — never DIDs, types or claims for credentials). A `CredentialAnchor` capability interface, implemented by `EvmLedgerAdapter` and narrowed by a `supportsCredentialAnchor()` guard, keeps the EVM-only registry off the chain-agnostic `LedgerAdapter` seam. Anchoring is synchronous inside the maker-checker executor that is already all-or-nothing, so a failed anchor means no credential — no fire-and-forget, no reconciliation job. When Besu is absent the platform issues unanchored credentials and says so.

**Tech Stack:** Solidity 0.8.24 + Hardhat, ethers v6, TypeScript (ESM, NodeNext), Fastify, Prisma + SQLite, Vitest, React + Vite.

**Reference spec:** `docs/superpowers/specs/2026-07-16-onchain-registry-design.md`

---

## ⚠️ Three constraints this plan is built around

**1. The whole test suite runs with Besu ABSENT.** `buildTestApp` uses `buildChainRegistry({ CHAIN_STRICT: "0" })`, so there is no besu adapter in tests. **Unanchored is the default path**, and all 412 existing tests must stay green untouched. The anchored path is covered by a test double (Task 8) and by the live E2E (Task 10).

**2. An absent on-chain record is NOT a negative revocation.** The three-way status resolution (Task 7) is the heart of this sub-project. `statusOf().exists === false` means "this credential predates the registry" → fall back to the DB with `anchored: false`. Reading it as "chain says not-revoked" is the reference repo's `if (!hash) return true` bug, and it is the single most likely way to get this wrong.

**3. The contracts use the house idiom, not OpenZeppelin.** `ComplianceToken.sol` uses `address public immutable operator` + `error NotOperator()` + a modifier — it does **not** import OZ `Ownable`, even though OZ 4.8.3 is a devDependency. Match the house style.

---

## File Structure

**Create:**
- `packages/contracts/contracts/VcRegistry.sol` — credential commitments + revocation.
- `packages/contracts/contracts/DidRegistry.sol` — org parent DIDs + deactivation.
- `packages/contracts/test/VcRegistry.test.ts`, `packages/contracts/test/DidRegistry.test.ts`
- `packages/adapters/src/credential-anchor.ts` — the capability interface + guard.
- `apps/api/src/registry.ts` — boot deploy + `AppDeps.registry` resolution.
- `apps/api/test/onchain-registry.test.ts` — wiring tests via a test double.
- `apps/api/test/fake-anchor.ts` — the in-memory test double.
- `scripts/onchain-registry-e2e.mjs`

**Modify:** `packages/adapters/src/evm-adapter.ts` (implement the interface), `packages/adapters/src/index.ts` (export), `apps/api/prisma/schema.prisma` (+`RegistryDeployment`), `apps/api/src/persistence/{types,memory,prisma}.ts` (repo), `apps/api/src/env.ts` (+`registryChainId`), `apps/api/src/chains.ts` (registry artifacts), `apps/api/src/context.ts` (+`registry?`), `apps/api/src/server.ts` + `apps/api/test/helpers.ts` + the 5 harness scripts (wiring), `apps/api/src/keystore.ts` (type rename), `apps/api/src/credential-kinds.ts` (anchoring), `apps/api/src/http/{routes,schemas}.ts` (org registration + read paths), `apps/web/src/{types,api}.ts`, `apps/web/src/components/{NetworksPanel,Organizations,MyIdentity,CredentialsPanel}.tsx`.

---

## Task 1: VcRegistry.sol

**Files:**
- Create: `packages/contracts/contracts/VcRegistry.sol`
- Test: `packages/contracts/test/VcRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/VcRegistry.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/contracts exec hardhat test test/VcRegistry.test.ts`
Expected: FAIL — `HH700: Artifact for contract "VcRegistry" not found`.

- [ ] **Step 3: Write the contract**

Create `packages/contracts/contracts/VcRegistry.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VcRegistry
 * @notice Tamper-evidence and revocation status for Verifiable Credentials.
 *
 *         COMMITMENTS ONLY. This contract deliberately stores no DIDs, no
 *         credential types and no claims — only keccak256 commitments. An
 *         observer with RPC access learns that N credentials exist, when they
 *         were issued and expire, and which are revoked; nothing links a record
 *         to a person, an organization or a credential type. There is also no
 *         holder->credentials index: enumerating a subject's credentials is
 *         exactly the correlation surface this design exists to avoid.
 *
 *         The revocation REASON is intentionally not stored on-chain — it is
 *         free text and may be personal. It stays in the platform database.
 *
 *         The deploying platform address is the sole writer. Keys are custodial,
 *         so the platform already signs on every organization's behalf; a
 *         permissionless registry would let anyone anchor anything and would
 *         prove nothing. This contract therefore attests TAMPER-EVIDENCE AND
 *         STATUS. Issuer provenance is proved by the credential's own Ed25519
 *         signature, not by this registry.
 */
contract VcRegistry {
    struct VcRecord {
        bytes32 vcHash; // keccak256 of the VC-JWT string
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
        uint64 revokedAt;
        bool exists;
    }

    address public immutable operator;

    /// keccak256(credentialId) => record. Keyed by hash; ids are never stored in the clear.
    mapping(bytes32 => VcRecord) private _credentials;

    event VcAnchored(bytes32 indexed idHash, bytes32 vcHash);
    event VcRevoked(bytes32 indexed idHash, uint64 at);

    error NotOperator();
    error AlreadyAnchored();
    error NotAnchored();
    error AlreadyRevoked();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    function anchor(bytes32 idHash, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt) external onlyOperator {
        if (_credentials[idHash].exists) revert AlreadyAnchored();
        _credentials[idHash] = VcRecord({
            vcHash: vcHash,
            issuedAt: issuedAt,
            expiresAt: expiresAt,
            revoked: false,
            revokedAt: 0,
            exists: true
        });
        emit VcAnchored(idHash, vcHash);
    }

    function revoke(bytes32 idHash) external onlyOperator {
        VcRecord storage rec = _credentials[idHash];
        if (!rec.exists) revert NotAnchored();
        if (rec.revoked) revert AlreadyRevoked();
        rec.revoked = true;
        rec.revokedAt = uint64(block.timestamp);
        emit VcRevoked(idHash, rec.revokedAt);
    }

    /**
     * @notice Status of a commitment.
     * @dev Callers MUST branch on `exists`. A zeroed record returns
     *      `revoked: false` simply because that is the zero value — it is NOT an
     *      assertion that the credential is valid.
     */
    function statusOf(bytes32 idHash)
        external
        view
        returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)
    {
        VcRecord storage rec = _credentials[idHash];
        return (rec.exists, rec.revoked, rec.revokedAt, rec.vcHash, rec.issuedAt, rec.expiresAt);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tokenlayer/contracts exec hardhat test test/VcRegistry.test.ts`
Expected: PASS (7 tests). These run on hardhat's network — real EVM execution, not a mock.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/contracts/VcRegistry.sol packages/contracts/test/VcRegistry.test.ts
git commit -m "feat(contracts): VcRegistry — commitment-only credential anchoring + revocation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: DidRegistry.sol

**Files:**
- Create: `packages/contracts/contracts/DidRegistry.sol`
- Test: `packages/contracts/test/DidRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/DidRegistry.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/contracts exec hardhat test test/DidRegistry.test.ts`
Expected: FAIL — artifact for "DidRegistry" not found.

- [ ] **Step 3: Write the contract**

Create `packages/contracts/contracts/DidRegistry.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DidRegistry
 * @notice The on-chain trust list of ORGANIZATION parent DIDs.
 *
 *         SCOPE: organization DIDs only — never member sub-DIDs. An org's DID is
 *         already public (it is the `iss` of every credential that org signs), so
 *         registering it discloses nothing new. A member's sub-DID is personal and
 *         stays off-chain.
 *
 *         NO PUBLIC KEY IS STORED. Our DIDs are did:key — the public key IS the
 *         DID string, resolvable offline with no chain and no database. Storing it
 *         would be pure redundancy. What this registry adds is the two things a
 *         did:key cannot express by itself: DEACTIVATION of a compromised org DID,
 *         and an enumerable list of who is registered.
 *
 *         Enumeration is deliberate here: a trust list is meant to be listable.
 *         (Enumerating a HOLDER's credentials would be a privacy leak — see
 *         VcRegistry, which has no such index.)
 *
 *         The deploying platform address is the sole writer: keys are custodial,
 *         and a permissionless registry would allow permanent DID squatting.
 */
contract DidRegistry {
    struct DidRecord {
        string did;
        address controller;
        bool active;
        uint64 registeredAt;
        uint64 deactivatedAt;
    }

    address public immutable operator;

    /// keccak256(did) => record
    mapping(bytes32 => DidRecord) private _dids;
    bytes32[] private _index;

    event DidRegistered(bytes32 indexed didHash, string did);
    event DidDeactivated(bytes32 indexed didHash, uint64 at);

    error NotOperator();
    error AlreadyRegistered();
    error NotRegistered();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    function registerDid(string calldata did) external onlyOperator {
        bytes32 key = keccak256(bytes(did));
        if (_dids[key].registeredAt != 0) revert AlreadyRegistered();
        _dids[key] = DidRecord({
            did: did,
            controller: msg.sender,
            active: true,
            registeredAt: uint64(block.timestamp),
            deactivatedAt: 0
        });
        _index.push(key);
        emit DidRegistered(key, did);
    }

    /// @notice Deactivate a registered DID. The record survives — it is not deleted.
    function deactivateDid(string calldata did) external onlyOperator {
        bytes32 key = keccak256(bytes(did));
        DidRecord storage rec = _dids[key];
        if (rec.registeredAt == 0 || !rec.active) revert NotRegistered();
        rec.active = false;
        rec.deactivatedAt = uint64(block.timestamp);
        emit DidDeactivated(key, rec.deactivatedAt);
    }

    function isActive(string calldata did) external view returns (bool) {
        return _dids[keccak256(bytes(did))].active;
    }

    function resolve(string calldata did) external view returns (DidRecord memory) {
        return _dids[keccak256(bytes(did))];
    }

    function resolveByHash(bytes32 didHash) external view returns (DidRecord memory) {
        return _dids[didHash];
    }

    function count() external view returns (uint256) {
        return _index.length;
    }

    function didAt(uint256 i) external view returns (bytes32) {
        return _index[i];
    }
}
```

Note `resolveByHash` exists precisely because `didAt` returns the keccak256 key, not the DID string — the enumeration test needs it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tokenlayer/contracts exec hardhat test test/DidRegistry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the whole contracts suite (no regressions)**

Run: `pnpm --filter @tokenlayer/contracts test`
Expected: 20 existing + 14 new = 34 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/contracts/DidRegistry.sol packages/contracts/test/DidRegistry.test.ts
git commit -m "feat(contracts): DidRegistry — org DID trust list + deactivation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The CredentialAnchor capability

**Files:**
- Create: `packages/adapters/src/credential-anchor.ts`
- Modify: `packages/adapters/src/evm-adapter.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/test/credential-anchor.test.ts`

**Why a separate interface:** registries are EVM-only. Adding these methods to `LedgerAdapter` would force Fabric/Canton to implement what they cannot (their `anchor` already returns a synthetic receipt without transacting). The guard mirrors how `assertConnectivity` presence-detects `healthCheck`.

- [ ] **Step 1: Write the failing test**

Create `packages/adapters/test/credential-anchor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { supportsCredentialAnchor } from "../src/credential-anchor.js";

describe("supportsCredentialAnchor", () => {
  it("is false for an adapter without the capability", () => {
    expect(supportsCredentialAnchor({ chainId: "fabric", family: "fabric" } as never)).toBe(false);
  });

  it("is true only when every registry method is present", () => {
    const partial = { chainId: "besu", family: "evm", anchorCredential: () => {} };
    expect(supportsCredentialAnchor(partial as never)).toBe(false);
    const full = {
      chainId: "besu", family: "evm",
      deployRegistries: () => {}, registerDid: () => {}, deactivateDid: () => {}, didRegistration: () => {},
      anchorCredential: () => {}, revokeCredential: () => {}, credentialStatusOf: () => {},
    };
    expect(supportsCredentialAnchor(full as never)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/adapters exec vitest run test/credential-anchor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the interface**

Create `packages/adapters/src/credential-anchor.ts`:

```typescript
/**
 * The on-chain identity-registry capability. EVM-only, so it is NOT part of the
 * chain-agnostic LedgerAdapter seam — Fabric/Canton cannot implement it, and
 * forcing them to throw would make the seam dishonest. Adapters that can do this
 * implement it additionally; callers narrow with `supportsCredentialAnchor`.
 *
 * Hashing lives INSIDE the implementation: callers pass plain strings (a
 * credential id, a VC-JWT) and cannot get the commitment wrong.
 */
import type { LedgerAdapter, TxReceipt } from "@tokenlayer/core";

export interface DidRegistration {
  registered: boolean;
  active: boolean;
}

export interface OnChainCredentialStatus {
  /** FALSE means "no record" — NOT "not revoked". Callers must branch on this first. */
  exists: boolean;
  revoked: boolean;
  revokedAt: number | null;
  vcHash: string;
}

export interface CredentialAnchor {
  /** Deploy both registries; the operator becomes their sole writer. */
  deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }>;
  registerDid(registry: string, did: string): Promise<TxReceipt>;
  deactivateDid(registry: string, did: string): Promise<TxReceipt>;
  didRegistration(registry: string, did: string): Promise<DidRegistration>;
  anchorCredential(registry: string, credentialId: string, vcJwt: string, issuedAt: number, expiresAt: number): Promise<TxReceipt>;
  revokeCredential(registry: string, credentialId: string): Promise<TxReceipt>;
  credentialStatusOf(registry: string, credentialId: string): Promise<OnChainCredentialStatus>;
}

const METHODS = [
  "deployRegistries", "registerDid", "deactivateDid", "didRegistration",
  "anchorCredential", "revokeCredential", "credentialStatusOf",
] as const;

/** Narrowing guard — presence-detected, like assertConnectivity's healthCheck probe. */
export function supportsCredentialAnchor(a: LedgerAdapter): a is LedgerAdapter & CredentialAnchor {
  return METHODS.every((m) => typeof (a as unknown as Record<string, unknown>)[m] === "function");
}
```

- [ ] **Step 4: Implement it on the EVM adapter**

In `packages/adapters/src/evm-adapter.ts`:

(a) Add to the ethers import: `id` and `ZeroHash` (e.g. `import { Contract, ContractFactory, id, JsonRpcProvider, NonceManager, Wallet, ZeroHash, ... } from "ethers";` — match the file's real import list).
(b) Add to the type imports: `import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "./credential-anchor.js";`
(c) Add the optional artifacts field to `EvmAdapterConfig` (after `artifacts`):
```typescript
  /** Registry artifacts. Absent ⇒ the adapter does not advertise CredentialAnchor. */
  registryArtifacts?: { didRegistry: EvmArtifact; vcRegistry: EvmArtifact };
```
(d) Make the class declare the capability: `export class EvmLedgerAdapter implements LedgerAdapter, CredentialAnchor {` (match the real class declaration).
(e) Add these methods to the class. They reuse `this.serialize`, `this.signer` and `this.gasOverrides()` exactly as `deployAsset` does:
```typescript
  // --- CredentialAnchor (on-chain identity registries) ----------------------
  // Commitments are hashed HERE so no caller can get them wrong: keccak256 of the
  // credential id, and of the VC-JWT string (already canonical — no JSON
  // canonicalization step, and therefore none of its fragility).
  private registryArtifacts() {
    const a = this.config.registryArtifacts;
    if (!a) throw new Error("registry artifacts are not configured for this adapter");
    return a;
  }

  async deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }> {
    return this.serialize(async () => {
      const { didRegistry, vcRegistry } = this.registryArtifacts();
      const didFactory = new ContractFactory(didRegistry.abi, didRegistry.bytecode, this.signer);
      const did = await didFactory.deploy(this.gasOverrides());
      await did.waitForDeployment();
      const vcFactory = new ContractFactory(vcRegistry.abi, vcRegistry.bytecode, this.signer);
      const vc = await vcFactory.deploy(this.gasOverrides());
      await vc.waitForDeployment();
      return {
        didRegistry: await did.getAddress(),
        vcRegistry: await vc.getAddress(),
        txHash: vc.deploymentTransaction()?.hash ?? "",
      };
    });
  }

  async registerDid(registry: string, did: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.registryArtifacts().didRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("registerDid")(did, ov));
  }

  async deactivateDid(registry: string, did: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.registryArtifacts().didRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("deactivateDid")(did, ov));
  }

  async didRegistration(registry: string, did: string): Promise<DidRegistration> {
    const c = new Contract(registry, this.registryArtifacts().didRegistry.abi, this.provider);
    const rec = await c.getFunction("resolve")(did);
    return { registered: BigInt(rec.registeredAt) > 0n, active: Boolean(rec.active) };
  }

  async anchorCredential(registry: string, credentialId: string, vcJwt: string, issuedAt: number, expiresAt: number): Promise<TxReceipt> {
    const c = new Contract(registry, this.registryArtifacts().vcRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("anchor")(id(credentialId), id(vcJwt), BigInt(issuedAt), BigInt(expiresAt), ov));
  }

  async revokeCredential(registry: string, credentialId: string): Promise<TxReceipt> {
    const c = new Contract(registry, this.registryArtifacts().vcRegistry.abi, this.signer);
    return this.send((ov) => c.getFunction("revoke")(id(credentialId), ov));
  }

  async credentialStatusOf(registry: string, credentialId: string): Promise<OnChainCredentialStatus> {
    const c = new Contract(registry, this.registryArtifacts().vcRegistry.abi, this.provider);
    const s = await c.getFunction("statusOf")(id(credentialId));
    return {
      exists: Boolean(s.exists),
      revoked: Boolean(s.revoked),
      revokedAt: BigInt(s.revokedAt) > 0n ? Number(s.revokedAt) : null,
      vcHash: s.exists ? String(s.vcHash) : ZeroHash,
    };
  }
```

**IMPORTANT — read the real class before writing this.** It may store its config differently (e.g. destructured in the constructor rather than kept as `this.config`), and the private tx helper may be named `send`, `sendTx`, or inlined. Adapt these bodies to the real member names; do NOT invent members. Report what you found. Also confirm `this.provider` exists for read-only calls; if not, use `this.signer` (a read via a signer works, it just routes through the same provider).

(f) Export from `packages/adapters/src/index.ts`:
```typescript
export * from "./credential-anchor.js";
```

- [ ] **Step 5: Run the guard test + the adapters suite**

Run: `pnpm --filter @tokenlayer/adapters exec vitest run` and `pnpm --filter @tokenlayer/adapters exec tsc --noEmit`
Expected: 42 existing + 2 new = 44 passing; tsc exit 0.

Note: `supportsCredentialAnchor(evmAdapter)` returns **true even when `registryArtifacts` is absent** (the methods exist; they throw when called). That is intentional and handled in Task 5 — the registry is resolved from the `RegistryDeployment` row, which only exists if a deploy succeeded, and a deploy cannot succeed without artifacts.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/credential-anchor.ts packages/adapters/src/evm-adapter.ts packages/adapters/src/index.ts packages/adapters/test/credential-anchor.test.ts
git commit -m "feat(adapters): CredentialAnchor capability on the EVM adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: RegistryDeployment persistence + env

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,memory,prisma}.ts`, `apps/api/src/env.ts`

- [ ] **Step 1: Schema**

In `apps/api/prisma/schema.prisma`, append:

```prisma
// The identity registries deployed on one chain. There is exactly one row per
// chain that hosts them (in practice: REGISTRY_CHAIN_ID, default "besu"). The
// row's existence IS the idempotency check for the boot-time deploy.
model RegistryDeployment {
  chainId      String   @id
  didRegistry  String
  vcRegistry   String
  deployTxHash String
  createdAt    DateTime @default(now())
}
```

- [ ] **Step 2: Push it**

Run: `pnpm --filter @tokenlayer/api exec prisma db push`
Expected: in sync + client regenerated. If it aborts on the pre-existing `Asset [useCaseKey, uniqueKey]` drift warning, re-run with `--accept-data-loss` (that constraint predates this work; this change is one new table).

- [ ] **Step 3: Types**

Append to `apps/api/src/persistence/types.ts`:

```typescript
export interface RegistryDeploymentRecord {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
  createdAt: string;
}

export interface RegistryDeploymentRepository {
  get(chainId: string): Promise<RegistryDeploymentRecord | null>;
  create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord>;
}
```

- [ ] **Step 4: Memory repo**

Append to `apps/api/src/persistence/memory.ts` (add `RegistryDeploymentRecord`, `RegistryDeploymentRepository` to the type import block):

```typescript
export class MemoryRegistryDeploymentRepository implements RegistryDeploymentRepository {
  private readonly byChain = new Map<string, RegistryDeploymentRecord>();
  async get(chainId: string): Promise<RegistryDeploymentRecord | null> {
    return this.byChain.get(chainId) ?? null;
  }
  async create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord> {
    const rec: RegistryDeploymentRecord = { ...input, createdAt: now() };
    this.byChain.set(rec.chainId, rec);
    return rec;
  }
}
```

- [ ] **Step 5: Prisma repo**

Append to `apps/api/src/persistence/prisma.ts` (add the two types to the import block):

```typescript
const toRegistry = (r: {
  chainId: string; didRegistry: string; vcRegistry: string; deployTxHash: string; createdAt: Date;
}): RegistryDeploymentRecord => ({
  chainId: r.chainId, didRegistry: r.didRegistry, vcRegistry: r.vcRegistry,
  deployTxHash: r.deployTxHash, createdAt: r.createdAt.toISOString(),
});

export class PrismaRegistryDeploymentRepository implements RegistryDeploymentRepository {
  async get(chainId: string): Promise<RegistryDeploymentRecord | null> {
    const r = await prisma.registryDeployment.findUnique({ where: { chainId } });
    return r ? toRegistry(r) : null;
  }
  async create(input: Omit<RegistryDeploymentRecord, "createdAt">): Promise<RegistryDeploymentRecord> {
    return toRegistry(await prisma.registryDeployment.create({ data: input }));
  }
}
```

- [ ] **Step 6: env**

In `apps/api/src/env.ts`, add to the `Env` interface:
```typescript
  /** The single chain hosting the identity registries. Absent/unavailable ⇒ credentials issue unanchored. */
  registryChainId: string;
```
and to the `env` literal:
```typescript
  registryChainId: process.env.REGISTRY_CHAIN_ID ?? "besu",
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit`
Expected: exit 0 (nothing consumes the repo yet).

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/src/env.ts
git commit -m "feat(api): RegistryDeployment model + REGISTRY_CHAIN_ID

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Boot deploy + AppDeps.registry

**Files:**
- Create: `apps/api/src/registry.ts`
- Modify: `apps/api/src/chains.ts`, `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, the 5 harness scripts

- [ ] **Step 1: Feed registry artifacts to the EVM adapter**

In `apps/api/src/chains.ts`, beside the existing `evmArtifacts()` add:
```typescript
/** Registry artifacts for the identity registries (EVM only). */
function registryArtifacts(): { didRegistry: ReturnType<typeof loadArtifact>; vcRegistry: ReturnType<typeof loadArtifact> } {
  return { didRegistry: loadArtifact("DidRegistry"), vcRegistry: loadArtifact("VcRegistry") };
}
```
and pass it where `new EvmLedgerAdapter({ ... })` is constructed: `registryArtifacts: registryArtifacts(),`.

**Note the ordering dependency:** artifacts are hardhat build outputs and are NOT committed, so `pnpm --filter @tokenlayer/contracts build` must have run. This already applies to the token artifacts, so it is not new — but `loadArtifact` throws ENOENT at registry-build time if the contracts package hasn't been built. Keep the call inside the function (lazy), exactly as `evmArtifacts()` does.

- [ ] **Step 2: The resolver**

Create `apps/api/src/registry.ts`:

```typescript
/**
 * The on-chain identity registries: boot-time deploy + resolution.
 *
 * Exactly one chain hosts them (REGISTRY_CHAIN_ID, default "besu"). Absent chain
 * ⇒ no registry ⇒ the platform issues UNANCHORED credentials and says so at the
 * status endpoint. This mirrors the platform's "real or absent, never mocked"
 * rule: we never fake an anchor.
 */
import { supportsCredentialAnchor, type CredentialAnchor } from "@tokenlayer/adapters";
import type { ChainRegistry } from "./chains.js";
import type { RegistryDeploymentRepository } from "./persistence/types.js";

export interface IdentityRegistry {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  anchor: CredentialAnchor;
}

/**
 * Resolve the identity registry, deploying it once if this chain has never had
 * one. Returns undefined when the chain is absent or cannot host registries.
 * Never throws: a broken deploy must not brick the platform — it degrades to
 * unanchored, loudly.
 */
export async function resolveIdentityRegistry(opts: {
  chainId: string;
  chains: ChainRegistry;
  deployments: RegistryDeploymentRepository;
  log?: (msg: string) => void;
}): Promise<IdentityRegistry | undefined> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let adapter;
  try {
    adapter = opts.chains.resolveAdapter(opts.chainId);
  } catch {
    log(`[registry] chain '${opts.chainId}' is absent — credentials will be issued UNANCHORED (status reports source: "database")`);
    return undefined;
  }
  if (!supportsCredentialAnchor(adapter)) {
    log(`[registry] chain '${opts.chainId}' cannot host identity registries (not an EVM adapter) — credentials will be issued UNANCHORED`);
    return undefined;
  }

  const existing = await opts.deployments.get(opts.chainId);
  if (existing) {
    return { chainId: opts.chainId, didRegistry: existing.didRegistry, vcRegistry: existing.vcRegistry, anchor: adapter };
  }
  try {
    const d = await adapter.deployRegistries();
    await opts.deployments.create({ chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, deployTxHash: d.txHash });
    log(`[registry] deployed identity registries on '${opts.chainId}': did=${d.didRegistry} vc=${d.vcRegistry}`);
    return { chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, anchor: adapter };
  } catch (err) {
    log(`[registry] deploy on '${opts.chainId}' FAILED: ${(err as Error).message} — continuing UNANCHORED`);
    return undefined;
  }
}
```

- [ ] **Step 3: AppDeps**

In `apps/api/src/context.ts` add the import `import type { IdentityRegistry } from "./registry.js";` and the field:
```typescript
  /** The on-chain identity registry. ABSENT when no chain hosts one — consumers must handle that explicitly. */
  registry?: IdentityRegistry;
```

- [ ] **Step 4: Wire server.ts**

In `apps/api/src/server.ts`: import `PrismaRegistryDeploymentRepository` and `resolveIdentityRegistry`, construct the repo alongside the others, and after `seedUseCases(...)` (so it runs after `assertConnectivity`):
```typescript
  const registry = await resolveIdentityRegistry({
    chainId: env.registryChainId,
    chains,
    deployments: new PrismaRegistryDeploymentRepository(),
  });
```
then pass `registry,` into `buildApp({ ... })`.

- [ ] **Step 5: Wire the other construction sites**

`apps/api/test/helpers.ts`: add `registry: opts.registry` to `buildApp({...})` and `registry?: IdentityRegistry;` to the `buildTestApp` opts type (importing the type). **Do not** resolve a real registry in tests — besu is absent there by design, so the default is `undefined`, which is exactly the unanchored path the whole suite must keep exercising.

The 5 harness scripts (`demo.ts`, `e2e-buy.ts`, `e2e-carbon.ts`, `e2e-tenancy.ts`, `e2e-usecases.ts`) construct `buildApp` directly. `registry` is OPTIONAL, so they need no change — confirm with `pnpm --filter @tokenlayer/api exec tsc --noEmit`.

- [ ] **Step 6: Typecheck + full suite (behaviour-neutral)**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; **201 passing, unchanged** — nothing consumes `deps.registry` yet.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/registry.ts apps/api/src/chains.ts apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts
git commit -m "feat(api): boot-time identity-registry deploy + resolution (absent-tolerant)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Anchor — atomically

**Files:**
- Modify: `apps/api/src/credential-kinds.ts`, `apps/api/src/http/routes.ts`

- [ ] **Step 1: Anchor before persist in the issue executor**

In `apps/api/src/credential-kinds.ts`, inside `issueCredentialKind.execute`, between signing and `ctx.deps.credentials.create({...})`, insert:

```typescript
    // Anchor BEFORE persisting. The executor is already all-or-nothing: if this
    // throws, the proposal becomes `failed` and no credential row is created —
    // which is why we need neither fire-and-forget nor a reconciliation job.
    // No registry ⇒ issue unanchored (the status endpoint reports that honestly).
    if (ctx.deps.registry) {
      await ctx.deps.registry.anchor.anchorCredential(
        ctx.deps.registry.vcRegistry, credentialId, vcJwt, now, expiresAt,
      );
    }
```

(`credentialId`, `vcJwt`, `now` and `expiresAt` are already in scope there — verify before editing.)

- [ ] **Step 2: Revoke chain-first**

In `revokeCredentialKind.execute`, before `ctx.deps.credentials.revoke(...)`:

```typescript
    // Chain FIRST, then the database. A crash between the two leaves the chain
    // revoked and the DB stale — and since the chain is authoritative when
    // present, /status still answers correctly. The reverse order could report a
    // revoked credential as valid on-chain forever.
    if (ctx.deps.registry) {
      await ctx.deps.registry.anchor.revokeCredential(ctx.deps.registry.vcRegistry, cred.id);
    }
```

- [ ] **Step 3: Register org DIDs on-chain, anchor-before-persist**

In `apps/api/src/http/routes.ts`, in `POST /orgs`, after `const did = deps.keystore.keyOf(didSeedEncrypted).did;` and **before** `deps.organizations.create({...})`:

```typescript
    // Register on-chain BEFORE persisting, so a chain failure needs no rollback:
    // nothing has been written yet. (Contrast mintMembership, which must delete
    // the user row because the row precedes the VC.)
    if (deps.registry) {
      try {
        await deps.registry.anchor.registerDid(deps.registry.didRegistry, did);
      } catch (err) {
        request.log.error({ err }, "org DID registration failed");
        return reply.code(502).send({ error: "REGISTRY_UNAVAILABLE", message: "could not register the organization's DID on-chain — no organization was created" });
      }
    }
```

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; **201 passing, unchanged** — `deps.registry` is undefined in tests, so every new branch is skipped. If anything is red, the guard is wrong; fix the code, never the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/credential-kinds.ts apps/api/src/http/routes.ts
git commit -m "feat(api): anchor credentials + org DIDs on-chain, atomically

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Read paths — the three-way status

**Files:**
- Modify: `apps/api/src/keystore.ts`, `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`

- [ ] **Step 1: Rename the credentialStatus type**

In `apps/api/src/keystore.ts`, replace the `REVOCATION_STATUS_TYPE` constant + its comment:

```typescript
/**
 * OUR OWN status type — still deliberately NOT StatusList2021, which this is not.
 * Semantics: resolve this URL over HTTP; the answer is backed by an on-chain
 * registry when one is configured, and the response says which (`source`).
 */
export const REVOCATION_STATUS_TYPE = "RevocationEndpoint2024";
```
Nothing else changes: existing VCs keep their old type string and resolve at the same URL, which serves both identically.

- [ ] **Step 2: The three-way status resolution**

In `apps/api/src/http/routes.ts`, replace the `GET /credentials/:id/status` handler:

```typescript
  // PUBLIC — a verifier holding only the VC must be able to resolve its status.
  // Returns revocation state ONLY: no claims, no holder, no VC.
  //
  // THREE-WAY resolution. The middle case is the one that matters:
  //   1. no registry            -> database answer, anchored: false
  //   2. registry AND exists    -> CHAIN answer, anchored: true
  //   3. registry but NOT exists-> the credential predates the registry (or its
  //      anchor never landed) -> database answer, anchored: false.
  // Case 3 must NEVER be read as "the chain says not-revoked": an absent record
  // is not a negative revocation. Doing so is exactly the fail-open bug this
  // whole sub-project exists to avoid.
  app.get("/credentials/:id/status", { schema: S.credentialStatus }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred) return notFound(reply, "credential not found");
    const fromDb = { id: cred.id, revoked: cred.revoked, revokedAt: cred.revokedAt, reason: cred.revokedReason };
    if (!deps.registry) return { ...fromDb, anchored: false, source: "database" };
    let onChain;
    try {
      onChain = await deps.registry.anchor.credentialStatusOf(deps.registry.vcRegistry, cred.id);
    } catch (err) {
      request.log.error({ err }, "on-chain status read failed");
      return { ...fromDb, anchored: false, source: "database" };
    }
    if (!onChain.exists) return { ...fromDb, anchored: false, source: "database" };
    return {
      ...fromDb,
      revoked: onChain.revoked,
      revokedAt: onChain.revokedAt ? new Date(onChain.revokedAt * 1000).toISOString() : null,
      anchored: true,
      source: "chain",
      chainId: deps.registry.chainId,
      registry: deps.registry.vcRegistry,
      vcHash: onChain.vcHash,
    };
  });
```
The `reason` always comes from the DB — it is never on-chain.

- [ ] **Step 3: DID document registration block**

In the `GET /dids/:did/document` handler, after building `doc` (the object it currently returns), attach the registration block and return it:

```typescript
    // The DID registry's read path. Without this the registry would be a
    // write-only list — the exact decorative pattern this design rejects.
    let registration: { registered: boolean; active: boolean; chainId: string; registry: string } | null = null;
    if (deps.registry) {
      try {
        const r = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, did);
        registration = { ...r, chainId: deps.registry.chainId, registry: deps.registry.didRegistry };
      } catch (err) {
        request.log.error({ err }, "on-chain DID registration read failed");
      }
    }
```
and include `registration` in the returned object (i.e. `return { ...doc, registration };` — adapt to how the handler currently constructs its response; it returns an object literal, so add the field to it).

- [ ] **Step 4: GET /registry**

Add the schema to `apps/api/src/http/schemas.ts`:
```typescript
  identityRegistry: {
    tags: ["Identity"], summary: "The deployed on-chain identity registries (null when none)", security: bearer,
    response: { 200: { type: "object", nullable: true, additionalProperties: true }, ...errs(401) },
  },
```
and the route beside the credentials section in `routes.ts`:
```typescript
  app.get("/registry", { schema: S.identityRegistry, ...auth }, async () => {
    if (!deps.registry) return null;
    const deployment = await deps.registryDeployments.get(deps.registry.chainId);
    return {
      chainId: deps.registry.chainId,
      didRegistry: deps.registry.didRegistry,
      vcRegistry: deps.registry.vcRegistry,
      deployTxHash: deployment?.deployTxHash ?? null,
    };
  });
```
This needs the repo on `AppDeps`. Add to `apps/api/src/context.ts`:
```typescript
  registryDeployments?: RegistryDeploymentRepository;
```
(importing the type), pass `registryDeployments: new PrismaRegistryDeploymentRepository()` in `server.ts`, and `registryDeployments: new MemoryRegistryDeploymentRepository()` in `test/helpers.ts`. If threading the repo proves noisy, the simpler alternative is to put `deployTxHash` on `IdentityRegistry` at resolve time and drop the repo from `AppDeps` — **prefer that**, and report which you did.

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm --filter @tokenlayer/api exec vitest run`
Expected: exit 0; **201 passing**. The status tests from #2 assert `revoked`/`reason` and must still pass on the no-registry path, now additionally carrying `anchored: false, source: "database"`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/keystore.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts
git commit -m "feat(api): chain-backed status (strict three-way), DID registration read, GET /registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: API wiring tests via a test double

**Files:**
- Create: `apps/api/test/fake-anchor.ts`, `apps/api/test/onchain-registry.test.ts`

A test double is not the reference repo's `demoMode`: theirs ships a `Map` pretending to be a chain **inside the running server**; this never leaves the test process. Real EVM behaviour is covered by Tasks 1–2 (hardhat) and Task 10 (live Besu).

- [ ] **Step 1: The double**

Create `apps/api/test/fake-anchor.ts`:

```typescript
import { createHash } from "node:crypto";
import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "@tokenlayer/adapters";
import type { IdentityRegistry } from "../src/registry.js";

const hash = (s: string): string => "0x" + createHash("sha256").update(s).digest("hex");

/** In-memory CredentialAnchor for wiring tests. `failNext` forces the next write to throw. */
export class FakeAnchor implements CredentialAnchor {
  readonly credentials = new Map<string, { vcHash: string; revoked: boolean; revokedAt: number | null }>();
  readonly dids = new Map<string, boolean>(); // did -> active
  failNext: string | null = null;

  private boom(op: string): void {
    if (this.failNext === op) {
      this.failNext = null;
      throw new Error(`fake anchor: ${op} failed`);
    }
  }
  private receipt() {
    return { txHash: `0xfake${this.credentials.size}${this.dids.size}`, chainId: "besu", timestamp: new Date().toISOString() };
  }

  async deployRegistries() {
    return { didRegistry: "0xdid", vcRegistry: "0xvc", txHash: "0xdeploy" };
  }
  async registerDid(_r: string, did: string) {
    this.boom("registerDid");
    this.dids.set(did, true);
    return this.receipt();
  }
  async deactivateDid(_r: string, did: string) {
    this.boom("deactivateDid");
    this.dids.set(did, false);
    return this.receipt();
  }
  async didRegistration(_r: string, did: string): Promise<DidRegistration> {
    return this.dids.has(did) ? { registered: true, active: this.dids.get(did)! } : { registered: false, active: false };
  }
  async anchorCredential(_r: string, credentialId: string, vcJwt: string) {
    this.boom("anchorCredential");
    this.credentials.set(credentialId, { vcHash: hash(vcJwt), revoked: false, revokedAt: null });
    return this.receipt();
  }
  async revokeCredential(_r: string, credentialId: string) {
    this.boom("revokeCredential");
    const rec = this.credentials.get(credentialId);
    if (rec) { rec.revoked = true; rec.revokedAt = Math.floor(Date.now() / 1000); }
    return this.receipt();
  }
  async credentialStatusOf(_r: string, credentialId: string): Promise<OnChainCredentialStatus> {
    const rec = this.credentials.get(credentialId);
    if (!rec) return { exists: false, revoked: false, revokedAt: null, vcHash: "0x" + "0".repeat(64) };
    return { exists: true, revoked: rec.revoked, revokedAt: rec.revokedAt, vcHash: rec.vcHash };
  }
}

export function fakeRegistry(anchor: FakeAnchor): IdentityRegistry {
  return { chainId: "besu", didRegistry: "0xdid", vcRegistry: "0xvc", anchor };
}
```

Note `anchorCredential`'s signature takes `(registry, credentialId, vcJwt, issuedAt, expiresAt)` — the extra params are unused here, which TypeScript allows on an implementing method. If tsc complains about arity, add the params and prefix them `_`.

- [ ] **Step 2: The tests**

Create `apps/api/test/onchain-registry.test.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

let anchor: FakeAnchor;
let app: FastifyInstance;
let admin: string;
beforeAll(async () => {
  anchor = new FakeAnchor();
  app = await buildTestApp({ registry: fakeRegistry(anchor) });
  admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
});
afterAll(async () => { await app.close(); });

const createOrg = (name: string, orgType = "verifier") =>
  app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType } });
const addMember = (orgId: string, email: string, role: string, pw: string) =>
  app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin), payload: { email, password: pw, role } });

/** An org with two OrgAdmins (proposer + approver) and a subject. */
async function org(tag: string) {
  const o = (await createOrg(`Anchored ${tag}`)).json();
  const a1 = `a1.${tag}@x.io`, a2 = `a2.${tag}@x.io`, s = `s.${tag}@x.io`;
  await addMember(o.id, a1, "OrgAdmin", "orgadmin1");
  await addMember(o.id, a2, "OrgAdmin", "orgadmin2");
  const subject = (await addMember(o.id, s, "Buyer", "subject1")).json();
  return { o, subject, s, t1: await loginAs(app, a1, "orgadmin1"), t2: await loginAs(app, a2, "orgadmin2") };
}
async function issue(tag: string) {
  const ctx = await org(tag);
  const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(ctx.t1),
    payload: { type: "KycCredential", subjectUserId: ctx.subject.id, claims: { legalName: "A", country: "IN" } } });
  const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${req.json().proposal.id}/approve`, headers: auth(ctx.t2), payload: {} });
  const subjTok = await loginAs(app, ctx.s, "subject1");
  const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) })).json();
  return { ...ctx, proposal: approved.json().proposal, cred: creds.find((c: { type: string[] }) => c.type.includes("KycCredential")) };
}

describe("org DID registration", () => {
  it("registers the org's parent DID on-chain and surfaces it on the DID document", async () => {
    const o = (await createOrg("Registered Org")).json();
    expect(anchor.dids.get(o.did)).toBe(true);
    const doc = (await app.inject({ method: "GET", url: `${V1}/dids/${encodeURIComponent(o.did)}/document`, headers: auth(admin) })).json();
    expect(doc.registration).toMatchObject({ registered: true, active: true, chainId: "besu" });
  });

  it("a chain failure creates NO org (anchor before persist — nothing to roll back)", async () => {
    anchor.failNext = "registerDid";
    const res = await createOrg("Never Created");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("REGISTRY_UNAVAILABLE");
    const list = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) })).json();
    expect(list.some((o: { name: string }) => o.name === "Never Created")).toBe(false);
  });

  it("a member's sub-DID is NOT registered on-chain (privacy: org DIDs only)", async () => {
    const o = (await createOrg("Members Off Chain")).json();
    const m = (await addMember(o.id, "priv@x.io", "Buyer", "subject1")).json();
    expect(anchor.dids.has(m.did)).toBe(false);
    expect(anchor.dids.get(o.did)).toBe(true);
  });
});

describe("credential anchoring", () => {
  it("anchors on issue and reports the CHAIN as the status source", async () => {
    const { cred } = await issue("ok");
    expect(anchor.credentials.has(cred.id)).toBe(true);
    const st = (await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` })).json();
    expect(st).toMatchObject({ revoked: false, anchored: true, source: "chain", chainId: "besu", registry: "0xvc" });
    expect(st.vcHash).toBeTruthy();
  });

  it("a failed anchor fails the proposal and creates NO credential", async () => {
    const ctx = await org("failanchor");
    anchor.failNext = "anchorCredential";
    const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(ctx.t1),
      payload: { type: "KycCredential", subjectUserId: ctx.subject.id, claims: { legalName: "A", country: "IN" } } });
    const res = await app.inject({ method: "POST", url: `${V1}/proposals/${req.json().proposal.id}/approve`, headers: auth(ctx.t2), payload: {} });
    expect(res.json().proposal.status).toBe("failed");
    const subjTok = await loginAs(app, ctx.s, "subject1");
    const creds = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) })).json();
    expect(creds.some((c: { type: string[] }) => c.type.includes("KycCredential"))).toBe(false);
  });

  it("revokes on-chain and the public status flips to the chain's answer", async () => {
    const { cred, t1, t2 } = await issue("rev");
    const rev = await app.inject({ method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(t1), payload: { reason: "expired doc" } });
    await app.inject({ method: "POST", url: `${V1}/proposals/${rev.json().proposal.id}/approve`, headers: auth(t2), payload: {} });
    expect(anchor.credentials.get(cred.id)!.revoked).toBe(true);
    const st = (await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` })).json();
    expect(st).toMatchObject({ revoked: true, anchored: true, source: "chain", reason: "expired doc" });
  });

  it("a failed on-chain revoke leaves the database flag untouched (chain first)", async () => {
    const { cred, t1, t2 } = await issue("failrev");
    anchor.failNext = "revokeCredential";
    const rev = await app.inject({ method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(t1), payload: { reason: "nope" } });
    const res = await app.inject({ method: "POST", url: `${V1}/proposals/${rev.json().proposal.id}/approve`, headers: auth(t2), payload: {} });
    expect(res.json().proposal.status).toBe("failed");
    expect(anchor.credentials.get(cred.id)!.revoked).toBe(false);
    const st = (await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` })).json();
    expect(st.revoked).toBe(false);
  });
});

describe("THE THREE-WAY: an absent on-chain record is not a negative revocation", () => {
  it("falls back to the database with anchored:false when the chain has no record", async () => {
    const { cred } = await issue("orphan");
    // Simulate a credential that predates the registry: drop its on-chain record.
    anchor.credentials.delete(cred.id);
    const st = (await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` })).json();
    // It must NOT claim source:"chain" just because statusOf returned revoked:false.
    expect(st.source).toBe("database");
    expect(st.anchored).toBe(false);
    expect(st.vcHash).toBeUndefined();
  });
});

describe("GET /registry", () => {
  it("reports the deployed registries", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/registry`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chainId: "besu", didRegistry: "0xdid", vcRegistry: "0xvc" });
  });
});
```

- [ ] **Step 3: Run them**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/onchain-registry.test.ts`
Expected: PASS (10 tests). Debug the implementation, not the test, on failure.

- [ ] **Step 4: THE GATE — the unanchored suite is untouched**

Run: `pnpm --filter @tokenlayer/api exec vitest run`
Expected: 201 + 10 = **211 passing**, with `test/credential-issuance.test.ts`, `test/approvals.test.ts` and `test/proposal-compensation.test.ts` all **unedited** (`git diff --stat` on them must be empty). Those run without a registry and prove the unanchored default still works.

- [ ] **Step 5: Mutation check — prove the three-way test bites**

Temporarily break the middle case in `routes.ts`: change `if (!onChain.exists) return { ...fromDb, anchored: false, source: "database" };` to `if (false) ...`. Re-run `test/onchain-registry.test.ts` and CONFIRM the "absent record" test FAILS (it would report `source: "chain"`). Restore exactly; verify `git diff apps/api/src/http/routes.ts` is empty before committing. Report both observations.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/fake-anchor.ts apps/api/test/onchain-registry.test.ts
git commit -m "test(api): on-chain registry wiring — atomicity, chain-first revoke, three-way status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Web — registry card + anchored pills

**Files:**
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/components/NetworksPanel.tsx`, `apps/web/src/components/Organizations.tsx`, `apps/web/src/components/MyIdentity.tsx`

**MANDATORY PREP:** read `apps/web/src/components/ui.tsx` for the REAL primitives — `Pill` (tones `"ok" | "warn" | "danger" | "info" | "muted"`), `Card` ({title?, description?, actions?, className?, children}), `SectionHeader`, `EmptyState` ({icon?: IconName, title, hint?, action?}), `Skeleton`. `IconName` is `chain | shield | doc | users | spark | check | warn | code | globe | coins | arrow`. **There is no `Button`** — use `<button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white">`.

- [ ] **Step 1: Types + client**

In `apps/web/src/types.ts` append:
```typescript
export interface IdentityRegistryInfo {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string | null;
}
export interface CredentialStatusInfo {
  id: string;
  revoked: boolean;
  revokedAt: string | null;
  reason: string | null;
  anchored: boolean;
  source: "chain" | "database";
  chainId?: string;
  registry?: string;
  vcHash?: string;
}
```
and add to `DidDocument`:
```typescript
  registration?: { registered: boolean; active: boolean; chainId: string; registry: string } | null;
```
In `apps/web/src/api.ts` add:
```typescript
  identityRegistry: (token: string) => request<IdentityRegistryInfo | null>("/registry", token),
  credentialStatus: (id: string) => request<CredentialStatusInfo>(`/credentials/${encodeURIComponent(id)}/status`, null),
```
(`request`'s second arg is the token; the status endpoint is public, so pass `null` — confirm `request` accepts a null token, which it does for `login`.)

- [ ] **Step 2: The registry card in Networks**

In `apps/web/src/components/NetworksPanel.tsx`, load `api.identityRegistry(token)` and render above the chain list:

```tsx
      <Card title="Identity registry" description="On-chain DID + credential registries backing credential status.">
        {registry === null && (
          <div className="text-sm text-slate-500">
            No identity registry is configured — credentials are issued unanchored and their status resolves from the database.
          </div>
        )}
        {registry && (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2"><Pill tone="ok">on-chain</Pill><span className="text-slate-500">{registry.chainId}</span></div>
            <div className="font-mono text-xs text-slate-500">DID registry: {registry.didRegistry}</div>
            <div className="font-mono text-xs text-slate-500">VC registry: {registry.vcRegistry}</div>
            {registry.deployTxHash && <div className="font-mono text-xs text-slate-400">deploy tx: {registry.deployTxHash}</div>}
          </div>
        )}
      </Card>
```
with `const [registry, setRegistry] = useState<IdentityRegistryInfo | null | undefined>(undefined);` and a `useEffect` that sets it (leave `undefined` while loading so the empty state doesn't flash).

- [ ] **Step 3: The on-chain pill on the org card**

In `apps/web/src/components/Organizations.tsx`, the org card already shows a `verified` pill. Add an on-chain pill driven by the DID document's `registration`. Fetch it per selected org (not for every card — one request, in the `Members`/detail area):
```tsx
  const [registration, setRegistration] = useState<DidDocument["registration"]>(null);
  useEffect(() => { if (token) void api.didDocument(token, org.did).then((d) => setRegistration(d.registration ?? null)).catch(() => setRegistration(null)); }, [token, org.did]);
```
and beside the org's DID:
```tsx
  {registration?.registered && <Pill tone={registration.active ? "ok" : "muted"}>{registration.active ? "on-chain" : "deactivated"}</Pill>}
```

- [ ] **Step 4: The anchored pill on a held credential**

In `apps/web/src/components/MyIdentity.tsx`, for each credential fetch its public status and show provenance:
```tsx
  {status?.anchored
    ? <Pill tone="info">anchored · {status.chainId}</Pill>
    : <Pill tone="muted">unanchored</Pill>}
```
Load statuses once for the listed credentials (`Promise.all(creds.map((c) => api.credentialStatus(c.id)))` into a `Record<string, CredentialStatusInfo>` keyed by id), and tolerate failures by omitting the pill.

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): identity-registry card + on-chain/anchored pills

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Verify — real Besu, independent eth_call, browser, merge

**Files:**
- Create: `scripts/onchain-registry-e2e.mjs`

- [ ] **Step 1: Full monorepo build + suite (unanchored default)**

Run: `pnpm -r build && pnpm -r test`
Expected: core 149, adapters 44, contracts 34, api 211. All green.

- [ ] **Step 2: Bring up the vendored Besu**

```bash
make besu-up
sleep 20
curl -s -X POST http://localhost:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```
Expected: a rising block number. (Node 1 publishes 8545 to the host; nodes 2-5 are internal.) If the Docker VM is short on memory, stop the Fabric network first — the two together exhaust it.

- [ ] **Step 3: Write the E2E**

Create `scripts/onchain-registry-e2e.mjs`:

```javascript
// End-to-end against REAL Besu: registries deploy at boot, an org's DID is
// registered on-chain, a credential is anchored through the approval chain, its
// status resolves FROM CHAIN, revocation flips the chain, and an absent record
// falls back honestly. The decisive checks are the direct eth_calls in section 5,
// which bypass our API entirely.
const API = process.env.API ?? "http://localhost:4000/api/v1";
const RPC = process.env.BESU_RPC_URL ?? "http://localhost:8545";
const runId = String(Date.now()).slice(-7);

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;

const platform = await login("admin@tokenlayer.dev", "admin123");
if (!platform) { console.error("platform login failed"); process.exit(2); }

console.log("== 1) The registries deployed at boot ==");
const reg = (await call("GET", "/registry", null, platform)).json;
ok(reg?.vcRegistry?.startsWith("0x") && reg?.didRegistry?.startsWith("0x"), `registries on '${reg?.chainId}': vc=${reg?.vcRegistry?.slice(0, 12)}… did=${reg?.didRegistry?.slice(0, 12)}…`, reg);

console.log("\n== 2) Onboard an org — its DID registers on-chain ==");
const org = (await call("POST", "/orgs", { name: `Anchored Verifier ${runId}`, orgType: "verifier" }, platform)).json;
ok(org?.did, `org parent DID ${org?.did?.slice(0, 22)}…`, org);
const doc = (await call("GET", `/dids/${encodeURIComponent(org.did)}/document`, null, platform)).json;
ok(doc?.registration?.registered === true && doc?.registration?.active === true, "the DID document reports it registered + active on-chain", doc?.registration);

console.log("\n== 3) Issue a credential through the approval chain ==");
const mk = async (email, role, pw) => (await call("POST", `/orgs/${org.id}/users`, { email, password: pw, role }, platform)).json;
const a1 = `a1.${runId}@ax.dev`, a2 = `a2.${runId}@ax.dev`, s = `s.${runId}@ax.dev`;
await mk(a1, "OrgAdmin", "orgadmin1"); await mk(a2, "OrgAdmin", "orgadmin2");
const subject = await mk(s, "Buyer", "subject1");
const t1 = await login(a1, "orgadmin1"), t2 = await login(a2, "orgadmin2");
const req = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Anchored Person", country: "IN" } }, t1);
const done = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t2);
ok(done.json?.proposal?.status === "executed", "approved → executed (the anchor landed, or this would have failed)", done.json?.proposal);
const creds = (await call("GET", "/me/credentials", null, await login(s, "subject1"))).json ?? [];
const kyc = creds.find((c) => c.type.includes("KycCredential"));
ok(!!kyc, "the subject holds the credential", creds.map((c) => c.type));

console.log("\n== 4) Status resolves FROM CHAIN ==");
const st = await call("GET", `/credentials/${kyc.id}/status`, null, null); // public, no token
ok(st.json?.source === "chain" && st.json?.anchored === true, `status source = ${st.json?.source} (anchored: ${st.json?.anchored})`, st.json);
ok(st.json?.chainId === reg.chainId && st.json?.registry === reg.vcRegistry, "it names the chain + registry that answered", st.json);

console.log("\n== 5) INDEPENDENT PROOF — read the chain directly, bypassing the API ==");
// statusOf(bytes32) selector + keccak256(credentialId), computed without our code.
const { keccak256, toUtf8Bytes, AbiCoder, Interface } = await import("ethers");
const iface = new Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const data = iface.encodeFunctionData("statusOf", [keccak256(toUtf8Bytes(kyc.id))]);
const rpc = async (m, p) => (await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const raw = await rpc("eth_call", [{ to: reg.vcRegistry, data }, "latest"]);
const decoded = iface.decodeFunctionResult("statusOf", raw);
ok(decoded.exists === true, "eth_call statusOf → exists: true (the anchor is genuinely on-chain)", { raw: raw?.slice(0, 20) });
ok(decoded.revoked === false, "eth_call statusOf → revoked: false");
ok(decoded.vcHash === keccak256(toUtf8Bytes(kyc.vcJwt)), "the anchored vcHash equals keccak256 of the VC-JWT we hold — tamper-evidence", { onChain: decoded.vcHash });

console.log("\n== 6) Revoke → the chain flips ==");
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "document expired" }, t1);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, t2);
const after = await call("GET", `/credentials/${kyc.id}/status`, null, null);
ok(after.json?.revoked === true && after.json?.source === "chain", "the public status reports revoked, sourced from chain", after.json);
const raw2 = await rpc("eth_call", [{ to: reg.vcRegistry, data }, "latest"]);
ok(iface.decodeFunctionResult("statusOf", raw2).revoked === true, "eth_call confirms the revocation on-chain, independently of our API");

console.log("\n== 7) An absent record is NOT a negative revocation ==");
const bogus = await call("GET", `/credentials/00000000-0000-0000-0000-000000000000/status`, null, null);
ok(bogus.status === 404, "an unknown credential 404s rather than reporting a chain 'not revoked'", bogus.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ ON-CHAIN REGISTRY END-TO-END PASSED — registries deployed, org DID registered, credential anchored + independently verified by eth_call, revocation reflected on-chain"}`);
process.exit(fails ? 1 : 0);
```

Run it from `apps/api/` (`cd apps/api && node ../../scripts/onchain-registry-e2e.mjs`) so the dynamic `import("ethers")` resolves — ethers is a dependency of `@tokenlayer/adapters`, not of the repo root. Report what you had to do.

- [ ] **Step 4: Boot against real Besu and run it**

```bash
pkill -f "tsx watch src/server.ts"; rm -f apps/api/reg-e2e.db
DATABASE_URL="file:./reg-e2e.db" pnpm --filter @tokenlayer/api exec prisma db push --skip-generate
DATABASE_URL="file:./reg-e2e.db" JWT_SECRET="dev-secret-registry-e2e" PORT=4000 NODE_ENV=development \
  BESU_RPC_URL="http://localhost:8545" \
  BESU_OPERATOR_KEY="0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63" \
  REGISTRY_CHAIN_ID=besu LOGIN_RATE_LIMIT_MAX=1000 pnpm api:dev &
sleep 30
cd apps/api && node ../../scripts/onchain-registry-e2e.mjs; cd ..
```
Expected: the boot log shows `[registry] deployed identity registries on 'besu': did=0x… vc=0x…`, then `✅ ON-CHAIN REGISTRY END-TO-END PASSED`. Note besu is `required: true` in `config/chains.json`, so with `BESU_RPC_URL`+`BESU_OPERATOR_KEY` set it must be reachable or boot dies — that is the intended "configured ⇒ must work" rule.

- [ ] **Step 5: Prove idempotency**

Restart the API against the SAME database and confirm the boot log does **not** deploy again (the `RegistryDeployment` row exists) and `GET /registry` returns the same addresses. Report the observed addresses across both boots.

- [ ] **Step 6: Browser**

`preview_start` the `web` config against the Besu-backed API. Check: **Networks** shows the Identity registry card with both addresses; **Organizations** shows the `on-chain` pill on the org; a member's **My identity** shows `anchored · besu` on the credential. Screenshot as proof.

- [ ] **Step 7: Cleanup + merge**

```bash
pkill -f "tsx watch src/server.ts"; rm -f apps/api/reg-e2e.db
make besu-down
git status --short   # only the E2E script should be untracked
git add scripts/onchain-registry-e2e.mjs
git commit -m "test(e2e): live on-chain registry — anchor, independent eth_call proof, revocation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Then use **superpowers:finishing-a-development-branch**. Confirm the merge with the user.

---

## Self-Review

**1. Spec coverage:**
- `VcRegistry` (commitment-only, no DIDs/types/claims, no holder index, no on-chain reason, operator-only) → Task 1. ✓
- `DidRegistry` (org DIDs only, no publicKeyHex, deactivation, enumerable trust list, operator-only) → Task 2. ✓
- `CredentialAnchor` + `supportsCredentialAnchor` + hashing inside the adapter + `registryArtifacts` as a separate config field → Task 3. ✓
- `RegistryDeployment` model + `REGISTRY_CHAIN_ID` → Task 4. ✓
- Boot deploy, idempotent on row existence, never throws, absent-tolerant; `AppDeps.registry` optional → Task 5 (+ idempotency proven live in Task 10 Step 5). ✓
- Anchor-before-persist in `POST /orgs` (502, no rollback needed) + `issueCredentialKind`; revoke chain-first → Task 6. ✓
- Strict three-way status (incl. the `exists: false` → DB fallback), DID `registration` block, `GET /registry`, `RevocationEndpoint2024` → Task 7. ✓
- Testing: contracts on real EVM (1–2), test double for wiring (8), unanchored regression gate (8 Step 4), live E2E + independent `eth_call` (10). ✓
- Web registry card + on-chain/anchored pills → Task 9. ✓
- Privacy claims are enforced by construction (the contracts simply have no fields for DIDs/types) and asserted in Task 8's "member sub-DID is NOT registered" test. ✓
- Out-of-scope items (trustedIssuers wiring, BitstringStatusList, member DIDs on-chain, reconciliation job) → no tasks, correctly. ✓

**2. Placeholder scan:** No TBD/TODO; every code block is meant to be copied as-is. Task 3 Step 4 and Task 7 Step 4 instruct reading the real code before editing and name the exact adaptation; Task 7 Step 4 states a preferred alternative rather than leaving the choice open.

**3. Type consistency:** `CredentialAnchor`'s methods (`deployRegistries`, `registerDid`, `deactivateDid`, `didRegistration`, `anchorCredential`, `revokeCredential`, `credentialStatusOf`) are identical across Task 3's interface, Task 3's `METHODS` guard list, Task 8's `FakeAnchor`, and every call site in Tasks 6–7. `OnChainCredentialStatus` fields (`exists`, `revoked`, `revokedAt`, `vcHash`) match the Solidity `statusOf` return tuple in Task 1, the adapter mapping in Task 3, the double in Task 8, and the E2E's ABI string in Task 10. `IdentityRegistry` (`chainId`, `didRegistry`, `vcRegistry`, `anchor`) is consistent across Tasks 5–8. `RegistryDeploymentRecord`/`RegistryDeploymentRepository` match across Task 4's three impls and Task 7's `GET /registry`. Web `IdentityRegistryInfo`/`CredentialStatusInfo` (Task 9) match the API responses in Task 7.
