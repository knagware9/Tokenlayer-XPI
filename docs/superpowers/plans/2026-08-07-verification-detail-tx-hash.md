# Verification Detail + Tx-Hash Surfacing (ID-O) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the blockchain transaction hashes behind every credential (anchor at issuance, revocation), surface them on every credential surface, and render the verifier's already-stored per-credential checks as a TalentPass-style step-by-step detail.

**Architecture:** Three nullable `Credential` columns (`anchorTxHash`, `anchorChainId`, `revokeTxHash`) captured from the `TxReceipt`s that `anchorCredential`/`revokeCredential` already return but every call site discards (`apps/api/src/credential-issuance.ts:35`, `:61`). Additive projections on `/me/credentials`, org wallet, public `/status`, and the verify result. Web: a structured checklist replacing the compact `sig ✓ trusted ✓ …` line in VerificationRequests, plus tx rows there and on CredentialCard — explorer link when the chain has `explorerUrl`, copyable hash otherwise. **No core change** (`TxReceipt {txHash, chainId, …}` already exists), no new dependency, no backfill (old rows stay null; UI degrades).

**Tech Stack:** apps/api (Fastify + Prisma/SQLite + memory repos, vitest) + apps/web (React + Vite + Tailwind).

**Spec:** `docs/superpowers/specs/2026-08-07-verification-detail-tx-hash-design.md` — read it first.

**Branch:** create `feat/verification-detail` off main before Task O1.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/prisma/schema.prisma` | modify | 3 nullable columns on `model Credential` |
| `apps/api/src/persistence/types.ts` | modify | `CredentialRecord` fields + `revoke()` input gains `txHash?` |
| `apps/api/src/persistence/memory.ts` | modify | create/clone/revoke carry the new fields |
| `apps/api/src/persistence/prisma.ts` | modify | row-type + `toCredential` mapper + create data + revoke data |
| `apps/api/src/credential-issuance.ts` | modify | capture receipts at both call sites |
| `apps/api/src/http/routes.ts` | modify | `mapHeld` + `/credentials/:id/status` + verify STEP 3 projections; revoke call sites pass receipts? (no — see O1) |
| `apps/api/test/tx-hash.test.ts` | create | capture + projection tests |
| `apps/web/src/types.ts` | modify | `HeldCredential` + verify-result credential type gain the 3 fields |
| `apps/web/src/lib/explorers.ts` | create | `explorerTxUrl(chains, chainId, hash)` |
| `apps/web/src/components/VerificationRequests.tsx` | modify | step-by-step checklist + tx rows |
| `apps/web/src/components/CredentialCard.tsx` | modify | anchor/revoke tx rows in Details |
| `apps/web/src/components/MyIdentity.tsx` / `OrganizationWallet.tsx` | modify | fetch chains, pass to CredentialCard |

**Hard rules (standing):** never edit an existing behavioral test; persistence fields land in schema + types + BOTH repos in one commit and `pnpm --filter @tokenlayer/api exec prisma generate` runs after the schema edit (THE parity lesson — the live walkthrough must prove the Prisma round-trip); loose response schemas for new nested fields; kill APIs by port.

---

### Task O1: Persistence + capture — tx hashes stored at issue and revoke

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model Credential, ~line 245)
- Modify: `apps/api/src/persistence/types.ts` (`CredentialRecord` ~404, `CredentialRepository.revoke` ~433)
- Modify: `apps/api/src/persistence/memory.ts` (`MemoryCredentialRepository` ~508)
- Modify: `apps/api/src/persistence/prisma.ts` (`toCredential` ~816, `PrismaCredentialRepository` ~831)
- Modify: `apps/api/src/credential-issuance.ts` (both functions)
- Test: `apps/api/test/tx-hash.test.ts` (created here, grows in O2)

- [ ] **Step 1: Write the failing tests.** Create `apps/api/test/tx-hash.test.ts`. Mirror the registry wiring used by `apps/api/test/corporate.test.ts` (`new FakeAnchor()` + `fakeRegistry(anchor)` passed to `buildTestApp` — read that file for the exact option name before writing). The FakeAnchor's receipts look like `{ txHash: "0xfake…", chainId: "besu", timestamp }` (`apps/api/test/fake-anchor.ts:19-21`).

```ts
import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

