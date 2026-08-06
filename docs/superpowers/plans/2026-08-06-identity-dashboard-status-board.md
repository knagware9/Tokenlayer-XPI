# Identity Dashboard + Credential Status Board (ID-N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scoped, read-only identity operations dashboard — stat tiles over the ID-L credential lifecycle, a 30-day issued-activity strip, a filterable credential status board, and verification counters — served by one authed route over a pure aggregation fold.

**Architecture:** Two new repo `list()` methods (memory + prisma, parity enforced by the `implements` clause) feed a pure `computeIdentityDashboard` fold in a new `apps/api/src/identity-analytics.ts` (mirrors `analytics.ts`: no I/O, injectable `now`). One route `GET /identity/dashboard` resolves the caller's scope (PlatformAdmin all / OrgAdmin own-org-issuer / identity desk own use case / everyone else 403), loads + filters, folds, returns. Web adds an `IdentityDashboard.tsx` view and a nav item in three App.tsx branches. **No core change, no schema migration, no new dependency, no new writes.**

**Tech Stack:** apps/api (Fastify + vitest, memory-harness tests via `buildTestApp`), apps/web (React + Vite + Tailwind).

**Spec:** `docs/superpowers/specs/2026-08-06-identity-dashboard-status-board-design.md` — read it first; the derived-status precedence (rejected BEFORE revoked) is deliberate and explained there.

**Branch:** create `feat/identity-dashboard` off main before Task N1.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/persistence/types.ts` | modify | `list()` on `CredentialRepository` + `VerificationRequestRepository` |
| `apps/api/src/persistence/memory.ts` | modify | memory `list()` impls |
| `apps/api/src/persistence/prisma.ts` | modify | prisma `list()` impls |
| `apps/api/src/identity-analytics.ts` | create | pure fold: types + `derivedCredentialStatus` + `computeIdentityDashboard` |
| `apps/api/src/http/routes.ts` | modify | `GET /identity/dashboard` (scope resolve → load → fold) |
| `apps/api/src/http/schemas.ts` | modify | `identityDashboard` schema (loose 200) |
| `apps/api/test/identity-analytics.test.ts` | create | unit tests for the pure fold |
| `apps/api/test/identity-dashboard.test.ts` | create | route tests (scope isolation, lifecycle counts, 403s) |
| `apps/web/src/types.ts` | modify | dashboard response types |
| `apps/web/src/api.ts` | modify | `identityDashboard()` client |
| `apps/web/src/components/IdentityDashboard.tsx` | create | tiles + activity strip + verification card + status board |
| `apps/web/src/domains.ts` | modify | `"identity-dashboard": "identity"` in `NAV_DOMAIN` |
| `apps/web/src/App.tsx` | modify | nav item + panel in platform, org/desk, and identity-desk branches |

**Hard rules carried from prior sub-projects:**
- Never edit an existing behavioral test (they are the back-compat oracle). New assertions go in the new test files only.
- Any repo interface change must land in `types.ts` + `memory.ts` + `prisma.ts` **in the same commit** — `implements` makes tsc the parity cop here (no new columns, so no Prisma schema/mapper work and no `prisma generate` needed).
- New route 200 schemas stay loose (`additionalProperties: true`) — fast-json-stringify strips undeclared nested fields.
- Kill any stray API by port (`lsof -ti tcp:4000 | xargs kill -9`), never `pkill -f tsx`.

---

### Task N1: Persistence — `list()` on credential + verification repos

**Files:**
- Modify: `apps/api/src/persistence/types.ts` (~line 426 `CredentialRepository`, ~line 470 `VerificationRequestRepository`)
- Modify: `apps/api/src/persistence/memory.ts` (~line 508 `MemoryCredentialRepository`, ~line 561 `MemoryVerificationRequestRepository`)
- Modify: `apps/api/src/persistence/prisma.ts` (~line 831 `PrismaCredentialRepository`, ~line 906 `PrismaVerificationRequestRepository`)
- Test: `apps/api/test/identity-dashboard.test.ts` (created here, grows in N3)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/identity-dashboard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository, MemoryVerificationRequestRepository } from "../src/persistence/memory.js";
import type { CredentialRecord } from "../src/persistence/types.js";

const cred = (id: string, over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id, holderDid: `did:key:h-${id}`, issuerDid: "did:key:issuer", type: "ScoreCredential",
  vcJwt: "jwt", subjectClaims: {}, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
  credentialUseCaseKey: "uc-a", acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  ...over,
});

describe("repo list() (ID-N task N1)", () => {
  it("MemoryCredentialRepository.list returns every stored credential", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.create(cred("c1"));
    await repo.create(cred("c2", { credentialUseCaseKey: null }));
    const all = await repo.list();
    expect(all.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("MemoryVerificationRequestRepository.list returns every request", async () => {
    const repo = new MemoryVerificationRequestRepository();
    await repo.create({
      verifierOrgId: "org-1", holderDid: "did:key:h", requestedTypes: ["ScoreCredential"],
      purpose: "p", credentialUseCaseKey: "uc-a", challenge: "ch", status: "pending",
      presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
      verifierResult: null, verifiedAt: null, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect((await repo.list())).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-dashboard.test.ts`
Expected: FAIL — `repo.list is not a function` (and a tsc error in the editor).

- [ ] **Step 3: Add the interface methods**

In `apps/api/src/persistence/types.ts`, inside `CredentialRepository` after `listByIssuer`:

```ts
  /** Every stored credential, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<CredentialRecord[]>;
```

Inside `VerificationRequestRepository` after `listByVerifierOrg`:

```ts
  /** Every stored request, unordered — dashboard aggregation input (callers sort/filter). */
  list(): Promise<VerificationRequestRecord[]>;
```

- [ ] **Step 4: Implement in BOTH repos (same commit — the parity rule)**

`apps/api/src/persistence/memory.ts` — in `MemoryCredentialRepository` after `listByIssuer`:

```ts
  async list(): Promise<CredentialRecord[]> {
    return [...this.byId.values()];
  }
```

In `MemoryVerificationRequestRepository` after `listByVerifierOrg`:

```ts
  async list(): Promise<VerificationRequestRecord[]> {
    return [...this.byId.values()];
  }
```

`apps/api/src/persistence/prisma.ts` — in `PrismaCredentialRepository` after `listByIssuer`:

