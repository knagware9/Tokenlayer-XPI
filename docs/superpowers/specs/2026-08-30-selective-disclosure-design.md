# Selective Disclosure — Design

## Summary

A holder can choose, per claim field of a credential they're presenting, to share the value, prove a threshold predicate over it (numeric fields only — reveals only true/false, never the value), or withhold it entirely. A verifier can request specific fields — and, for numeric fields, request a predicate instead of a raw value — but that request is always advisory: the holder has final say per field and can disclose less than asked without being blocked from consenting at all.

This is **platform-mediated** disclosure, not cryptographic (SD-JWT). The underlying VC-JWT is unchanged and still contains every claim — protection is enforced by what the API returns during the existing consent → verify flow, which is the only path through which a verification actually happens on this platform today (`/verify` already never returns the raw `vcJwt`, only a server-built `claims` view). It does not protect a credential a holder exports via "Copy VC-JWT" and hands to a verifier outside the platform — that capability is unaffected and out of scope here.

## Goals

- Verifier can, per requested credential type, ask for specific fields — as a plain value or, for numeric fields, as a threshold predicate (`gte`/`lte`/`gt`/`lt`/`eq` + threshold).
- Holder can, per field of each credential they consent to present, choose: share the value, share only a predicate result, or withhold — independent of what was requested.
- A predicate's threshold and operator are always the holder's own choice at consent time (pre-filled from the request as a convenience only).
- Existing (pre-feature) consent calls and previously-consented requests continue to behave exactly as before — full disclosure, no migration required.

## Non-goals

- Cryptographic selective disclosure (SD-JWT or similar) — the VC-JWT format and issuance are unchanged.
- Predicates on non-numeric fields (string equality, set membership, regex, date-specific operators) — only `number`-typed claim fields, per the existing `claimSchema`.
- Any protection for a credential exported via "Copy VC-JWT"/"Download" and presented outside this platform.
- Rate-limiting or anti-enumeration for repeated predicate queries. **Known, accepted limitation:** a verifier who can send many differently-thresholded predicate requests over time could in principle narrow in on a holder's exact value (e.g. `≤2005?`, `≤2010?`, `≤2011?`). This is inherent to predicate disclosure generally and is not mitigated in this pass.

## Data model

File: `apps/api/src/persistence/types/identity.ts`

`VerificationRequestRecord` gains one field:

```ts
requestedFields: Record<string /* credential type name */, Record<string /* field name */, FieldRequest>> | null;
```

```ts
export type FieldRequest =
  | { kind: "value" }
  | { kind: "predicate"; op: "gte" | "lte" | "gt" | "lt" | "eq"; threshold: number };
```

`consent` (currently `{ vpJwt, credentialIds, at }` on `VerificationRequestRepository.setConsented`) gains a second, optional structure alongside `credentialIds` — supplied by the API route, not stored verbatim:

```ts
// Route input (POST /verification-requests/:id/consent body)
disclosures?: Record<string /* credentialId */, Record<string /* field name */, DisclosureChoice>>;

type DisclosureChoice =
  | { kind: "value" }
  | { kind: "predicate"; op: "gte" | "lte" | "gt" | "lt" | "eq"; threshold: number }
  | { kind: "withhold" };
```

The server resolves `disclosures` against the real claim values **at consent time** and persists the result — never the holder's raw predicate inputs, and never a raw value for a withheld or predicate-disclosed field:

```ts
// New field on VerificationRequestRecord
consentedDisclosures: Record<string /* credentialId */, Record<string /* field */, ResolvedDisclosure>> | null;

type ResolvedDisclosure =
  | { kind: "value"; value: unknown }
  | { kind: "predicate"; op: "gte" | "lte" | "gt" | "lt" | "eq"; threshold: number; result: boolean };
// a withheld field has no entry — absence IS withholding
```

`setConsented`'s signature extends to accept the resolved disclosures:

