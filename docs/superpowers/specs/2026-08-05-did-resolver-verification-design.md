# Public W3C DID Resolver Wired into Verification, Anchored on Besu (ID-K) — Design

**Goal:** Give the platform one canonical, **public**, W3C-shaped DID resolver backed by the on-chain `DidRegistry` on Besu, and make verification consume it: VP verification computes issuer trust through the resolver, verification results carry per-issuer on-chain resolution, and a third-party verifier holding only a VC-JWT can independently resolve its issuer DID against the chain. The verify phase proves the whole ID-A..J arc **live on Besu with everything anchored**.

**Program context:** The identity program (ID-A..J) is complete. The OR sub-project already deployed on-chain registries: `DidRegistry` (org DID trust list — `registerDid`, `didRegistration(did) → { registered, active }`, deactivation) and `VcRegistry` (credential anchoring + revocation), reachable via the absent-tolerant `AppDeps.registry` (`{ anchor, didRegistry, vcRegistry, chainId }`). Resolution logic exists but is **scattered**: an authed `GET /dids/:did/document` builds a did:key document inline and appends a non-standard `registration` field (routes.ts:2202-2229); the VP verify route's STEP 1 does its own per-issuer `didRegistration` reads (routes.ts:2583-2607). The Besu network is healthy and mining again (the earlier QBFT wedge cleared).