```ts
  async list(): Promise<CredentialRecord[]> {
    return (await prisma.credential.findMany()).map(toCredential);
  }
```

In `PrismaVerificationRequestRepository` (after `listByVerifierOrg`):

```ts
  async list(): Promise<VerificationRequestRecord[]> {
    return (await prisma.verificationRequest.findMany()).map(toVerificationRequest);
  }
```

No `orderBy` on purpose: the fold sorts what it needs; documenting the lists as unordered stops callers from depending on backend-specific ordering.

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-dashboard.test.ts` → PASS.
Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit` → clean (proves BOTH classes satisfy the widened interfaces).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/persistence/types.ts apps/api/src/persistence/memory.ts apps/api/src/persistence/prisma.ts apps/api/test/identity-dashboard.test.ts
git commit -m "feat(api): credential + verification repo list() for dashboard aggregation"
```

---

### Task N2: API — pure `identity-analytics.ts` fold

**Files:**
- Create: `apps/api/src/identity-analytics.ts`
- Test: `apps/api/test/identity-analytics.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/identity-analytics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeIdentityDashboard, derivedCredentialStatus } from "../src/identity-analytics.js";
import type { CredentialRecord, VerificationRequestRecord } from "../src/persistence/types.js";
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";

const NOW = "2026-08-06T12:00:00.000Z";

const uc = (key: string, types: string[] = ["ScoreCredential"]): CredentialUseCaseDefinition => ({
  key, name: `UC ${key}`,
  credentialTypes: types.map((name) => ({ name, title: name, validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: [], properties: {} } })),
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
});

const cred = (id: string, over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id, holderDid: `did:key:h-${id}`, issuerDid: "did:key:issuer", type: "ScoreCredential",
  vcJwt: "jwt", subjectClaims: {}, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
  credentialUseCaseKey: "uc-a", acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  ...over,
});

const vreq = (id: string, over: Partial<VerificationRequestRecord> = {}): VerificationRequestRecord => ({
  id, verifierOrgId: "org-1", holderDid: "did:key:h", requestedTypes: ["ScoreCredential"],
  purpose: "p", credentialUseCaseKey: "uc-a", challenge: "ch", status: "pending",
  presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
  verifierResult: null, verifiedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z", ...over,
});

const fold = (over: Partial<Parameters<typeof computeIdentityDashboard>[0]> = {}) =>
  computeIdentityDashboard({
    useCases: [uc("uc-a")], credentials: [], verifications: [],
    holderLabels: new Map(), now: NOW, days: 30, ...over,
  });

describe("derivedCredentialStatus", () => {
  it("rejected wins over revoked (ID-L reject revokes on-chain first)", () => {
    expect(derivedCredentialStatus({ revoked: true, expiresAt: null, acceptance: "rejected" }, NOW)).toBe("rejected");
  });
  it("revoked wins over expired", () => {
    expect(derivedCredentialStatus({ revoked: true, expiresAt: "2020-01-01T00:00:00.000Z", acceptance: "accepted" }, NOW)).toBe("revoked");
  });
  it("expired wins over acceptance", () => {
    expect(derivedCredentialStatus({ revoked: false, expiresAt: "2020-01-01T00:00:00.000Z", acceptance: "pending" }, NOW)).toBe("expired");
  });
  it("otherwise the acceptance state", () => {
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "pending" }, NOW)).toBe("pending");
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "changes_requested" }, NOW)).toBe("changes_requested");
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "accepted" }, NOW)).toBe("accepted");
  });
});

