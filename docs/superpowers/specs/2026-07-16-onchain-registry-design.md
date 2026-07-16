# On-Chain DID/VC Registry + Revocation Anchoring — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorm decisions locked with user)
**Predecessors:** `2026-07-11-organizations-identity-design.md` (#1), `2026-07-16-credential-issuance-design.md` (#2) — both merged.
**Reference:** `~/did-vc-project` — `DIDRegistry.sol` + `VCRegistry.sol` + `besu.ts`. We mirror its two-registry
shape and reject its privacy model, its authorization model, and its fail-open verification (see
"What we reject").

## Goal

Sub-project #4 of four. Make the identity layer verifiable **independently of our API**: credential
commitments and revocation live on Besu, org DIDs are registered on-chain, and the public status
endpoint answers from chain state. Replaces the placeholder `SimpleRevocationStatus2024` semantics
that #2 deliberately shipped as a stand-in.

## Locked decisions

1. **Both registries** — `DidRegistry` + `VcRegistry`, mirroring the reference project.
2. **Authoritative when present, honest when absent** — anchoring is synchronous and fail-closed when
   a registry is available; when Besu is absent, credentials still issue and the status endpoint
   reports `anchored: false, source: "database"`.
3. **Keep the existing status endpoint, back it with chain state** — the URL is already baked into
   every VC issued by #2, so no reissuance is needed.

## What we reject from the reference repo (and why)

Recorded so the implementation does not reintroduce these by pattern-matching on that repo:

- **It isn't actually running.** `BESU_PRIVATE_KEY` is unset, so
  `this.demoMode = !process.env.BESU_PRIVATE_KEY || !this.didRegistryAddress` is `true` and every
  anchor is a `Map.set()` with a fabricated tx hash. Our registry must be real or absent — never a
  map pretending to be a chain inside the running server.
- **Verification fails open.** `if (!vc.polygon_vc_hash) return true;` — a missing anchor means
  "valid". Combined with fire-and-forget anchoring (8 of 10 call sites are unawaited
  `.catch(console.error)`), any chain hiccup silently yields an unconditionally-valid credential. The
  demo branch returns `hashValid: true` without comparing anything.
- **The privacy comment is false.** `VCRegistry.sol` says *"Stores only credential hashes (not full
  VCs) for privacy"*, but the struct stores `issuerDid`, `holderDid` and `credentialType` in
  plaintext, and `holderCredentials[holderDid] → string[]` publicly enumerates every credential a
  subject holds. Claims do stay off-chain; everything else is a correlation surface.
- **Writes are permissionless.** `registerDID` and `issueVC` are `external` with no owner/role check.
  A DID can be squatted permanently (no admin override exists), and any caller may anchor any `vcId`
  asserting any `issuerDid` — so the anchor proves "someone anchored this", not "this issuer issued
  this". One shared platform signer additionally makes their `onlyController`/`onlyIssuer` vacuous.
- **The chain is disconnected from the VC.** No issued VC carries `credentialStatus`, so a third-party
  holder has no way to discover the registry at all.
- **Hash fragility.** They canonicalize JSON by sorting only top-level keys, so nested
  `credentialSubject` ordering changes the hash; their own `verifyVCWithStoredHash` exists to work
  around it. Our VC **is a JWT string**, so `keccak256(vcJwt)` is deterministic with no
  canonicalization step. We do not inherit this problem.

## Contracts (`packages/contracts`)

