# Verification Detail + Tx-Hash Surfacing (ID-O) — Design

**Goal:** Make a verification legible and a credential provable. (1) A **verification detail view**: the verifier's result expands into a TalentPass-style step-by-step checklist per credential — signature, issuer trusted (with the on-chain resolution), not expired, subject bound, not revoked — instead of a bare valid/invalid pill. (2) **Tx-hash surfacing**: the blockchain transaction hashes behind a credential (anchor at issuance, revocation) are captured, persisted, and shown wherever the credential appears — holder wallet, public status page, and the verification detail — as explorer links when the chain has an explorer, else as copyable hashes. Fourth and final sub-project of the TalentPass/Sethu gap program (ID-L..O).

**Program context:** The TalentPass verifier video ends on a detail screen: each check on its own row with a tick, and the credential's transaction hash linking to the chain. Our platform already computes almost all of it — `GET /verification-requests/:id/verify` (routes.ts ~2836-2869) builds a per-credential `checks` object `{signature, trusted, notExpired, subjectBound, notRevoked}` plus ID-K's `issuerResolution`, and stores it all in `verifierResult` — but the web renders only the summary pill. Tx hashes are the real gap: `anchorCredential`, `revokeCredential`, and `registerDid` all return a `TxReceipt {txHash, chainId, blockNumber?, timestamp}` and **every call site discards it** (`credential-issuance.ts:35`, `:61`). Nothing persisted ⇒ nothing to show.

**Tech stack:** apps/api (3 nullable Credential columns + capture at the two call sites + projections) + apps/web (verification detail expansion + tx rows on CredentialCard + explorer links). **No core change** (TxReceipt already carries everything). No new dependency.

---

## Tx-hash capture (the persistence bit)

**Model:** `Credential` gains three nullable columns — `anchorTxHash String?`, `anchorChainId String?`, `revokeTxHash String?`. Additive; every existing row stays null (honest: we never recorded their transactions — no backfill, no fabrication). **The full parity checklist applies**: Prisma schema + `CredentialRecord` + prisma row-type + `toCredential` mapper + `create` data literal + both repos, same task, `prisma generate` after the schema edit — plus the memory repo. This is the ID-L lesson's exact shape (new persisted fields), so the live walkthrough must prove the round-trip.

**Capture sites (both in `credential-issuance.ts`):**
- `issueCredentialFor` — keep the receipt: `const receipt = deps.registry ? await …anchorCredential(…) : null`, then `anchorTxHash: receipt?.txHash ?? null, anchorChainId: receipt?.chainId ?? null` in the `credentials.create` input. Anchor-before-persist ordering unchanged.
- `revokeCredentialById` — keep the receipt from `revokeCredential(…)` and pass it through: `CredentialRepository.revoke(id, input)` gains an optional `txHash?: string | null` in its input, written to `revokeTxHash` (both repos). Chain-first ordering unchanged; a registry-absent revoke writes null.

**Out of scope:** org-DID `registerDid` receipts (the registry card already shows `deployTxHash`; per-org DID tx history is a later nicety), Fabric/Canton (the anchor capability is EVM-only by design), and re-anchoring/backfill of pre-ID-O credentials.

## API surface (all additive, nullable, loose-schema-safe)

- **`mapHeld` projection** (`/me/credentials`, `/orgs/:id/wallet`) — adds `anchorTxHash`, `anchorChainId`, `revokeTxHash`.
- **Public `GET /credentials/:id/status`** — adds the same three fields. This is deliberate: the status page is the public proof surface (the certificate QR points at it); the tx hash is the "check it yourself" pointer. Hashes are not secrets — they are on a chain.
- **Verify result per-credential** (`GET /verification-requests/:id/verify`) — STEP 3 already loads `stored = await deps.credentials.get(jti)`; add `anchorTxHash: stored?.anchorTxHash ?? null`, `anchorChainId`, `revokeTxHash` to each returned credential row. Stored `verifierResult`s from before ID-O simply lack the fields — the web tolerates absence.
- Response schemas for these routes are already loose (`additionalProperties: true`) — verify that in the plan, don't assume.