describe("computeIdentityDashboard", () => {
  it("totals partition issued across the six states", () => {
    const d = fold({ credentials: [
      cred("c1"),
      cred("c2", { acceptance: "pending" }),
      cred("c3", { acceptance: "changes_requested" }),
      cred("c4", { acceptance: "rejected", revoked: true }),
      cred("c5", { revoked: true }),
      cred("c6", { expiresAt: "2026-01-01T00:00:00.000Z" }),
    ] });
    expect(d.totals).toEqual({ issued: 6, accepted: 1, pendingAcceptance: 1, changesRequested: 1, rejectedByHolder: 1, revoked: 1, expired: 1 });
    const sum = d.totals.accepted + d.totals.pendingAcceptance + d.totals.changesRequested
      + d.totals.rejectedByHolder + d.totals.revoked + d.totals.expired;
    expect(sum).toBe(d.totals.issued);
  });

  it("drops credentials outside the scoped use cases (incl. null-key catalog credentials)", () => {
    const d = fold({ credentials: [cred("c1"), cred("c2", { credentialUseCaseKey: null }), cred("c3", { credentialUseCaseKey: "other" })] });
    expect(d.totals.issued).toBe(1);
  });

  it("byUseCase seeds every configured type at zero and buckets per type", () => {
    const d = fold({
      useCases: [uc("uc-a", ["ScoreCredential", "BadgeCredential"])],
      credentials: [cred("c1"), cred("c2", { acceptance: "pending" })],
    });
    expect(d.byUseCase).toHaveLength(1);
    const types = Object.fromEntries(d.byUseCase[0]!.byType.map((t) => [t.type, t.counts]));
    expect(types.ScoreCredential!.issued).toBe(2);
    expect(types.BadgeCredential!.issued).toBe(0);
  });

  it("board: newest first, capped at 200, boardTotal uncapped, labels resolved with DID fallback", () => {
    const creds = Array.from({ length: 205 }, (_, i) =>
      cred(`c${i}`, { issuedAt: `2026-07-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` }));
    const labels = new Map([[creds[0]!.holderDid, "holder0@x.dev"]]);
    const d = fold({ credentials: creds, holderLabels: labels });
    expect(d.board).toHaveLength(200);
    expect(d.boardTotal).toBe(205);
    expect(d.board[0]!.issuedAt >= d.board[199]!.issuedAt).toBe(true);
    const labeled = d.board.find((r) => r.credentialId === "c0");
    if (labeled) expect(labeled.holderLabel).toBe("holder0@x.dev");
    const unlabeled = d.board.find((r) => r.credentialId !== "c0");
    expect(unlabeled!.holderLabel).toContain("…"); // truncated DID fallback
  });

  it("board rows carry the changes-requested note, and only then", () => {
    const d = fold({ credentials: [
      cred("c1", { acceptance: "changes_requested", acceptanceNote: "fix the name" }),
      cred("c2", { acceptance: "accepted", acceptanceNote: "stale note" }),
    ] });
    const byId = Object.fromEntries(d.board.map((r) => [r.credentialId, r]));
    expect(byId.c1!.acceptanceNote).toBe("fix the name");
    expect(byId.c2!.acceptanceNote).toBeNull();
  });

  it("activity buckets issuance per UTC day over the window", () => {
    const d = fold({ credentials: [
      cred("c1", { issuedAt: "2026-08-05T23:59:00.000Z" }),
      cred("c2", { issuedAt: "2026-08-05T01:00:00.000Z" }),
      cred("c3", { issuedAt: "2026-08-06T00:01:00.000Z" }),
      cred("c4", { issuedAt: "2026-06-01T00:00:00.000Z" }), // outside window: not bucketed
    ] });
    expect(d.activity).toHaveLength(30);
    expect(d.activity[d.activity.length - 1]).toEqual({ date: "2026-08-06", issued: 1 });
    expect(d.activity[d.activity.length - 2]).toEqual({ date: "2026-08-05", issued: 2 });
    expect(d.activity[0]!.date).toBe("2026-07-08");
  });

  it("verification: consented splits into verifiedValid/verifiedInvalid by stored result", () => {
    const d = fold({ verifications: [
      vreq("v1"),
      vreq("v2", { status: "consented" }),
      vreq("v3", { status: "consented", verifierResult: { valid: true } }),
      vreq("v4", { status: "consented", verifierResult: { valid: false } }),
      vreq("v5", { status: "rejected" }),
      vreq("v6", { status: "expired" }),
      vreq("v7", { credentialUseCaseKey: null }), // catalog request: excluded
    ] });
    expect(d.verification).toEqual({ pending: 1, consented: 1, rejected: 1, expired: 1, verifiedValid: 1, verifiedInvalid: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-analytics.test.ts`
Expected: FAIL — module `../src/identity-analytics.js` not found.

- [ ] **Step 3: Implement `apps/api/src/identity-analytics.ts`**

```ts
/**
 * Pure identity-dashboard aggregation (ID-N). Takes already-loaded,
 * already-scope-filtered data and folds it into stat tiles, a per-use-case
 * breakdown, a capped status board, an issued-per-day activity window, and
 * verification counters. No I/O — `now` is injected so tests are deterministic.
 * Mirrors the tokenization analytics.ts contract.
 */
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";
import type { CredentialRecord, VerificationRequestRecord } from "./persistence/types.js";

/** One pill per credential. Precedence: rejected → revoked → expired → acceptance.
 *  Rejected is checked FIRST because ID-L's holder-reject revokes on-chain before
 *  recording the rejection — revoked-first would zero the rejected tile forever. */
export type DerivedCredentialStatus = "accepted" | "pending" | "changes_requested" | "rejected" | "revoked" | "expired";

export function derivedCredentialStatus(
  c: Pick<CredentialRecord, "revoked" | "expiresAt" | "acceptance">,
  now: string,
): DerivedCredentialStatus {
  if (c.acceptance === "rejected") return "rejected";
  if (c.revoked) return "revoked";
  // Both sides are Date.toISOString() output (fixed-width UTC), so string order = time order.
  if (c.expiresAt && c.expiresAt < now) return "expired";
  return c.acceptance;
}

export interface StatusCounts {
  issued: number;
  accepted: number;
  pendingAcceptance: number;
  changesRequested: number;
  rejectedByHolder: number;
  revoked: number;
  expired: number;
}

export interface UseCaseTypeCounts { type: string; counts: StatusCounts }
export interface DashboardUseCase { key: string; name: string; counts: StatusCounts; byType: UseCaseTypeCounts[] }

export interface BoardRow {
  credentialId: string;
  useCaseKey: string;
  useCaseName: string;
  type: string;
  holderDid: string;
  holderLabel: string;
  issuedAt: string;
  expiresAt: string | null;
  status: DerivedCredentialStatus;
  /** Only populated while the status is changes_requested (the TalentPass table shows the reason inline). */
  acceptanceNote: string | null;
}

export interface ActivityDayRow { date: string; issued: number }

export interface VerificationCounts {
  pending: number;
  /** Consented but not yet verified by the verifier. */
  consented: number;
  rejected: number;
  expired: number;
  verifiedValid: number;
  verifiedInvalid: number;
}

export interface IdentityDashboard {
  totals: StatusCounts;
  byUseCase: DashboardUseCase[];
  board: BoardRow[];
  boardTotal: number;
  activity: ActivityDayRow[];
  verification: VerificationCounts;
}

export interface IdentityDashboardInput {
  /** The caller's scoped slice of the credential use-case catalog. */
  useCases: CredentialUseCaseDefinition[];
  /** May be pre-filtered by the route; the fold re-filters against `useCases` regardless. */
  credentials: CredentialRecord[];
  verifications: VerificationRequestRecord[];
  /** holderDid → display label (user email / org name). Misses fall back to a truncated DID. */
  holderLabels: Map<string, string>;
  now: string;
  days: number;
}

const BOARD_CAP = 200;

const zeroCounts = (): StatusCounts =>
  ({ issued: 0, accepted: 0, pendingAcceptance: 0, changesRequested: 0, rejectedByHolder: 0, revoked: 0, expired: 0 });

const COUNT_FIELD: Record<DerivedCredentialStatus, keyof Omit<StatusCounts, "issued">> = {
  accepted: "accepted", pending: "pendingAcceptance", changes_requested: "changesRequested",
  rejected: "rejectedByHolder", revoked: "revoked", expired: "expired",
};

const truncateDid = (did: string): string => (did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-4)}` : did);

export function computeIdentityDashboard(input: IdentityDashboardInput): IdentityDashboard {
  const nameByKey = new Map(input.useCases.map((u) => [u.key, u.name]));

  // Defense in depth: only credentials/requests inside the scope count, even if
  // the route's pre-filter and this disagree.
  const creds = input.credentials.filter((c) => c.credentialUseCaseKey !== null && nameByKey.has(c.credentialUseCaseKey));
  const vreqs = input.verifications.filter((v) => v.credentialUseCaseKey !== null && nameByKey.has(v.credentialUseCaseKey));

  const totals = zeroCounts();
  // Seed every configured type at zero so an idle type still renders a row.
  const perUseCase = new Map<string, { counts: StatusCounts; byType: Map<string, StatusCounts> }>();
  for (const u of input.useCases) {
    perUseCase.set(u.key, { counts: zeroCounts(), byType: new Map(u.credentialTypes.map((t) => [t.name, zeroCounts()])) });
  }

  for (const c of creds) {
    const status = derivedCredentialStatus(c, input.now);
    const ucAgg = perUseCase.get(c.credentialUseCaseKey!)!;
    let typeAgg = ucAgg.byType.get(c.type);
    if (!typeAgg) { typeAgg = zeroCounts(); ucAgg.byType.set(c.type, typeAgg); } // type renamed since issuance
    for (const bucket of [totals, ucAgg.counts, typeAgg]) {
      bucket.issued += 1;
      bucket[COUNT_FIELD[status]] += 1;
    }
  }

  const byUseCase: DashboardUseCase[] = input.useCases.map((u) => {
    const agg = perUseCase.get(u.key)!;
    return { key: u.key, name: u.name, counts: agg.counts, byType: [...agg.byType].map(([type, counts]) => ({ type, counts })) };
  });

  const board: BoardRow[] = [...creds]
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    .slice(0, BOARD_CAP)
    .map((c) => {
      const status = derivedCredentialStatus(c, input.now);
      return {
        credentialId: c.id,
        useCaseKey: c.credentialUseCaseKey!,
        useCaseName: nameByKey.get(c.credentialUseCaseKey!) ?? c.credentialUseCaseKey!,
        type: c.type,
        holderDid: c.holderDid,
        holderLabel: input.holderLabels.get(c.holderDid) ?? truncateDid(c.holderDid),
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        status,
        acceptanceNote: status === "changes_requested" ? c.acceptanceNote : null,
      };
    });

  // Last `days` UTC days ending on `now`'s date, oldest first.
  const dayMs = 24 * 60 * 60 * 1000;
  const end = Date.parse(input.now.slice(0, 10) + "T00:00:00.000Z");
  const byDay = new Map<string, number>();
  for (const c of creds) {
    const day = c.issuedAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const activity: ActivityDayRow[] = [];
  for (let i = input.days - 1; i >= 0; i--) {
    const date = new Date(end - i * dayMs).toISOString().slice(0, 10);
    activity.push({ date, issued: byDay.get(date) ?? 0 });
  }

  const verification: VerificationCounts = { pending: 0, consented: 0, rejected: 0, expired: 0, verifiedValid: 0, verifiedInvalid: 0 };
  for (const v of vreqs) {
    if (v.status === "pending") verification.pending += 1;
    else if (v.status === "rejected") verification.rejected += 1;
    else if (v.status === "expired") verification.expired += 1;
    else if (v.status === "consented") {
      if (v.verifierResult === null) verification.consented += 1;
      else if (v.verifierResult.valid === true) verification.verifiedValid += 1;
      else verification.verifiedInvalid += 1;
    }
  }

  return { totals, byUseCase, board, boardTotal: creds.length, activity, verification };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-analytics.test.ts` → PASS (all).
Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/identity-analytics.ts apps/api/test/identity-analytics.test.ts
git commit -m "feat(api): pure identity-dashboard fold (derived status, board, activity, verification counters)"
```

---

### Task N3: API — `GET /identity/dashboard` route + schema + scope tests

**Files:**
- Modify: `apps/api/src/http/routes.ts` (place the route near the existing `/analytics` route, ~line 1289)
- Modify: `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/identity-dashboard.test.ts` (extend the N1 file)

- [ ] **Step 1: Write the failing route tests**

Append to `apps/api/test/identity-dashboard.test.ts` (the N1 imports stay; add these):

```ts
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

interface DashTotals { issued: number; accepted: number; pendingAcceptance: number; changesRequested: number; rejectedByHolder: number; revoked: number; expired: number }
interface Dash {
  totals: DashTotals;
  byUseCase: { key: string; name: string; counts: DashTotals; byType: { type: string; counts: DashTotals }[] }[];
  board: { credentialId: string; holderLabel: string; status: string; acceptanceNote: string | null }[];
  boardTotal: number;
  activity: { date: string; issued: number }[];
  verification: { pending: number; consented: number; rejected: number; expired: number; verifiedValid: number; verifiedInvalid: number };
}

/** Identity use case with one Score type; `over` may flip holderAcceptance or rebind the issuer. */
async function seedDashUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, key: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key, name: `Dash UC ${key}`,
    credentialTypes: [{ name: "ScoreCredential", title: "Score", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return key;
}

/** Issue one credential to `email` under `key` (maker admin, checker admin2) and return its holder token + credential id. */
async function issueTo(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, admin2: string, key: string, email: string) {
  const users = (await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) })).json() as { id: string; email: string }[];
  const subjectUserId = users.find((u) => u.email === email)!.id;
  const draft = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(admin),
    payload: { credentialType: "ScoreCredential", subjectUserId, claims: { legalName: email } } });
  expect(draft.statusCode).toBe(202);
  const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);
}

