# Invoice Tokenization Use Case (TReDS / M1xchange POC)

**Date:** 2026-07-07
**Status:** Implemented (low-code use case)
**Source:** "Invoice Tokenization on M1xchange — Proof-of-Concept Concept Note" (v1.0, July 2026)

## What the document asks for

Represent each RBI/TReDS-approved invoice as a **permissioned digital token**
carrying a tamper-evident record of status, ownership, and financing history, to
prove three things in a sandboxed POC:
1. **Integrity** — full, independently auditable lifecycle history per token.
2. **No double financing** — the network rejects tokenizing the same invoice twice.
3. **Transferability** — compliant financier-to-financier transfer (KYC/eligibility
   enforced automatically), the building block for a secondary market.

Recommended stack: a **permissioned ledger (Hyperledger Fabric primary, Besu/QBFT
alternative)** with an **ERC-3643-aligned compliance interface**, sensitive data
off-ledger with only hashes on-ledger.

## How it maps onto TokenLayer (no code changes needed)

The POC is expressible as one low-code use case — `config/use-cases/invoice-tokenization.json`:

| POC requirement | Platform realisation |
|---|---|
| One permissioned token per approved invoice | ERC-721 use case (`INVT`); the use-case contract is the invoice collection; **each invoice = one tokenId** |
| Uniqueness / duplicate-financing prevention | **tokenId = the invoice fingerprint hash** (`invoiceHash`, `0x` + 64 hex, validated by pattern). All three ledger implementations (Fabric chaincode `MintToken`, `ComplianceNFT.sol`, simulated) reject an existing tokenId — duplicates are blocked by the ledger itself |
| Permissioned, KYC-gated holders (financiers) | `compliance.allowlist: true` + platform KYC gating + `allowedJurisdictions: ["IN"]` (holder's KYC country must be IN) |
| Financier-to-financier transfer under compliance | `transferToken` through the engine chokepoint (allowlist, freeze, jurisdiction enforced uniformly on every ledger) |
| Ledger: Fabric primary, Besu alternative | `allowedChainIds: ["fabric", "besu"]`, `defaultChainId: "fabric"` — both run as real ledgers here (Fabric test-network + tokenlayer chaincode; Besu dev node) |
| Privacy by design: docs off-ledger, hash on-ledger | Metadata carries `invoiceDocUrl` (`document`-type field → validated URL into the off-ledger vault) + `invoiceHash`; the token URI can carry the vault link |
| Lifecycle Uploaded → Accepted → Financed → Repaid/Defaulted | Platform lifecycle mapping: **mint** = tokenize (on buyer acceptance/financing), **transfer** = assignment between financiers, **burn** = repaid at maturity (closes the lifecycle), **freeze** = default/dispute hold. Full state history in the immutable audit log |
| Validated invoice data | Cycle-2 metadata validation: GSTIN `pattern` on seller/buyer, `amountInr` min, `dueDate` date pattern, `discountRatePct` 0–100 |
| Actors | `UseCaseAdmin` = M1 operator, `Issuer` = onboarding desk, `Buyer` = financier (bank/NBFC), `Auditor` = RBI read-only |

## Out of scope (matching the doc's own POC exclusions)

Live settlement/NACH integration, GST/e-invoice validation shims, securitisation
pooling & waterfalls (doc Phase 3), regulator read-node provisioning, public-chain
deployment.

## Proof executed (see session log)

Live on the **real Fabric network** (tokenlayer chaincode on `mychannel`):
use-case creation deploys the collection contract; two invoices tokenized with
validated metadata; a duplicate-hash mint is rejected on-ledger; a compliant
financier→financier transfer succeeds while a non-whitelisted transfer is blocked;
repayment burn closes one lifecycle; the audit trail records every transition.