**Tech stack:** apps/api (new `did-resolver.ts` module + one public route + rewires; **no core change** — resolution composes core's existing `publicKeyFromDidKey` with the registry read) + apps/web (issuer pills in verification results + a resolver link on the credential card). No new persistence, no contract change, no new dependency.

---

## The seam

`resolveDid(did, deps)` in a new `apps/api/src/did-resolver.ts` becomes the single resolution point. It is a composition, not new capability: (a) validate + derive the did:key Ed25519 DID document (pure, same construction as today's document route), and (b) enrich with the on-chain registration state from `deps.registry.anchor.didRegistration` when a registry is configured. Every current ad-hoc resolution site is rewired through it, so trust decisions, the document route, and the new public endpoint can never drift from each other.

## Resolver contract

`resolveDid(did, { registry }) → DidResolutionResult` (never throws; typed results):

```jsonc
{
  "didResolutionMetadata": {
    "contentType": "application/did+ld+json",
    // present ONLY on failure, W3C-registered error strings:
    "error": "invalidDid" | "methodNotSupported"
  },
  "didDocument": {            // null when error is set
    "@context": ["https://www.w3.org/ns/did/v1"],
    "id": "did:key:z6Mk…",
    "verificationMethod": [{ "id": "did:key:z6Mk…#0", "type": "Ed25519VerificationKey2020",
                             "controller": "did:key:z6Mk…", "publicKeyMultibase": "z6Mk…" }],
    "authentication": ["did:key:z6Mk…#0"],
    "assertionMethod": ["did:key:z6Mk…#0"]
  },
  "didDocumentMetadata": {
    // chain-backed, present only when the registry read SUCCEEDED:
    "registered": true, "active": true, "deactivated": false,
    "chainId": "besu", "registry": "0x…",
    "source": "chain",
    // registry absent OR read failed → no chain claims fabricated:
    // { "source": "off-chain" }
  }
}
```

Rules:
- `did:key` Ed25519 only (what core's `publicKeyFromDidKey` supports). A structurally-DID-shaped string of another method → `methodNotSupported`; not DID-shaped / bad multibase → `invalidDid`. HTTP status stays 200 with the error in `didResolutionMetadata` (W3C resolution semantics) — the route never 500s on bad input.
- `deactivated` = `registered && !active` (the DidRegistry's deactivation state). W3C reserves `didDocumentMetadata.deactivated`; we set it truthfully.
- Registry absent **or** the chain read throws → `didDocumentMetadata: { source: "off-chain" }` only. The resolver never converts a read failure into a negative claim (mirrors the status route's case-3 discipline). The read failure is logged by the caller (route) not the module.

## Routes

- **NEW public `GET /dids/:did/resolve`** — no auth (a DID document is public key material; same public posture as `/credentials/:id/status`). Returns the resolution result verbatim. This is the endpoint printed/linked for third-party verification.
- **`GET /dids/:did/document`** (existing, authed) — delegates to `resolveDid` and re-projects to its CURRENT response shape (`{ @context, id, verificationMethod, authentication, assertionMethod, registration }` where `registration` = `{ registered, active, chainId, registry } | null`) so the web client is untouched. Invalid DID keeps its existing 400 `UNSUPPORTED_DID` behavior (back-compat).

## Verification rewire

- **VP verify route, STEP 1 (issuer trust)**: for each presented issuer DID, call `resolveDid`. Trust iff `didDocumentMetadata.source === "chain" && registered && active`. Fallback unchanged: when no registry is configured, the static `trustedKycIssuers` allowlist decides. Chain read failure ⇒ `source: "off-chain"` ⇒ **not trusted** (fail-closed, byte-equivalent to today's behavior — existing verification tests must stay green).
- **Verification result enrichment**: the verify route already builds a per-credential result array (type, revocation). Each entry gains `issuer: { did, registered: boolean | null, active: boolean | null, chainId: string | null }` (nulls when off-chain), reusing the STEP-1 resolutions (one resolve per unique issuer DID, no double reads).

## Web

- **VerificationRequests results**: per verified credential, an issuer pill — `issuer on-chain · <chainId> · active` (green) / `deactivated` (red) / `not registered` (muted) / nothing when the platform runs chainless. Types: the web verification-result type gains the optional `issuer` field.
- **CredentialCard details**: the issuer DID line becomes a link to `${BASE}/dids/<issuerDid>/resolve` (public), alongside the existing status/certificate links — anyone inspecting a held credential can jump to the on-chain resolution.

## Anchored-on-Besu verification run (the point of the exercise)

The verify phase boots the API **against live Besu** (`scripts/dev-boot.sh`-style env: root `.env` + `BESU_RPC_URL`/`BESU_OPERATOR_KEY` defaults + `REGISTRY_CHAIN_ID=besu`, throwaway DB, `dev.db` untouched) and drives the full arc:
1. Provision from the `domicile-certificate` template (ID-J) → issuer org DID **registered on-chain** (boot/provision path already does this).
2. `GET /dids/:did/resolve` (public, no token) → `source: "chain"`, `registered: true`, `active: true` — plus an **independent `eth_call`** against the DidRegistry proving the same.
3. Issue a credential → **anchored in the VcRegistry** (status `source: "chain"`, `anchored: true`; independent `eth_call` of `credentialStatusOf`); the ID-I certificate PDF renders from live chain status.
4. Verifier flow: request → holder consent → verify — the result's per-credential `issuer` shows `registered/active` from Besu; the credential verifies.
5. Revoke (chain-first) → status flips on-chain → re-verify shows revoked; the certificate re-renders with the REVOKED watermark; the resolver still resolves the issuer (revocation is per-credential, not per-DID).
6. (If feasible in the run) deactivate a DID via the registry path and show `deactivated: true` + trust refusal — otherwise covered by the api tests via the registry double.

## Error handling

- Resolver returns typed errors, never throws; the public route always 200s with W3C error metadata for bad DIDs (`invalidDid` / `methodNotSupported`).
- Trust remains fail-closed at every point: off-chain source, read failure, unregistered, or deactivated ⇒ issuer not trusted.
- The public resolver exposes only public key material + on-chain registration state — no org names, no credentials, no PII.
- `GET /dids/:did/document` keeps its exact current contract (shape + 400 on invalid) so no web/client migration is needed.

## Testing

- **api (new `did-resolver` tests):** unit — valid did:key resolves (document fields exact); non-DID string → `invalidDid`; `did:web:…` → `methodNotSupported`; registry absent → `source: "off-chain"`; registry double returning `{registered:true, active:false}` → `deactivated: true`; registry double that throws → `source: "off-chain"` (no chain claims). Route — `/dids/:did/resolve` is public (no token → 200); document-route equivalence (same DID through both routes → same document, old shape preserved).
- **api (verify path):** existing verification tests stay green untouched (trust equivalence); one new test asserting the per-credential `issuer` enrichment (registered/active from the registry double; nulls when chainless).
- **web:** tsc + build; pills render from a result fixture (typecheck-level; visual in the live run).
- **live:** the Besu run above, with independent `eth_call` proofs for the DID registration and the VC anchor, and screenshots of the resolver JSON + verifier pills + anchored certificate.

## Verification / done

Full api suite green (new resolver/enrichment tests + all existing verification tests untouched) + core suite untouched-green + web tsc/build + the live Besu anchored walkthrough, then finish the branch (`feat/did-resolver` → main).

## Alternatives considered

- **A universal-resolver microservice** (uniresolver-style, multi-method) — heavy; the platform mints only did:key custodial DIDs, so a single-method in-process resolver is the honest scope. The W3C result shape means a future `did:web`/`did:ethr` driver slots into the same contract.
- **Making `/dids/:did/document` itself public** instead of a new endpoint — would change an existing authed contract and still not be W3C resolution-shaped; a parallel public `/resolve` keeps back-compat and standards alignment.
- **Resolver in packages/core** — core has no chain access (registry lives in api deps); putting composition in api keeps core pure and avoids widening core's surface for zero reuse.
- **Caching resolutions** — Besu reads are millisecond-local `eth_call`s; caching adds staleness risk to trust decisions for no measurable win. Out of scope.