const dash = async (app: Awaited<ReturnType<typeof buildTestApp>>, token: string) => {
  const res = await app.inject({ method: "GET", url: `${V1}/identity/dashboard`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as Dash;
};

describe("GET /identity/dashboard (ID-N task N3)", () => {
  it("lifecycle counts move: pending → accepted → revoked; catalog (null-key) credentials never counted", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, `dash-life-${Math.random().toString(36).slice(2)}`, { holderAcceptance: true });
    const email = `dash-h-${Math.random().toString(36).slice(2)}@x.dev`;
    // onboardUser mints an onboarding KYC credential with credentialUseCaseKey null —
    // the dashboard must NOT count it.
    await onboardUser(app, admin, admin2, { email, password: "secret123", role: "Holder", useCaseKey: key });
    const baseline = await dash(app, admin);
    expect(baseline.byUseCase.find((u) => u.key === key)!.counts.issued).toBe(0); // onboarding KYC (null key) not counted

    await issueTo(app, admin, admin2, key, email);
    let d = await dash(app, admin);
    const mine = d.byUseCase.find((u) => u.key === key)!;
    expect(mine.counts).toMatchObject({ issued: 1, pendingAcceptance: 1, accepted: 0 });
    expect(d.board.some((r) => r.status === "pending" && r.holderLabel === email)).toBe(true);

    const holder = await loginAs(app, email, "secret123");
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holder) })).json()
      .find((c: { type: string[] }) => c.type.includes("ScoreCredential"));
    await app.inject({ method: "POST", url: `${V1}/me/credentials/${held.id}/accept`, headers: auth(holder), payload: {} });
    d = await dash(app, admin);
    expect(d.byUseCase.find((u) => u.key === key)!.counts).toMatchObject({ issued: 1, pendingAcceptance: 0, accepted: 1 });

    const revoke = await app.inject({ method: "POST", url: `${V1}/credentials/${held.id}/revoke`, headers: auth(admin),
      payload: { reason: "test" } });
    expect(revoke.statusCode).toBe(202);
    await app.inject({ method: "POST", url: `${V1}/proposals/${revoke.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    d = await dash(app, admin);
    expect(d.byUseCase.find((u) => u.key === key)!.counts).toMatchObject({ issued: 1, accepted: 0, revoked: 1 });
  });

  it("scope isolation: an identity desk sees only its own use case; PlatformAdmin sees both", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await seedDashUseCase(app, admin, `dash-a-${Math.random().toString(36).slice(2)}`);
    const keyB = await seedDashUseCase(app, admin, `dash-b-${Math.random().toString(36).slice(2)}`);
    const emailA = `dash-a-${Math.random().toString(36).slice(2)}@x.dev`;
    const emailB = `dash-b-${Math.random().toString(36).slice(2)}@x.dev`;
    await onboardUser(app, admin, admin2, { email: emailA, password: "secret123", role: "Holder", useCaseKey: keyA });
    await onboardUser(app, admin, admin2, { email: emailB, password: "secret123", role: "Holder", useCaseKey: keyB });
    await issueTo(app, admin, admin2, keyA, emailA);
    await issueTo(app, admin, admin2, keyB, emailB);

    const deskEmail = `dash-desk-${Math.random().toString(36).slice(2)}@x.dev`;
    await onboardUser(app, admin, admin2, { email: deskEmail, password: "secret123", role: "Issuer", useCaseKey: keyA });
    const desk = await loginAs(app, deskEmail, "secret123");

    const deskDash = await dash(app, desk);
    expect(deskDash.byUseCase.map((u) => u.key)).toEqual([keyA]);
    expect(deskDash.totals.issued).toBe(1);

    const adminDash = await dash(app, admin);
    const keys = adminDash.byUseCase.map((u) => u.key);
    expect(keys).toContain(keyA);
    expect(keys).toContain(keyB);
  });

  it("OrgAdmin sees own-org-issuer use cases only; an OrgAdmin with none gets a zeroed dashboard", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const orgA = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `Dash Org A ${Math.random().toString(36).slice(2)}`, orgType: "corporate" } })).json();
    const orgB = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `Dash Org B ${Math.random().toString(36).slice(2)}`, orgType: "corporate" } })).json();
    const mkA = await app.inject({ method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `dash-oa-${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(mkA.statusCode).toBe(201);
    const mkB = await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(admin),
      payload: { email: `dash-ob-${orgB.id}@x.io`, password: "secret1", role: "OrgAdmin" } });
    expect(mkB.statusCode).toBe(201);
    const keyA = await seedDashUseCase(app, admin, `dash-orga-${Math.random().toString(36).slice(2)}`, { issuer: { kind: "org", orgId: orgA.id } });

    const orgAdminA = await loginAs(app, `dash-oa-${orgA.id}@x.io`, "secret1");
    const dA = await dash(app, orgAdminA);
    expect(dA.byUseCase.map((u) => u.key)).toEqual([keyA]);

    const orgAdminB = await loginAs(app, `dash-ob-${orgB.id}@x.io`, "secret1");
    const dB = await dash(app, orgAdminB);
    expect(dB.byUseCase).toEqual([]);
    expect(dB.totals.issued).toBe(0);
  });

  it("verification requests count toward the scope's verification card", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, `dash-vr-${Math.random().toString(36).slice(2)}`);
    const email = `dash-vrh-${Math.random().toString(36).slice(2)}@x.dev`;
    await onboardUser(app, admin, admin2, { email, password: "secret123", role: "Holder", useCaseKey: key });
    await issueTo(app, admin, admin2, key, email);
    const holder = await loginAs(app, email, "secret123");
    const me = (await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(holder) })).json();

    const vr = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(admin),
      payload: { holderDid: me.did, requestedTypes: ["ScoreCredential"], purpose: "dash test", credentialUseCaseKey: key } });
    expect(vr.statusCode).toBe(201);

    const d = await dash(app, admin);
    expect(d.verification.pending).toBeGreaterThanOrEqual(1);
  });

  it("403 outside the scope: Holder, scoped Verifier, and a tokenization desk admin", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, `dash-403-${Math.random().toString(36).slice(2)}`);
    const holderEmail = `dash-403h-${Math.random().toString(36).slice(2)}@x.dev`;
    const verifierEmail = `dash-403v-${Math.random().toString(36).slice(2)}@x.dev`;
    await onboardUser(app, admin, admin2, { email: holderEmail, password: "secret123", role: "Holder", useCaseKey: key });
    await onboardUser(app, admin, admin2, { email: verifierEmail, password: "secret123", role: "Verifier", useCaseKey: key });

    for (const [email, pw] of [[holderEmail, "secret123"], [verifierEmail, "secret123"], ["m1.admin@tokenlayer.dev", "m1admin123"]] as const) {
      const tok = await loginAs(app, email, pw);
      const res = await app.inject({ method: "GET", url: `${V1}/identity/dashboard`, headers: auth(tok) });
      expect(res.statusCode).toBe(403);
    }
  });
});
```

NOTE for the implementer: the `issueTo` helper resolves the subject's user id via `GET /users` — check that route's response shape in routes.ts before relying on `.find(...)` (it returns an array of user summaries with `id` + `email`; adjust the accessor if the real shape nests rows). Same for `GET /me` exposing `did`. If `POST /credentials/:id/revoke` differs (path or payload) from what's written here, mirror whatever `credential-usecase-issuance.test.ts` / ID-L tests use for revocation — do NOT change the production route to fit the test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-dashboard.test.ts`
Expected: N1 tests PASS; every N3 test FAILS with 404 on `/identity/dashboard`.