## Web

**Verification detail (the TalentPass screen):** in `VerificationRequests.tsx`, each verified result's credential row gains a "Details" expansion rendering:
1. **Checklist** from the stored `checks` — one row per check with tick/cross styling: Signature valid · Issuer trusted (subtext: the ID-K `issuerResolution` pill — `issuer on-chain · <chainId> · active` / deactivated / not registered) · Not expired · Subject bound to holder · Not revoked (subtext "checked on-chain" when a registry is configured). A failing credential shows exactly which row failed, with the existing `reason` code as subtext on the failing row. Old results without `checks` render the summary only (no fabricated ticks).
2. **Transaction row**: `anchorTxHash` (and `revokeTxHash` when present) as an explorer link when the chain catalog entry for `anchorChainId` has an `explorerUrl` (`${explorerUrl}/tx/${hash}` — the chains list is already loaded app-wide), else a truncated monospace hash with a Copy button. Absent hash ⇒ row hidden.
3. The request-level header keeps today's valid/invalid pill; the detail is purely additive.

**CredentialCard "Details" expander** (holder wallet + org wallet): adds the same transaction row(s) — "Anchored: 0x… ↗" and "Revoked: 0x… ↗" — with the same explorer-link-or-copy behavior. Cards for pre-ID-O credentials show nothing new.

**Verifier UX note:** the detail must render from the RETURNED verify result (and the stored `verifierResult` when re-viewing an old request), not from a fresh credential fetch — the verifier may have no rights to the credential object itself; everything shown must come from the verification result plus the public fields.

## Error handling

- Capture must never fail the operation: the receipt is already in hand when persisted; there is no new failure path at issue time. At revoke, if the DB write of `revokeTxHash` is part of the existing `revoke()` call, the existing semantics (chain revoked + DB write fails ⇒ retryable, chain-first invariant holds) are unchanged.
- Explorer links are best-effort: unknown `anchorChainId` in the chain catalog, or no `explorerUrl` (the local Besu has none) ⇒ copyable hash, never a dead link.
- Old verification results and old credentials degrade to today's rendering — no field is required.

## Testing

- **api:** issue under a FakeAnchor registry → stored credential carries the fake receipt's `txHash`/`chainId`; revoke → `revokeTxHash` set; registry-absent issue/revoke → all three null; `/me/credentials`, public `/status`, and the verify result each expose the fields; a pre-existing credential row (nulls) round-trips through every projection. No existing behavioral test edited.
- **web:** tsc + build; live Besu walkthrough — issue a credential (capture real Besu tx hash) → holder card shows "Anchored: 0x…" → verifier request → consent → verify → detail shows all five checks ticked + the anchor tx; `eth_getTransactionReceipt(anchorTxHash)` independently confirms the hash is a real mined transaction that touched the VcRegistry; revoke → re-verify shows "Not revoked" failing + `revokeTxHash` present, its receipt also confirmed; dev.db untouched.

## Verification / done

Full core (untouched) + api suites green + web tsc/build + the live Besu walkthrough (with `eth_getTransactionReceipt` as the independent proof), then finish the branch (`feat/verification-detail` → main). This closes the TalentPass gap program (ID-L..O complete).

## Alternatives considered

- **Derive tx hashes on demand by scanning chain logs** — no storage change, but requires an archive-capable node, per-request log scans, and breaks for pruned nodes; persisting the receipt at write time is one column write and permanent.
- **A separate CredentialTransaction table** — over-modeled for exactly two hashes per credential; columns keep the parity surface minimal.
- **Recompute checks client-side for the detail view** — the web would need the VP and the trust inputs; the server already computed and stored `checks` per credential — render what was actually checked at verification time, which is also the honest audit record.
- **Backfilling old credentials' hashes** — would require log archaeology and could mis-attribute; nulls are honest and the UI degrades cleanly.