```ts
setConsented(id: string, input: { vpJwt: string; credentialIds: string[]; at: string; disclosures: Record<string, Record<string, ResolvedDisclosure>> | null }): Promise<VerificationRequestRecord>;
```

Both `MemoryVerificationRequestRepository` and `PrismaVerificationRequestRepository` implementations need the new field threaded through (Prisma: a new nullable JSON/text column, following the same pattern already used for `verifierResult`).

## API behavior

### `POST /verification-requests` (create — `apps/api/src/http/routes/identity.ts`)

Schema (`apps/api/src/http/schemas/identity.ts`) gains optional `requestedFields`, validated against the relevant credential type's `claimSchema` (from the selected use case's `credentialTypes[]`, or the built-in catalog when no use case is given):

- Every field name under `requestedFields[type]` must exist in that type's `claimSchema.properties` → else `400 UNKNOWN_FIELD`.
- `kind: "predicate"` is only accepted when `claimSchema.properties[field].type === "number"` → else `400 INVALID_PREDICATE_FIELD`.

### `POST /verification-requests/:id/consent` (`apps/api/src/http/routes/identity.ts` and the holder's own-inbox path in `apps/api/src/http/routes/shared.ts` — both call the same consent logic)

Schema gains optional `disclosures`. For each `credentialId` present in the (existing, unchanged) `credentialIds` list:

- If `disclosures[credentialId]` is absent entirely: every field of that credential's `claims` discloses in full — **byte-identical to today's behavior**.
- If present, only listed fields are affected; fields of that credential not mentioned in `disclosures[credentialId]` still default to full-value disclosure (this keeps a partial `disclosures` payload safe — omission never means "withhold" for individual fields, only `kind: "withhold"` does. Only the *credential's presence in* `disclosures` narrows anything, and only for the fields explicitly named).
- Each named field must exist in that credential's actual `claims` → else `400 UNKNOWN_FIELD`.
- `kind: "predicate"` requires `typeof claims[field] === "number"` → else `400 INVALID_PREDICATE_FIELD`.
- The server evaluates `claims[field] <op> threshold` immediately and writes `{ kind: "predicate", op, threshold, result }` into `consentedDisclosures` — the raw value is read once, used for the comparison, and discarded; it is never written to `consentedDisclosures` or returned anywhere from this point on.
- `kind: "withhold"` writes no entry for that field (absence).
- `kind: "value"` (or an unmentioned field) writes `{ kind: "value", value: claims[field] }`.

**Visibility of `consentedDisclosures`:** the existing `vreqView()` projection (`apps/api/src/identity/verification-request-view.ts`) deliberately excludes `verifierResult` from every general listing (`GET /verification-requests`, `GET /me/verification-requests`) and surfaces it only through the dedicated `/verify` route. `consentedDisclosures` follows the same precedent — excluded from `vreqView()`, computed into the response only inside the `/verify` handler. This isn't a new exposure (the holder already chose to disclose exactly this data at consent time, and the verifier is the one calling `/verify`), it just keeps one consistent rule for "where does the disclosed/verified payload become visible" rather than introducing a second one.

### `GET /verification-requests/:id/verify` (`apps/api/src/http/routes/identity.ts`)

Per credential in the result, the returned `claims` object is built from `consentedDisclosures[credentialId]` when present:

- A `kind: "value"` entry → `{ [field]: value }`, same shape as today.
- A `kind: "predicate"` entry → `{ [field]: { predicate: { op, threshold, result } } }` — visibly distinct from a plain value.
- A field absent from `consentedDisclosures[credentialId]` (withheld) → absent from the returned claims, same as any missing field today.
- A request with no `consentedDisclosures` at all (consented before this feature shipped, or consented via the old `credentialIds`-only shape) → falls back to the full `claims` object exactly as today. **No backfill or migration needed** — this is a pure runtime fallback on a nullable field.

### `GET /me/verification-requests` (`apps/api/src/http/routes/shared.ts`)

`eligibleCredentials` (currently `{ id, type, issuerDid, issuerName, issuedAt, expiresAt }`, added earlier this session) gains `claims: Record<string, unknown>` so the holder's consent UI can render one row per field without a second round-trip. This is the holder's own inbox for their own credentials — no new exposure, the holder already has access to these claims via `GET /me/credentials`.

## Web UI

### Verifier side — `apps/web/src/components/identity/VerificationRequests.tsx`

Once a credential type checkbox is checked, an expandable "Request specific fields (optional)" region appears beneath it, listing that type's fields from `claimSchema.properties` (available on both `CredentialUseCase.credentialTypes[]` and the generic `CredentialTypeInfo` catalog — both already carry `claimSchema`). Per field: a checkbox to request it, and — only when `claimSchema.properties[field].type === "number"` — a toggle between "as a value" (default when checked) and "as a threshold check" (reveals an operator `<select>` of the five ops + a number `<input>` for the threshold). Unchecked fields are omitted from the submitted `requestedFields`; if the section is never touched, `requestedFields` is omitted entirely and behavior is unchanged from today.

### Holder side — `apps/web/src/components/identity/VerificationInbox.tsx`

Once a candidate credential's checkbox is checked (existing behavior, unchanged), its fields expand inline beneath it — one row per key in that credential's `claims`. Per field: a "requested" hint when `request.requestedFields?.[credential.type]?.[field]` exists (showing the verifier's suggested op/threshold when it's a predicate request), and a 3-way radio: **Share value** / **Share as threshold check** (numeric fields only — its own operator+threshold inputs, pre-filled from the request if it named this field as a predicate, otherwise blank) / **Withhold**. Default per field: matches the request if the field was requested (either kind), else **Withhold**. The existing "Consent & present" button now also sends the built `disclosures` map alongside `credentialIds`; if the holder never opens a field's controls, that field keeps its default (withhold-unless-requested).

### Verifier's result view — `apps/web/src/components/identity/VerificationRequests.tsx` (result panel)

The current flat `Object.entries(c.claims).map(([k,v]) => \`${k}: ${String(v)}\`)` render needs to branch: a value whose shape is `{ predicate: { op, threshold, result } }` renders as `field: ≤ 2011 ✓` (operator symbol, threshold, check/cross for `result`) instead of being stringified as `[object Object]`. Every other value renders exactly as today. Withheld fields are already invisible today (they're just absent from `claims`) — no change needed there.

## Backward compatibility

- All new fields (`requestedFields`, `consentedDisclosures`) are nullable/optional everywhere — existing rows, existing API callers, and existing tests that never send them are unaffected.
- The consent route's fallback-to-full-disclosure when `disclosures` is absent means every existing integration or UI flow that only ever sends `credentialIds` keeps working byte-for-byte.
- The verify route's fallback-to-full-`claims` when `consentedDisclosures` is null covers every request consented before this feature existed.

## Testing plan

New file: `apps/api/test/selective-disclosure.test.ts`, covering:

- Requesting a predicate on a non-numeric field is refused (`INVALID_PREDICATE_FIELD`) at both create-request and consent time.
- Requesting/disclosing a field that doesn't exist on the type/credential is refused (`UNKNOWN_FIELD`) at both points.
- A predicate consent evaluates correctly (`true` and `false` cases) and `/verify`'s response never contains the raw value for that field — only `{ predicate: { op, threshold, result } }`.
- A withheld field is absent from `/verify`'s response.
- Holder disclosing **fewer** fields than the verifier requested still succeeds — consent is never blocked by an incomplete selection.
- A holder-volunteered predicate on a field the verifier didn't request (or requested as a plain value) is honored — disclosure choice always overrides the request.
- Old-shape consent (`credentialIds` only, no `disclosures`) still discloses every field in full, and `/verify` still returns full claims for a request consented this way.
- A request consented before this feature (no `consentedDisclosures` in the fixture) falls back to full claims on `/verify`.

Existing tests exercising `/verify`'s claims shape (if any assert on the exact object) get checked for compatibility as part of implementation — none should need behavior changes since the default path is unchanged.