- [ ] **Step 3: Add the schema**

In `apps/api/src/http/schemas.ts`, next to the other Identity-tagged entries:

```ts
  identityDashboard: {
    tags: ["Identity"], summary: "Scoped identity operations dashboard (credential lifecycle + verification aggregates)", security: bearer,
    // Loose 200: the nested fold output would be silently stripped by
    // fast-json-stringify under a typed schema (the standing lesson).
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 403) },
  },
```

- [ ] **Step 4: Add the route**

In `apps/api/src/http/routes.ts`, immediately after the `GET /analytics` handler. Import `computeIdentityDashboard` from `../identity-analytics.js` at the top of the file.

```ts
  // ID-N: scoped identity operations dashboard. Read-only aggregation — scope is
  // resolved here, all counting lives in the pure fold. No chain reads: revocation
  // comes from the DB flag exactly like every list projection.
  app.get("/identity/dashboard", { schema: S.identityDashboard, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const all = await deps.credentialUseCases.list();
    let scoped: typeof all;
    if (claims.role === "PlatformAdmin") {
      scoped = all;
    } else if (claims.role === "OrgAdmin" && claims.orgId) {
      scoped = all.filter((u) => u.issuer.kind === "org" && u.issuer.orgId === claims.orgId);
    } else if (
      (claims.role === "UseCaseAdmin" || claims.role === "Issuer") &&
      claims.useCaseKey && all.some((u) => u.key === claims.useCaseKey)
    ) {
      scoped = all.filter((u) => u.key === claims.useCaseKey);
    } else {
      return reply.code(403).send({ error: "FORBIDDEN", message: "no identity dashboard for this role" });
    }

    const keys = new Set(scoped.map((u) => u.key));
    const credentials = (await deps.credentials.list())
      .filter((c) => c.credentialUseCaseKey !== null && keys.has(c.credentialUseCaseKey));
    const verifications = (await deps.verificationRequests.list())
      .filter((v) => v.credentialUseCaseKey !== null && keys.has(v.credentialUseCaseKey));

    const holderLabels = new Map<string, string>();
    for (const u of await deps.users.list()) if (u.did) holderLabels.set(u.did, u.email);
    for (const o of await deps.organizations.list()) if (o.did) holderLabels.set(o.did, o.name);

    return computeIdentityDashboard({
      useCases: scoped, credentials, verifications, holderLabels,
      now: new Date().toISOString(), days: 30,
    });
  });
```