Two new Solidity files, built by the existing hardhat pipeline. Both are `Ownable` — **the platform
operator is the sole writer**. This is honest rather than restrictive: keys are custodial (decision #4
of sub-project #1), so the platform already signs on every org's behalf. The chain therefore proves
*tamper-evidence and status*; the VC's Ed25519 signature proves *issuer provenance*. Those are
complementary claims, and the spec does not pretend the anchor proves issuance.

### `VcRegistry.sol`

```solidity
struct VcRecord {
    bytes32 vcHash;      // keccak256 of the VC-JWT string
    uint64 issuedAt;
    uint64 expiresAt;
    bool revoked;
    uint64 revokedAt;
}
mapping(bytes32 => VcRecord) public credentials;   // key = keccak256(credentialId)
```

- `anchor(bytes32 idHash, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt) onlyOwner` — reverts on
  a duplicate `idHash`.
- `revoke(bytes32 idHash) onlyOwner` — reverts if unknown or already revoked.
- `statusOf(bytes32 idHash) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)`.
- Events: `VcAnchored(bytes32 indexed idHash, bytes32 vcHash)`, `VcRevoked(bytes32 indexed idHash, uint64 at)`.

**Deliberately absent:** issuer DID, holder DID, credential type, claims, and any holder→credentials
index. No revocation *reason* on-chain either (it is free text and may be personal); the reason stays
in the database.

### `DidRegistry.sol`

**Org parent DIDs only — never member sub-DIDs.** An org's DID is already public (it is the `iss` of
every VC that org signs), so registering it leaks nothing new; a member's sub-DID is personal and
stays off-chain.

```solidity
struct DidRecord {
    string did;          // the org's public parent DID
    address controller;
    bool active;
    uint64 registeredAt;
    uint64 deactivatedAt;
}
mapping(bytes32 => DidRecord) public dids;   // key = keccak256(did)
bytes32[] public didIndex;                    // enumerable ON PURPOSE — a trust list is meant to be listable
```

- `registerDid(string did) onlyOwner` — reverts on duplicate.
- `deactivateDid(string did) onlyOwner` — the one thing `did:key` cannot express.
- `isActive(string did) view returns (bool)`, `resolve(string did) view returns (DidRecord)`,
  `count() view`, `didAt(uint256) view`.
- Events: `DidRegistered(bytes32 indexed didHash, string did)`, `DidDeactivated(bytes32 indexed didHash, uint64 at)`.

**Deliberately absent: `publicKeyHex`.** For `did:key` the public key *is* the DID string — our
`GET /dids/:did/document` already derives it offline with no DB and no chain. Storing it would be
pure redundancy, and it is the field that makes the reference repo's DID registry pointless for us.

Enumeration here is a *feature*, not the leak we rejected above: the leak was enumerating a **holder's**
credentials. Enumerating **issuers** is what a trust list is for.

## API (`apps/api`)

### The adapter seam — `packages/adapters`

Registries are EVM-only, so `LedgerAdapter` is **not** extended (Fabric/Canton would be forced to
throw on methods they cannot implement, and their `anchor` already returns a synthetic receipt without
transacting). Instead, a separate capability interface that `EvmLedgerAdapter` also implements:

```ts
export interface CredentialAnchor {
  deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }>;
  registerDid(registry: string, did: string): Promise<TxReceipt>;
  deactivateDid(registry: string, did: string): Promise<TxReceipt>;
  didRegistration(registry: string, did: string): Promise<{ registered: boolean; active: boolean } | null>;
  anchorCredential(registry: string, credentialId: string, vcJwt: string, issuedAt: number, expiresAt: number): Promise<TxReceipt>;
  revokeCredential(registry: string, credentialId: string): Promise<TxReceipt>;
  credentialStatusOf(registry: string, credentialId: string): Promise<{ exists: boolean; revoked: boolean; revokedAt: number | null; vcHash: string } | null>;
}
/** Narrowing guard — presence-detected, mirroring how assertConnectivity probes for healthCheck. */
export function supportsCredentialAnchor(a: LedgerAdapter): a is LedgerAdapter & CredentialAnchor;
```

Hashing (`keccak256(credentialId)`, `keccak256(vcJwt)`) lives **inside** the adapter, so callers pass
plain strings and cannot get the commitment wrong. Implementation reuses `SerialNonceSigner`, the
`serialize` mutex and `gasOverrides()` (free-gas Besu) unchanged.

`EvmAdapterConfig.artifacts` is typed `Record<TokenStandard, EvmArtifact>` and a registry is not a
token standard, so a **separate optional field** is added:

```ts
  /** Registry artifacts; when absent the adapter does not advertise CredentialAnchor. */
  registryArtifacts?: { didRegistry: EvmArtifact; vcRegistry: EvmArtifact };
```

Artifacts load via the existing `loadArtifact("VcRegistry")` / `loadArtifact("DidRegistry")` — the
file basename must equal the contract name. Note these are **build outputs, not committed**, so the
contracts package must be built before the API boots (an ordering dependency that already exists for
token artifacts).

### Deployment + address storage

There is no singleton-address home today — every contract address hangs off a `UseCase` row. New model:

```prisma
model RegistryDeployment {
  chainId      String   @id
  didRegistry  String
  vcRegistry   String
  deployTxHash String
  createdAt    DateTime @default(now())
}
```

`REGISTRY_CHAIN_ID` (default `"besu"`) names the single chain that hosts the identity registries — one
canonical registry, not one per chain. At boot, **after** `assertConnectivity`, if that chain is
available and advertises `CredentialAnchor` and no row exists, deploy both and store the row. Absent
chain ⇒ no deployment, no error, a single honest log line. Idempotent on row existence, mirroring
`deployUseCaseContracts`' shape but filtering on `available` (which `server.ts` currently does not).

`AppDeps` gains `registry?: { chainId: string; didRegistry: string; vcRegistry: string; anchor: CredentialAnchor }`
— **absent when there is no registry**, so every consumer must handle its absence explicitly rather
than discovering a silent fallback.

### Wiring — atomic, via the executor that is already atomic

