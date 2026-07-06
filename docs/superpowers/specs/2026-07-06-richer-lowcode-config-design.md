# Richer Low-Code Configuration

**Date:** 2026-07-06
**Status:** Approved
**Feature cycle 2 of 3** (analytics dashboard done; secondary-market trading next.)

## Problem / goal

A use case today can declare only shallow config: metadata fields limited to
`string`/`number`/`boolean` with no validation, a `compliance` object whose
`transferRestrictions` flag is **declared but never enforced** (only `allowlist`
and `freeze` do anything), and no fee concept. This cycle deepens the low-code
surface across three areas — richer metadata, real compliance rules, and fees —
all as optional, backward-compatible additions.

## Approved decisions

- Build all three areas in one cycle.
- **Documents are URL references**, not uploaded binaries (no file store — that's
  a separate infra project).
- **Compliance rules are enforced in the engine** (the single policy chokepoint)
  via an injected `ComplianceProvider`, not scattered across API handlers.
- All new config fields are OPTIONAL; existing use cases keep working unchanged.

## Design

### A. Richer metadata (schema + validation + UI)

`PropertySchema` (packages/core/src/types.ts) gains optional, type-appropriate
constraints and a new field type:

```ts
interface PropertySchema {
  type: "string" | "number" | "boolean" | "document";
  description?: string;
  enum?: string[];      // string fields → a fixed choice list (dropdown)
  min?: number;         // number fields → inclusive lower bound
  max?: number;         // number fields → inclusive upper bound
  pattern?: string;     // string fields → RegExp the value must match
}
```

- `type: "document"` — the field value is a **URL** (link to a prospectus / terms
  / KYC doc). Validated as an `http(s)` URL.
- `validateMetadata` (packages/core/src/validation.ts) enforces: enum membership,
  numeric `min`/`max`, string `pattern`, and document URL format. Type errors and
  constraint violations are collected and thrown together (existing
  `INVALID_METADATA` envelope).
- `validateUseCaseDefinition` rejects contradictory field config: `min > max`,
  `enum` on a non-string field, `pattern` that doesn't compile, `enum`/`min`/`max`
  on `boolean`.
- **Web:** the builder's field editor (`UseCaseBuilder`) gains a type dropdown
  including `enum`/`document`, plus per-type inputs (enum values as a comma list,
  min/max, pattern). The issue form (`IssuePanel`) renders `enum` as a `<select>`,
  numbers with `min`/`max` attributes, `document` as a URL input, and shows the
  field description as a hint.

### B. Declarative compliance rules (engine-enforced)

The use case `compliance` object gains optional rules:

```ts
compliance: {
  allowlist: boolean;
  transferRestrictions: boolean;   // retained; now DERIVED = (any granular rule set)
  maxHolders?: number;             // cap on distinct positive-balance holders
  lockupDays?: number;             // no transfer of tokens within N days of acquisition
  allowedJurisdictions?: string[]; // holder KYC `country` must be in this set (ISO-ish codes)
}
```

- **ComplianceProvider (new core interface, injected into `LifecycleEngine`):**
  ```ts
  interface ComplianceProvider {
    holderCount(ref: AssetRef): Promise<number>;                    // distinct positive-balance holders
    acquiredAt(ref: AssetRef, account: string): Promise<string | null>; // ISO of that account's first acquisition
    jurisdictionOf(account: string): Promise<string | null>;        // holder address → KYC country
  }
  ```
  The API wires it from repos: `holderCount`/`acquiredAt` derived from the audit
  stream (same net-balance/earliest-credit logic the analytics feature uses —
  factor the shared helper out of `analytics.ts` into a reusable module);
  `jurisdictionOf` maps address → the user whose `accountId` resolves to that
  address → `kyc.country`.