Scope subtleties the implementer must preserve:
- A tokenization-scoped `UseCaseAdmin`/`Issuer` falls through to 403 because their `useCaseKey` is not in the credential-use-case catalog (`all.some(...)` is false) — that check is the domain gate, keep it.
- An OrgAdmin whose org issues nothing gets `scoped = []` → a zeroed dashboard, NOT 403 (spec).
- `deps.users.list()` / `deps.organizations.list()` already exist — only the credential/verification `list()`s are new.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @tokenlayer/api exec vitest run test/identity-dashboard.test.ts` → all PASS.
Run: `pnpm --filter @tokenlayer/api test` → full suite green (374 + new).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/identity-dashboard.test.ts
git commit -m "feat(api): GET /identity/dashboard — scoped lifecycle + verification aggregates"
```

---

### Task N4: Web — IdentityDashboard view + nav wiring

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/IdentityDashboard.tsx`
- Modify: `apps/web/src/domains.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Types**

Append to `apps/web/src/types.ts`:

```ts
// ---- ID-N: identity dashboard ----------------------------------------------

export type DerivedCredentialStatus = "accepted" | "pending" | "changes_requested" | "rejected" | "revoked" | "expired";

export interface IdentityStatusCounts {
  issued: number;
  accepted: number;
  pendingAcceptance: number;
  changesRequested: number;
  rejectedByHolder: number;
  revoked: number;
  expired: number;
}

export interface IdentityBoardRow {
  credentialId: string;
  useCaseKey: string;
  useCaseName: string;
  type: string;
  holderDid: string;
  holderLabel: string;
  issuedAt: string;
  expiresAt: string | null;
  status: DerivedCredentialStatus;
  acceptanceNote: string | null;
}

export interface IdentityDashboardData {
  totals: IdentityStatusCounts;
  byUseCase: { key: string; name: string; counts: IdentityStatusCounts; byType: { type: string; counts: IdentityStatusCounts }[] }[];
  board: IdentityBoardRow[];
  boardTotal: number;
  activity: { date: string; issued: number }[];
  verification: { pending: number; consented: number; rejected: number; expired: number; verifiedValid: number; verifiedInvalid: number };
}
```

- [ ] **Step 2: Client method**

In `apps/web/src/api.ts`, next to `analytics` (import `IdentityDashboardData` in the existing type-import block):

```ts
  identityDashboard: (token: string) => request<IdentityDashboardData>("/identity/dashboard", token),
```

- [ ] **Step 3: The view**