- **`POST /orgs`** — order is: generate the seed → derive the parent DID → **`registerDid` on-chain** →
  only then create the org row. Anchor-before-persist, so **no rollback path is needed**: a chain
  failure returns 502 `REGISTRY_UNAVAILABLE` having persisted nothing. (Contrast the member-mint
  rollback in #1, which must delete a user row because the row precedes the VC.) No registry ⇒ create
  as today.
- **`issueCredentialKind.execute`** — sign → **anchor** → persist, in that order. If the anchor throws,
  the executor throws, the proposal becomes `failed`, and **no credential row is created**. This is why
  no fire-and-forget and no reconciliation job are needed: the maker-checker executor is already
  all-or-nothing.
- **`revokeCredentialKind.execute`** — **revoke on-chain first**, then flip the database. A crash
  between the two leaves the chain revoked and the DB stale; since the chain is authoritative when
  present, `/status` still answers correctly. Chain-first is the only safe order.
- Accepted residue, stated rather than hidden: a crash between `anchor` and `persist` leaves an
  orphan on-chain record for a credential that does not exist. Harmless — the VC was never returned to
  anyone, and `/status` for that id 404s on the DB lookup.

### Read paths — the reason this is not decorative

- **`GET /credentials/:id/status`** (public, unchanged URL) now returns:
  `{ id, revoked, revokedAt, reason, anchored, source: "chain" | "database", chainId?, registry?, vcHash? }`.
  The `reason` always comes from the DB (never on-chain). Resolution is a strict three-way:
  1. **No registry configured** → DB answer, `anchored: false, source: "database"`.
  2. **Registry configured AND `statusOf().exists === true`** → **chain** answer,
     `anchored: true, source: "chain"`, with `vcHash`/`chainId`/`registry`.
  3. **Registry configured but `statusOf().exists === false`** → the credential predates the registry
     (or its anchor never landed). Fall back to the DB answer with `anchored: false, source: "database"`.
     It must **NOT** be read as "chain says not-revoked" — an absent record is not a negative
     revocation, and treating it as one is precisely the reference repo's `if (!hash) return true` bug
     wearing a different hat.

  A verifier is always *told* the provenance of the answer and decides.
- **`GET /dids/:did/document`** gains `registration: { registered, active, chainId, registry } | null` —
  `null` when no registry exists. This is the DID registry's read path; without it the DID registry
  would be the write-only list this design exists to avoid.
- **`GET /registry`** (auth read) — `{ chainId, didRegistry, vcRegistry, deployTxHash, didCount } | null`,
  for the Networks view.

### `credentialStatus` type

`SimpleRevocationStatus2024` → `RevocationEndpoint2024`, described plainly as "resolve this URL over
HTTP; backed by an on-chain registry when one is configured". Still deliberately **not** named
StatusList2021, which it still is not. Existing VCs keep working: only the type string on
newly-issued credentials changes, and the endpoint serves both identically.

## Privacy

What an observer with RPC access to the permissioned network learns: the set of org DIDs registered on
the platform (already public), and for credentials a set of
`(idHash, vcHash, issuedAt, expiresAt, revoked)` with no linkage to any person, org, or credential
type. Timing correlation remains — anchoring a credential shortly after creating an org relates them
temporally. That is inherent to on-chain anchoring, bounded by permissioned network membership, and
accepted here rather than papered over.

## Error handling

- Registry configured but the chain becomes unreachable mid-run → the anchor throws → issuance
  proposal `failed` with a coded error; revocation proposal `failed`, DB untouched. Never a silent pass.
- `anchor` on a duplicate `idHash` → contract reverts → proposal `failed`. (Unreachable in practice:
  ids are fresh UUIDs.)
- `revoke` of an unknown/already-revoked idHash → reverts → proposal `failed`; the route's existing
  409 catches the common case first.
- Boot: registry chain absent ⇒ log once, continue. Registry chain present but deploy fails ⇒ log and
  continue **without** a registry (unanchored mode) — a broken deploy must not brick the platform.

## Testing

- **Contracts** (`packages/contracts/test/`): hardhat tests on a **real EVM** (hardhat network) —
  `onlyOwner` rejects a non-owner, duplicate register/anchor reverts, deactivate flips `isActive`,
  revoke flips `statusOf`, double-revoke reverts, `statusOf` of an unknown id reports `exists: false`.
- **API**: a test-double `CredentialAnchor` covers the wiring — a failing anchor leaves the proposal
  `failed` and **no credential row**; a failing revoke leaves the DB flag untouched; `/status` reports
  `source: "chain"` with a registry and `source: "database"` without; `/dids/:did/document` carries
  `registration`. (A test double is not the reference repo's `demoMode`: theirs ships a `Map`
  pretending to be a chain in the running server; ours never leaves the test process.)
- **Regression:** the full suite (412 today) runs with `CHAIN_STRICT=0` and besu absent, so the
  unanchored path is the default and every existing credential test must stay green untouched.
- **Live E2E** (`scripts/onchain-registry-e2e.mjs`): against real Besu — deploy, onboard an org
  (DID registered on-chain), issue a credential through the approval chain, then **prove it
  independently with a direct `eth_call` to `statusOf`, bypassing our API entirely**; revoke and see
  the chain flip; assert `keccak256(vcJwt)` equals the anchored `vcHash`.
- **Browser**: the Networks view shows the deployed registries; a credential shows `anchored` with its
  chain + tx.

## Web (`apps/web`)

- **Networks**: a registry card — chain, both addresses, deploy tx, registered-DID count; or an
  honest "no identity registry configured" empty state.
- **Organizations**: the org card shows an on-chain `registered`/`active` pill from the DID document's
  new `registration` block.
- **My identity / Credentials**: an `anchored` pill; the revoked pill continues to reflect status,
  now chain-sourced.

## Out of scope (deliberate)

Wiring `verifyPresentation`'s `trustedIssuers` to the on-chain DID registry — the natural payoff of
`DidRegistry`, but it changes a **fail-closed** compliance path and deserves its own cycle · W3C
BitstringStatusList (herd privacy; low value on a permissioned network) · member sub-DIDs on-chain
(privacy) · per-issuer EVM keys (custodial model makes the platform the signer) · a chain→DB
reconciliation job (the atomic executor makes it unnecessary) · migrating credentials issued before
this cycle (they remain unanchored and honestly report `anchored: false`).