- **Enforcement** (in the engine's existing chokepoint, alongside
  `requireAllowed`/`requireNotFrozen`):
  - `maxHolders`: on a mint/transfer/buy that would create a NEW holder (recipient
    currently zero balance), require `holderCount < maxHolders`, else
    `HOLDER_LIMIT_EXCEEDED`.
  - `lockupDays`: on transfer/buy, require
    `now − acquiredAt(from) ≥ lockupDays`, else `LOCKUP_ACTIVE`. (Applies to the
    sender's tokens; minting to treasury is exempt.)
  - `allowedJurisdictions`: on mint/transfer/buy to an account, require
    `jurisdictionOf(to) ∈ allowedJurisdictions`, else `JURISDICTION_NOT_ALLOWED`.
    A holder with no KYC country is rejected when the rule is set.
- New `PolicyErrorCode`s: `HOLDER_LIMIT_EXCEEDED`, `LOCKUP_ACTIVE`,
  `JURISDICTION_NOT_ALLOWED`. The engine calls the provider only when the relevant
  rule is set (no overhead for use cases that don't use them).
- Rules apply uniformly across every ledger (policy is chain-agnostic, in the
  engine — Fabric/EVM/simulated all enforce identically).

### C. Fees & sale-terms config

The use case gains:

```ts
fees?: { marketplaceBps?: number; issuanceFlat?: string };  // bps 0..10000; issuanceFlat integer string
saleTermsDefault?: { unitPrice?: string; currency?: string };
```

- **Marketplace fee:** during a DvP buy (`POST /assets/:id/buy`), split the buyer's
  payment — `fee = floor(cost × marketplaceBps / 10000)` goes to a **platform fee
  account** (a configured/seeded address, e.g. `PLATFORM_FEE_ACCOUNT`), the
  remainder to the treasury — using the existing `cash.transfer`, still atomic
  (buyer needs `cost` total; if either leg fails, compensate/refund as today).
  The audit `buy` entry records the fee.
- **Issuance fee:** a flat CBDC amount charged from the issuer's cash to the fee
  account at issue time (when `issuanceFlat` is set and a fee currency is
  determinable from the sale terms / a default). If the issuer lacks funds →
  `INSUFFICIENT_FUNDS`, issuance aborts before minting.
- **saleTermsDefault:** pre-fills the issue form's price/currency; not enforced
  (an issuer can override).
- **Validation:** `marketplaceBps` in `0..10000`; `issuanceFlat` a non-negative
  integer string; fee amounts never negative.

### Data flow

Config authored in the builder → validated (`validateUseCaseDefinition`) →
persisted on the `UseCase` (Prisma: extend the `metadataSchema`/`compliance` JSON
columns; add `fees` + `saleTermsDefault` JSON columns). At issuance/transfer/buy,
the engine reads the use case, evaluates stateless rules directly and
data-dependent rules via the injected `ComplianceProvider`, and the API layer
applies fee cash movements around the engine call.

### Error handling

- Config-time: contradictory schema/compliance/fee config → `INVALID_USECASE`
  with a specific message; nothing persisted.
- Runtime: each rule violation → its typed `PolicyError`, surfaced through the
  existing uniform error envelope, with actionable messages (which rule, the
  limit/lockup/jurisdiction, the offending account).
- A `ComplianceProvider` lookup failure is treated as a policy failure (fail
  closed), never silently allowed.

### Testing

- **Core:** `validation.test.ts` — enum/min/max/pattern/document + contradictory
  config. `lifecycle-engine.test.ts` — each compliance rule via a **fake
  `ComplianceProvider`** (holder limit boundary, lockup before/after, jurisdiction
  allowed/blocked/missing) and the no-rule fast path. Fee math unit tests.
- **API:** create a use case with the new config (deploys on sim chains); issue +
  buy exercising the marketplace fee split (fee account credited, treasury gets
  remainder) and issuance fee; a buy blocked by holder-limit/lockup/jurisdiction
  returns the right code; the shared holder/acquisition helper extracted from
  analytics still powers the dashboard (analytics tests stay green).
- **Web:** typecheck + build; the builder round-trips the new field/compliance/fee
  config; issue form renders enum/number/document inputs.
- Full suite green (`pnpm -r test`) + typecheck.

## Migration

- Prisma `UseCase`: add `fees` (JSON, default `"{}"`) and `saleTermsDefault`
  (JSON, default `"{}"`); `metadataSchema`/`compliance` are already JSON columns
  (new keys need no column change). Seed config use cases unchanged (all new fields
  optional). Existing volumes: additive columns with defaults — safe `db push`.
- A `PLATFORM_FEE_ACCOUNT` address is seeded (a demo account) and configurable via
  env; if unset, marketplace/issuance fees default to 0 (disabled) regardless of
  use-case config, so nothing breaks without it.

## Out of scope

- Uploaded/stored document binaries (URL references only); transfer fees (no cash
  leg on operator transfers); per-tier/graduated fees; time-varying jurisdiction
  lists; on-chain enforcement of these rules (enforced in the engine/platform,
  consistent with the current compliance model); KYC-provider integration.