Create `apps/web/src/components/IdentityDashboard.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { DerivedCredentialStatus, IdentityDashboardData } from "../types.js";
import { SectionHeader } from "./ui.js";

// ID-N: scoped identity operations dashboard — stat tiles over the ID-L
// lifecycle, a 30-day issued strip, verification counters, and the filterable
// credential status board. Read-only; all aggregation is server-side.

const STATUS_META: Record<DerivedCredentialStatus, { label: string; pill: string }> = {
  accepted: { label: "Accepted", pill: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  pending: { label: "Pending acceptance", pill: "bg-amber-50 text-amber-700 border-amber-200" },
  changes_requested: { label: "Changes requested", pill: "bg-rose-50 text-rose-700 border-rose-200" },
  rejected: { label: "Rejected by holder", pill: "bg-slate-100 text-slate-600 border-slate-200" },
  revoked: { label: "Revoked", pill: "bg-red-50 text-red-700 border-red-200" },
  expired: { label: "Expired", pill: "bg-slate-100 text-slate-500 border-slate-200" },
};
const STATUS_ORDER: DerivedCredentialStatus[] = ["pending", "accepted", "changes_requested", "rejected", "revoked", "expired"];

function StatusPill({ status }: { status: DerivedCredentialStatus }): JSX.Element {
  const m = STATUS_META[status];
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.pill}`}>{m.label}</span>;
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }): JSX.Element {
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4">
      <div className={`text-2xl font-semibold tabular-nums ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

/** Dependency-free vertical mini bar strip (one bar per day). */
function ActivityStrip({ days }: { days: { date: string; issued: number }[] }): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.issued));
  return (
    <div className="flex items-end gap-[3px] h-16" title="Credentials issued per day">
      {days.map((d) => (
        <div key={d.date} className="flex-1 rounded-t bg-brand-500/70 min-w-[3px]"
          style={{ height: `${Math.max(d.issued > 0 ? 8 : 2, (d.issued / max) * 100)}%` }}
          title={`${d.date}: ${d.issued}`} />
      ))}
    </div>
  );
}

export function IdentityDashboard(): JSX.Element {
  const { token } = useAuth();
  const [data, setData] = useState<IdentityDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DerivedCredentialStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!token) return;
    api.identityDashboard(token).then(setData).catch(() => setError("Could not load the identity dashboard."));
  }, [token]);

  const types = useMemo(() => (data ? [...new Set(data.board.map((r) => r.type))].sort() : []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.board.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (typeFilter === "all" || r.type === typeFilter) &&
      (!q || r.holderLabel.toLowerCase().includes(q)));
  }, [data, statusFilter, typeFilter, search]);

  if (error) return <div><SectionHeader title="Identity Dashboard" description={error} /></div>;
  if (!data) return <div><SectionHeader title="Identity Dashboard" description="Loading…" /></div>;

  const t = data.totals;
  return (
    <div className="space-y-5">
      <SectionHeader title="Identity Dashboard" description="Credential lifecycle and verification activity across your identity use cases." />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <Tile label="Issued" value={t.issued} />
        <Tile label="Accepted" value={t.accepted} tone="text-emerald-600" />
        <Tile label="Pending acceptance" value={t.pendingAcceptance} tone="text-amber-600" />
        <Tile label="Changes requested" value={t.changesRequested} tone="text-rose-600" />
        <Tile label="Rejected by holder" value={t.rejectedByHolder} tone="text-slate-600" />
        <Tile label="Revoked" value={t.revoked} tone="text-red-600" />
        <Tile label="Expired" value={t.expired} tone="text-slate-500" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h2 className="font-semibold text-slate-900 text-sm mb-3">Issued — last 30 days</h2>
          <ActivityStrip days={data.activity} />
        </div>
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5">
          <h2 className="font-semibold text-slate-900 text-sm mb-3">Verification activity</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            {([["Pending", data.verification.pending], ["Awaiting verify", data.verification.consented],
               ["Verified valid", data.verification.verifiedValid], ["Verified invalid", data.verification.verifiedInvalid],
               ["Rejected", data.verification.rejected], ["Expired", data.verification.expired]] as const)
              .map(([label, v]) => (
                <div key={label}>
                  <div className="text-lg font-semibold tabular-nums text-slate-900">{v}</div>
                  <div className="text-[11px] text-slate-500">{label}</div>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-slate-900 text-sm mr-auto">Credential status board</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search holder…"
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs" />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-xs bg-white">
            <option value="all">All types</option>
            {types.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setStatusFilter("all")}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusFilter === "all" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
            All ({data.board.length})
          </button>
          {STATUS_ORDER.map((s) => {
            const n = data.board.filter((r) => r.status === s).length;
            if (n === 0) return null;
            return (
              <button key={s} onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${statusFilter === s ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                {STATUS_META[s].label} ({n})
              </button>
            );
          })}
        </div>
        {data.boardTotal > data.board.length && (
          <p className="text-xs text-slate-500">Showing the newest {data.board.length} of {data.boardTotal} credentials.</p>
        )}
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="text-[11px] text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-3 py-2">Holder</th>
                <th className="text-left font-medium px-3 py-2">Credential</th>
                <th className="text-left font-medium px-3 py-2">Use case</th>
                <th className="text-left font-medium px-3 py-2">Issued</th>
                <th className="text-left font-medium px-3 py-2">Expires</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.credentialId} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-slate-700">{r.holderLabel}</td>
                  <td className="px-3 py-1.5 text-slate-700">{r.type}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.useCaseName}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.issuedAt.slice(0, 10)}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.expiresAt ? r.expiresAt.slice(0, 10) : "—"}</td>
                  <td className="px-3 py-1.5">
                    <StatusPill status={r.status} />
                    {r.acceptanceNote && <div className="text-[11px] text-rose-600 mt-0.5">{r.acceptanceNote}</div>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">No credentials match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data.byUseCase.length > 1 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <h2 className="font-semibold text-slate-900 text-sm">By use case</h2>
          {data.byUseCase.map((u) => (
            <details key={u.key} className="rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm text-slate-800 font-medium">
                {u.name} <span className="text-slate-400 font-normal">— {u.counts.issued} issued</span>
              </summary>
              <div className="mt-2 space-y-1">
                {u.byType.map((ty) => (
                  <div key={ty.type} className="flex flex-wrap gap-x-4 text-xs text-slate-600">
                    <span className="font-medium text-slate-800 w-44 truncate">{ty.type}</span>
                    <span>issued {ty.counts.issued}</span>
                    <span className="text-emerald-600">accepted {ty.counts.accepted}</span>
                    <span className="text-amber-600">pending {ty.counts.pendingAcceptance}</span>
                    <span className="text-red-600">revoked {ty.counts.revoked}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
```

NOTE for the implementer: check `ui.tsx` for the exact `SectionHeader` props and whether the Tailwind config defines `brand-500` (the codebase uses `brand-600`/`brand-700` in BatchCsv; if `brand-500` is absent use `bg-brand-600/60`). Match whatever card/tile classes the tokenization `Dashboard.tsx` `Stat` component uses if they differ from the above — visual consistency beats this listing.

- [ ] **Step 4: Nav wiring (three branches + domain map)**

`apps/web/src/domains.ts` — extend `NAV_DOMAIN`'s identity group:

```ts
  identity: "identity", "identity-dashboard": "identity", verify: "identity", organizations: "identity", "org-wallet": "identity", "issue-credentials": "identity",
```

`apps/web/src/App.tsx` — three edits (import `IdentityDashboard` at the top):

1. **Platform branch** (the `isPlatform && !activeUseCase` block): in `items`, after the `identity` entry add:

```ts
      { id: "identity-dashboard", label: "Identity Dashboard", icon: "spark" },
```

Extend `knownIds`:

```ts
    const knownIds = [...Object.keys(platViews), "profile", "credentials", "identity-dashboard"];
```

And in the `panel` expression add a branch before the `PlatformHome` fallback:

```ts
    const panel =
      activeId === "profile" ? <MyProfile onSelect={setView} />
      : activeId === "credentials" ? <MyIdentity />
      : activeId === "identity-dashboard" ? <IdentityDashboard />
      : <PlatformHome useCases={useCases} chains={chains} onReloadUseCases={reloadUseCases} view={platViews[activeId] ?? "overview"} />;
```

2. **Identity desk branch** (`deskDomain === "identity"`): prepend to `idItems` for UseCaseAdmin/Issuer:

```ts
      ...(r === "UseCaseAdmin" || r === "Issuer" ? [{ id: "identity-dashboard", label: "Dashboard", icon: "spark" as const }] : []),
```

(place it FIRST in the array so the desk lands on it by default via `idIds[0]`), and add the panel branch:

```ts
    if (idActive === "identity-dashboard") {
      idPanel = <IdentityDashboard />;
    } else if (idActive === "issue-credentials") {
```

3. **Org/desk branch** (the final branch with `isPlatform || isOrgAdmin` items): after the `identity` item add:

```ts
    ...(isPlatform || isOrgAdmin ? [{ id: "identity-dashboard", label: "Identity Dashboard", icon: "spark" as const }] : []),
```

and the panel branch:

```ts
  } else if (activeId === "identity-dashboard") {
    panel = <IdentityDashboard />;
  } else if (activeId === "org-wallet") {
```

Desk-branch caveat: making the dashboard `idIds[0]` changes the identity desk's landing view from Issue Credentials to the dashboard — this is the intended TalentPass behavior (their app opens on the dashboard) and does not touch the domain registry's `defaultView`. Holder/Verifier desk navs are untouched.

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @tokenlayer/web exec tsc --noEmit` → clean.
Run: `pnpm --filter @tokenlayer/web build` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/IdentityDashboard.tsx apps/web/src/domains.ts apps/web/src/App.tsx
git commit -m "feat(web): IdentityDashboard view — tiles, activity strip, verification card, status board"
```

---

### Task N5: Verify — full suites + live Besu walkthrough + review + finish

**Files:** none new in-repo (walkthrough script lives in the scratchpad, NOT committed).

- [ ] **Step 1: Full verification**

```bash
pnpm -r exec tsc --noEmit
pnpm --filter @tokenlayer/core test
pnpm --filter @tokenlayer/api test
pnpm --filter @tokenlayer/web build
```

Expected: all green (core 227 untouched; api 374 + ~13 new; web clean).

- [ ] **Step 2: Live Besu walkthrough**

Boot recipe (from `apps/api`, root `.env` sourced; throwaway DB in `apps/api/prisma/`; boot ~85–130s; if it wedges >8 min on seed deploys: kill by port, `docker restart besu-node1 besu-node2 besu-node3 besu-node4 besu-node5`, re-push a fresh DB, reboot):

```bash
lsof -ti tcp:4000 | xargs kill -9
cd apps/api && rm -f prisma/dev-ndemo.db && DATABASE_URL="file:./dev-ndemo.db" pnpm exec prisma db push
set -a; source ../../.env; set +a
unset MST_RPC_URL MST_OPERATOR_KEY
BESU_RPC_URL=http://localhost:8545 BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 \
REGISTRY_CHAIN_ID=besu CHAIN_STRICT=0 DATABASE_URL="file:./dev-ndemo.db" PORT=4000 \
LOGIN_RATE_LIMIT_MAX=1000 CORS_ORIGINS=http://localhost:5173 ENABLED_DOMAINS=tokenization,identity \
exec ./node_modules/.bin/tsx src/server.ts
```

Walkthrough script (scratchpad, modeled on `csv-batch-walkthrough.mjs`), asserting:
1. Provision a domicile program from the template; PATCH `holderAcceptance: true`.
2. ID-M batch-onboard 4 holders; batch-issue 4 credentials → all born pending.
3. `GET /identity/dashboard` as PlatformAdmin: `totals.issued = 4`, `pendingAcceptance = 4`; board rows show holder emails + `pending`.
4. Holder 1 accepts; holder 2 rejects (note "not mine"); issuer revokes holder 3's credential (propose + approve).
5. Re-fetch: `accepted 1, rejectedByHolder 1, revoked 1, pendingAcceptance 1` — the rejected-vs-revoked attribution proves the precedence fix.
6. Create a verification request for holder 1 → `verification.pending ≥ 1`.
7. eth_call `VcRegistry.statusOf(ethers.id(credId))` for the accepted credential (exists, !revoked) and the revoked one (revoked) — the dashboard's DB counts agree with chain.
8. Scoped desk login (provision desk users or onboard an Issuer scoped to the key): desk dashboard `byUseCase` = exactly this use case.
9. Teardown: kill by port, `rm apps/api/prisma/dev-ndemo.db*`, verify `apps/api/prisma/dev.db` untouched (`git status` + mtime).

Optionally follow with a browser check via the preview (PlatformAdmin → Identity domain → Identity Dashboard renders tiles/board; desk login lands on Dashboard).

- [ ] **Step 3: Final whole-branch review**

Dispatch the final code reviewer over `git diff main...feat/identity-dashboard` with focus: scope-resolution correctness (no cross-tenant leak; tokenization desk 403), derived-status precedence (rejected before revoked, with the ID-L rationale), fold correctness (partition invariant, board cap/ordering, day bucketing), repo parity (`list()` in both backends), loose schema on the 200, and that no existing test changed. Fix anything MEDIUM+ before merging.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — the user's standing choice is option 1: merge `feat/identity-dashboard` into main with `--no-ff`, delete the branch, then update the `identity-domain-program` memory (ID-N merged; ID-O next).

---

## Self-review notes

- Spec coverage: scoping model → N3; fold/derived status/board/activity/verification → N2; repo list() parity → N1; web surfaces + nav → N4; live walkthrough + finish → N5. The spec's "seed configured types at zero" and "boardTotal cap line" are asserted in N2 tests; the empty-OrgAdmin-scope-not-403 case is asserted in N3.
- The N3 test helpers guess two adjacent response shapes (`GET /users` array access, revoke route) — flagged inline with instructions to mirror existing tests rather than bend production code.
- Type names are consistent across tasks: `IdentityDashboard` (api fold) vs `IdentityDashboardData` (web type) — deliberately different names because the web file also exports a component named `IdentityDashboard`.