/** Identity use case + one issued credential; returns holder token + credential id. */
async function issueOne(app: Awaited<ReturnType<typeof buildTestApp>>) {
  const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  const key = `txh-${Math.random().toString(36).slice(2)}`;
  const mk = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: {
    key, name: "TxHash UC",
    credentialTypes: [{ name: "ScoreCredential", title: "Score", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  } });
  expect(mk.statusCode).toBe(201);
  const email = `txh-${Math.random().toString(36).slice(2)}@x.dev`;
  await onboardUser(app, admin, admin2, { email, password: "secret123", role: "Holder", useCaseKey: key });
  const users = (await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) })).json() as { id: string; email: string }[];
  const draft = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(admin),
    payload: { credentialType: "ScoreCredential", subjectUserId: users.find((u) => u.email === email)!.id, claims: { legalName: "T" } } });
  expect(draft.statusCode).toBe(202);
  await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  const holder = await loginAs(app, email, "secret123");
  const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holder) })).json()
    .find((c: { type: string[] }) => c.type.includes("ScoreCredential"));
  return { admin, admin2, holder, credId: held.id as string, key };
}

describe("tx-hash capture (ID-O task O1)", () => {
  it("issuing under a registry stores the anchor receipt's txHash + chainId", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) }); // ← confirm option name in helpers.ts
    const { credId } = await issueOne(app);
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(await loginAs(app, "admin@tokenlayer.dev", "admin123")) })); // placeholder — real assertion reads the repo via a projection in O2; HERE assert through the deps if buildTestApp exposes them, else via /credentials/:id/status after O2. For O1, assert through the public status route ONLY IF already projecting — otherwise read the stored record directly:
    // Preferred O1 assertion: buildTestApp exposes its deps (check helpers.ts). If it does:
    //   const stored = await app.deps.credentials.get(credId);
    //   expect(stored!.anchorTxHash).toMatch(/^0xfake/); expect(stored!.anchorChainId).toBe("besu");
  });

  it("revoking under a registry stores the revoke receipt's txHash", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const { admin, admin2, credId } = await issueOne(app);
    const rv = await app.inject({ method: "POST", url: `${V1}/credentials/${credId}/revoke`, headers: auth(admin), payload: { reason: "test" } });
    expect(rv.statusCode).toBe(202);
    await app.inject({ method: "POST", url: `${V1}/proposals/${rv.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    // same access pattern as above: stored.revokeTxHash toMatch(/^0xfake/)
  });

  it("without a registry all three fields stay null", async () => {
    const app = await buildTestApp(); // no registry
    const { credId } = await issueOne(app);
    // stored.anchorTxHash === null, anchorChainId === null, revokeTxHash === null
  });
});
```

IMPORTANT for the implementer: the comments above mark the ONE thing you must resolve from the codebase — how a test reaches the stored record (check whether `buildTestApp` returns/exposes its `deps`; several suites do direct repo assertions — find one and copy its access pattern; if none exists, do the O1 assertions through a temporary direct import of the app's deps or defer the read-side assertion to the `/me/credentials` projection and write it in this file under O2's describe instead — but the capture tests MUST exist and fail before you implement). Replace the placeholder lines with real assertions; no commented-out expectations may remain in the committed file.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/api exec vitest run test/tx-hash.test.ts` fails (fields undefined / type errors).

- [ ] **Step 3: Schema.** In `apps/api/prisma/schema.prisma`, `model Credential`, after `acceptanceNote String?`:

```prisma
  // ID-O: receipts of the on-chain writes behind this credential (null when
  // issued/revoked without a registry, or before ID-O — no backfill).
  anchorTxHash  String?
  anchorChainId String?
  revokeTxHash  String?
```

Run: `pnpm --filter @tokenlayer/api exec prisma generate` (and `prisma db push` is NOT needed for tests — memory harness — but the walkthrough DB will get it via db push at boot).

- [ ] **Step 4: Types.** In `apps/api/src/persistence/types.ts`, `CredentialRecord` after `acceptanceNote`:

```ts
  /** Receipt of the on-chain anchor write at issuance (null: no registry / pre-ID-O). */
  anchorTxHash: string | null;
  anchorChainId: string | null;
  /** Receipt of the on-chain revoke write (null until revoked on-chain). */
  revokeTxHash: string | null;
```

And widen `revoke`:

```ts
  revoke(id: string, input: { reason: string; by: string; at: string; txHash?: string | null }): Promise<CredentialRecord>;
```

- [ ] **Step 5: Both repos (same commit).**

`memory.ts` — `create` already spreads the input (`{ ...input }`), so nothing to add there; `revoke` gains:

```ts
    rec.revokeTxHash = input.txHash ?? null;
```

(after the existing `rec.revokedAt = input.at;` line).

`prisma.ts` — extend the `toCredential` row-type + mapper with the three fields (`anchorTxHash: r.anchorTxHash, anchorChainId: r.anchorChainId, revokeTxHash: r.revokeTxHash` — plain string passthroughs), the `create` data literal (`anchorTxHash: input.anchorTxHash, anchorChainId: input.anchorChainId, revokeTxHash: input.revokeTxHash`), and `revoke`:

```ts
      data: { revoked: true, revokedReason: input.reason, revokedBy: input.by, revokedAt: new Date(input.at), revokeTxHash: input.txHash ?? null },
```

- [ ] **Step 6: Capture.** In `apps/api/src/credential-issuance.ts`:

`issueCredentialFor` — replace the anchor block + add to the create input:

```ts
  // Anchor BEFORE persisting: a throw here fails the caller and no row exists.
  // Keep the receipt — the tx hash is the credential's public on-chain pointer (ID-O).
  let anchorReceipt: { txHash: string; chainId: string } | null = null;
  if (deps.registry) {
    anchorReceipt = await deps.registry.anchor.anchorCredential(deps.registry.vcRegistry, credentialId, vcJwt, now, expiresAt);
  }
```

and in the `deps.credentials.create({ … })` literal (after `acceptanceNote` or wherever the ID-L fields sit):

```ts
    anchorTxHash: anchorReceipt?.txHash ?? null,
    anchorChainId: anchorReceipt?.chainId ?? null,
    revokeTxHash: null,
```

(If `create` call sites exist elsewhere — grep `credentials.create(` — every OTHER call site must also supply the three fields, `null`s where no receipt exists. The `Omit`-input trick used for `Proposal.result` is an alternative if there are many sites; prefer explicit nulls if there are ≤2.)

`revokeCredentialById` — capture and pass through:

```ts
  let revokeReceipt: { txHash: string } | null = null;
  if (deps.registry) {
    revokeReceipt = await deps.registry.anchor.revokeCredential(deps.registry.vcRegistry, cred.id);
  }
  await deps.credentials.revoke(cred.id, { ...meta, txHash: revokeReceipt?.txHash ?? null });
```

- [ ] **Step 7: Green.** Target file passes; `pnpm --filter @tokenlayer/api exec tsc --noEmit` clean; **full suite** `pnpm --filter @tokenlayer/api test` green (the widened record type may ripple into other create sites — tsc finds them; fix with explicit nulls).

- [ ] **Step 8: Commit** — `feat(api): persist anchor/revoke tx receipts on Credential`.

---

### Task O2: API projections — expose the hashes everywhere the spec says

**Files:**
- Modify: `apps/api/src/http/routes.ts` (`mapHeld` ~2196, `/credentials/:id/status` ~2529, verify STEP 3 ~2862)
- Modify: `apps/api/src/http/schemas.ts` ONLY if a response schema strips the new fields (check first)
- Test: `apps/api/test/tx-hash.test.ts` (extend)

- [ ] **Step 1: Failing tests** (append a describe "tx-hash projections (O2)"):
1. `/me/credentials` row carries `anchorTxHash` matching `/^0xfake/`, `anchorChainId: "besu"`, `revokeTxHash: null`; after revoke, `revokeTxHash` matches `/^0xfake/`.
2. Public `GET /credentials/:id/status` (no auth header) carries all three fields, both under a registry (source "chain") and with `buildTestApp()` no-registry (nulls, source "database").
3. Full verify flow (mirror an existing verify test — e.g. the ID-K besu-anchored or VP flow test — for request→consent→verify mechanics) → each per-credential result row carries `anchorTxHash`/`anchorChainId`/`revokeTxHash`.

- [ ] **Step 2: Implement.**
- `mapHeld` return object gains: `anchorTxHash: c.anchorTxHash, anchorChainId: c.anchorChainId, revokeTxHash: c.revokeTxHash,`
- `/credentials/:id/status`: add the three fields to `fromDb` (they then flow through both the database and chain return paths):

```ts
    const fromDb = {
      id: cred.id, revoked: cred.revoked, revokedAt: cred.revokedAt, reason: cred.revokedReason,
      anchorTxHash: cred.anchorTxHash, anchorChainId: cred.anchorChainId, revokeTxHash: cred.revokeTxHash,
      ...(cred.acceptance !== "accepted" || cred.acceptanceAt !== null ? { acceptance: cred.acceptance } : {}),
    };
```

- Verify STEP 3: the per-credential map already loads `stored`; hoist it so the return can use it (it is currently scoped inside `if (jti)` — restructure minimally, e.g. `let stored: CredentialRecord | null = null;` before the `if`), then add to the returned row:

```ts
        anchorTxHash: stored?.anchorTxHash ?? null,
        anchorChainId: stored?.anchorChainId ?? null,
        revokeTxHash: stored?.revokeTxHash ?? null,
```

- Schemas: check `myCredentials` / `orgWallet` / `credentialStatus` / the verify-result schema in `schemas.ts`. Any with `additionalProperties: true` (or no 200 body) needs nothing; any strict property list must gain the three nullable string properties. Do NOT restructure schemas beyond that.

- [ ] **Step 3: Green** — target file + full api suite + tsc. **No existing test edited** (the `/status` shape change is additive; if any exact-shape legacy test breaks, STOP and use the ID-L conditional-inclusion pattern instead — include the fields only when non-null — and note the deviation).

- [ ] **Step 4: Commit** — `feat(api): surface anchor/revoke tx hashes on wallet, status, and verify result`.

---

### Task O3: Web — verification detail checklist + tx rows

**Files:**
- Modify: `apps/web/src/types.ts`
- Create: `apps/web/src/lib/explorers.ts`
- Modify: `apps/web/src/components/VerificationRequests.tsx`
- Modify: `apps/web/src/components/CredentialCard.tsx`
- Modify: `apps/web/src/components/MyIdentity.tsx`, `apps/web/src/components/OrganizationWallet.tsx`

- [ ] **Step 1: Types.** In `types.ts`: `HeldCredential` gains `anchorTxHash?: string | null; anchorChainId?: string | null; revokeTxHash?: string | null;` and the verify-result per-credential type (find it — the type backing `result.credentials` in VerificationRequests) gains the same three optional fields. Optional (`?`) everywhere — old stored results lack them.

- [ ] **Step 2: Explorer helper.** Create `apps/web/src/lib/explorers.ts`:

```ts
import type { ChainInfo } from "../types.js";

/** Explorer tx URL for a hash, or null when the chain has no explorer (local Besu). */
export function explorerTxUrl(chains: ChainInfo[] | undefined, chainId: string | null | undefined, hash: string): string | null {
  if (!chains || !chainId) return null;
  const base = chains.find((c) => c.id === chainId)?.explorerUrl;
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}
```

(Verify `ChainInfo` has `explorerUrl?` in types.ts — the API Chain schema exposes it; add the optional field to the web type if missing.)

- [ ] **Step 3: TxHashRow.** Shared row (put it in `CredentialCard.tsx` and export, or a tiny `TxHashRow.tsx` — follow whichever pattern siblings use for tiny shared bits; `CredentialCard` is already the shared credential UI home):

```tsx
export function TxHashRow({ label, hash, chainId, chains }: {
  label: string; hash: string; chainId?: string | null; chains?: ChainInfo[];
}): JSX.Element {
  const url = explorerTxUrl(chains, chainId, hash);
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      {url
        ? <a className="font-mono text-brand-600 hover:text-brand-700" href={url} target="_blank" rel="noreferrer">{short} ↗</a>
        : <span className="font-mono text-slate-700">{short}</span>}
      <button className="text-slate-400 hover:text-slate-600" title="Copy transaction hash"
        onClick={() => void navigator.clipboard.writeText(hash)}>Copy</button>
    </div>
  );
}
```

- [ ] **Step 4: VerificationRequests checklist.** Replace the compact inline check spans (`sig ✓ trusted ✓ not-expired ✓ subject ✓ not-revoked ✓`, ~lines 93-95) with a structured checklist per credential. Shape (adapt to the surrounding card markup):

```tsx
const CHECK_ROWS = [
  { key: "signature", label: "Signature valid" },
  { key: "trusted", label: "Issuer trusted" },
  { key: "notExpired", label: "Not expired" },
  { key: "subjectBound", label: "Subject bound to holder" },
  { key: "notRevoked", label: "Not revoked" },
] as const;
```

Per credential, when `c.checks` is present render one row per entry: pass = green tick (✓) + label; fail = red cross (✗) + label + the credential's `reason` code as small subtext ON the failing row only. Under "Issuer trusted", keep the existing `issuerResolution` pill as subtext (move it there from wherever it renders now). Under "Not revoked", subtext "checked on-chain" when `c.issuerResolution` exists (registry-backed run). After the checklist, render `TxHashRow`s for `c.anchorTxHash` ("Anchored") and `c.revokeTxHash` ("Revoked") when present, passing `c.anchorChainId` + the chains list. When `c.checks` is ABSENT (pre-ID-O stored result), keep today's compact rendering — no fabricated ticks. Fetch chains once in the component: `const [chains, setChains] = useState<ChainInfo[]>(); useEffect(() => { if (token) api.chains(token).then(setChains).catch(() => setChains([])); }, [token]);`.

- [ ] **Step 5: CredentialCard.** In the Details expansion (near the Copy VC-JWT / Download row), add when present:

```tsx
{c.anchorTxHash && <TxHashRow label="Anchored" hash={c.anchorTxHash} chainId={c.anchorChainId} chains={chains} />}
{c.revokeTxHash && <TxHashRow label="Revoked" hash={c.revokeTxHash} chainId={c.anchorChainId} chains={chains} />}
```

`chains` arrives as a NEW OPTIONAL prop on CredentialCard (`chains?: ChainInfo[]`) — absent ⇒ copyable hash, no link. `MyIdentity` and `OrganizationWallet` fetch `api.chains(token)` once and pass it down. Do not make chains required — other CredentialCard call sites must compile unchanged.

- [ ] **Step 6: Green** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` + `pnpm --filter @tokenlayer/web build`.

- [ ] **Step 7: Commit** — `feat(web): verification detail checklist + tx-hash rows with explorer links`.

---

### Task O4: Verify — suites + live Besu walkthrough + review + finish

- [ ] **Step 1: Full verification** — `tsc --noEmit` on core/adapters/api/web (contracts is known-broken on main — pre-existing hardhat typechain noise, skip it), core 227, api full suite, web build.

- [ ] **Step 2: Live Besu walkthrough** (scratchpad script, NOT committed; standard boot recipe with a throwaway `dev-odemo.db`, kill-by-port teardown, dev.db untouched):
1. Provision a domicile program; issue one credential (single or ID-M batch).
2. Holder's `/me/credentials` row carries a real `anchorTxHash` + `anchorChainId: "besu"`.
3. **INDEPENDENT PROOF:** `eth_getTransactionReceipt(anchorTxHash)` → status `0x1`, `to` === the VcRegistry address from `GET /registry`.
4. Public `/credentials/:id/status` carries the same hash (no auth).
5. Verifier request → consent → verify → per-credential result: all five `checks` true + `anchorTxHash` present; the stored `verifierResult` (re-GET the request) carries it too.
6. Revoke → `revokeTxHash` persisted (Prisma round-trip proof — THE parity check) + `eth_getTransactionReceipt(revokeTxHash)` mined; re-verify → `notRevoked: false`, `valid: false`.
7. Teardown; `apps/api/prisma/dev.db` untouched.

Optionally: browser preview — verifier detail shows the checklist + tx hash; holder card Details shows "Anchored: 0x…".

- [ ] **Step 3: Final whole-branch review** — focus: capture-site correctness (anchor-before-persist and chain-first-revoke orderings unchanged), parity (all Prisma literals), no existing test edited, additive schemas, checklist honesty (no ticks without `checks`), explorer-link fallback.

- [ ] **Step 4: Finish** — superpowers:finishing-a-development-branch, standing option 1: merge `feat/verification-detail` → main `--no-ff`, delete branch, update `identity-domain-program` memory (**ID-O merged — TalentPass gap program ID-L..O COMPLETE**).

---

## Self-review notes

- Spec coverage: capture (O1), projections incl. public status + verify result (O2), checklist + tx rows + explorer fallback (O3), eth_getTransactionReceipt independent proof + finish (O4). Out-of-scope items (org-DID receipts, backfill, Fabric/Canton) appear in no task — correct.
- Known unknowns are flagged inline for the implementer rather than guessed: `buildTestApp`'s registry option name and deps exposure (O1 Step 1), other `credentials.create` call sites (O1 Step 6), schema strictness per route (O2), the verify-result type name in web types (O3).
- Type consistency: `anchorTxHash`/`anchorChainId`/`revokeTxHash` spelled identically across schema, record, projections, and web types; `revoke()`'s widened input is optional so existing callers compile unchanged.
