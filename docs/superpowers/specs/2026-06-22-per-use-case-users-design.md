# Per-Use-Case User Setup — Design

**Date:** 2026-06-22
**Status:** Approved (pending written-spec review)

## Problem

Today TokenLayer has a single **global** user roster: every user has one of four
platform-wide roles (`Admin / Issuer / Operator / Viewer`) and can see and act on
every use case. "Buyers" are not users at all — they exist only as on-ledger
`Account` wallet addresses.

We want each use case to have its **own isolated set of users** with roles that
match a real tokenization desk. After the **Platform Admin** does the initial
setup of a use case, that use case gets its own **Use-Case Admin**, who in turn
provisions **Issuer**, **Trader**, **Buyer**, and **Auditor** users — all scoped
to that one use case and invisible to the others.

## Decisions (confirmed)

1. **Strict isolation** — each user belongs to exactly one use case. The Platform
   Admin is the only global user.
2. **Role set** — `PlatformAdmin`, `UseCaseAdmin`, `Issuer`, `Trader`, `Buyer`,
   `Auditor`. Buyer is read-only (a Trader executes trades on their behalf — no new
   engine capability).
3. **Delegated provisioning** — Platform Admin creates the use case + its first
   Use-Case Admin; the Use-Case Admin builds the rest of the roster via a scoped
   user-management screen.
4. **Wallet-linked Buyer/Trader** — a Buyer/Trader user is linked to an on-ledger
   wallet `Account`; "my holdings" = balances at that address across the use
   case's assets.

## Chosen approach (A)

Scope tenancy at the **API boundary**, keep a fixed expanded **RBAC matrix**, and
add **delegated user management**. The chain-agnostic `LifecycleEngine` is
untouched by tenancy — it keeps doing role→action checks; the API layer wraps it
with a use-case scope guard, where the actor's identity already lives.

Rejected: pushing scoping into the core engine (over-couples the engine to
multi-tenancy); a lightweight relabel of existing roles (doesn't deliver real
Buyer/Trader semantics).

## 1. Data model

**`User`** gains two nullable columns:
- `useCaseKey String?` — the user's use case. `null` ⇒ global **Platform Admin**.
- `accountId String?` — FK to `Account`, the user's wallet. Set for Buyer/Trader;
  null otherwise.

**`Account`** — unchanged; the link is one-way (`User.accountId → Account.id`).

**`Role`** (core `types.ts`) is redefined:
```ts
export type Role =
  | "PlatformAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";
```

No new tables: strict isolation needs only the `useCaseKey` column on `User`.
`Asset.useCaseKey` is the value we scope against; `Asset.createdBy` already records
the issuing user.

**Migration:** dev SQLite — bump the Prisma schema and reseed. Old global users
(`issuer@/operator@/viewer@`) are removed; `admin@tokenlayer.dev` becomes the
Platform Admin.

## 2. Auth & request scoping

- **JWT** payload: `{ sub, role, useCaseKey }` (`useCaseKey` null for Platform
  Admin). Login response surfaces `role` + `useCaseKey` so the dashboard routes to
  the right view.
- **Scope guard** in `http/support.ts` (beside `authenticate`):
  - Platform Admin (`useCaseKey = null`): unrestricted.
  - Everyone else: their `useCaseKey` must match the target's. Enforced at:
    - `GET /use-cases` → only the caller's use case (Platform Admin: all).
    - `GET /assets`, `GET /assets/:id`, `/assets/:id/*` → asset's `useCaseKey` must
      equal caller's. **Cross-tenant read ⇒ 404** (don't leak existence);
      **cross-tenant action ⇒ 403 `WRONG_USE_CASE`**.
    - `POST /assets` → `useCaseKey` forced to the caller's; can't issue elsewhere.
- **Role/action** enforcement stays in the `LifecycleEngine` RBAC check, using the
  expanded matrix. Two independent gates: *in this use case?* (API) and *can your
  role do this action?* (engine).

## 3. Roles & permissions

Two layers: **lifecycle actions** (engine) and **management capabilities** (API).

| Role | Lifecycle actions | Management | Scope |
|------|------------------|-----------|-------|
| **PlatformAdmin** | full lifecycle (break-glass) + read | create/edit use cases; create UseCaseAdmin users | all |
| **UseCaseAdmin** | issue, mint, transfer, burn, freeze, unfreeze, allow, disallow, read | manage own use case's roster (Issuer/Trader/Buyer/Auditor) | own use case |
| **Issuer** | issue, mint, allow, disallow, freeze, unfreeze, read | — | own use case |
| **Trader** | transfer, burn, read | — | own use case |
| **Buyer** | read | — | own use case, own wallet |
| **Auditor** | read | — | own use case |

- Issuer = issuance + KYC/compliance (mint, allowlist, freeze). Trader = the desk
  that moves (transfer) and retires (burn) credits. Buyer = read-only catalog +
  own holdings. Auditor = read-only.
- PlatformAdmin keeps full lifecycle as a superuser fallback, though its day job is
  setup, not asset ops.
- `UseCase.roles` (existing JSON field) lists which roles apply to a use case;
  drives the roster screen's role dropdown.

## 4. Provisioning & user-management API

New scoped CRUD under `/api/v1/users`:

- `POST /users` — `{ email, password, role, useCaseKey?, walletAddress? }`.
  - PlatformAdmin may create `UseCaseAdmin` for any `useCaseKey` (passed explicitly).
  - UseCaseAdmin may create `Issuer/Trader/Buyer/Auditor` in **their own** use case
    (server forces `useCaseKey`).
  - Buyer/Trader: `walletAddress` upserts an `Account` and sets `accountId`.
- `GET /users` — PlatformAdmin: all; UseCaseAdmin: own roster only.
- `PATCH /users/:id` (reset password / relink wallet), `DELETE /users/:id` — same
  scope rules.
- **Guard rails** (`userPolicy` helper, unit-tested): can't create a role ≥ your
  own; UseCaseAdmin can't create PlatformAdmin/UseCaseAdmin or touch another use
  case's users.

**Provisioning sequence:** PlatformAdmin creates use case → creates UseCaseAdmin →
UseCaseAdmin creates Issuer/Trader/Buyer(s)/Auditor (auto-scoped) → each logs in to
their role view.

`UserRepository` gains `create/list/update/delete` with `useCaseKey` filtering.

## 5. Dashboard / UI

Login resolves `{ role, useCaseKey }` → role-specific shell. Header shows the use
case name (or "Platform").

- **Platform Admin** — use-case catalog + **Define your own Use Case** builder +
  **Use-Case Admins** screen.
- **Use-Case Admin** — Assets + Issue Asset + **Users** screen (manage roster,
  assign wallets), scoped to the use case.
- **Issuer** — Assets + Issue Asset + per-asset mint / allowlist / freeze.
- **Trader** — **Trading Desk**: assets with Transfer (sell) + Burn (retire);
  holders visible.
- **Buyer** — read-only **Marketplace** (catalog) + **My Holdings** (balances at
  linked wallet).
- **Auditor** — read-only everything in the use case incl. audit trails.

Implementation: a `roleViews` map gates tabs and action buttons via the existing
`can(role, action)` helper (expanded matrix), mirroring server gates. New
components: `UsersAdmin` (roster + create form), `MyHoldings` (buyer). The API
remains the source of truth; UI hiding is convenience.

## 6. Seeding / migration & demo rosters

Seed rewritten around the new model (dev SQLite — bump schema + reseed):

- **Platform Admin:** `admin@tokenlayer.dev` / `admin123`, `useCaseKey = null`.
- **Per-use-case demo rosters** for each shipped use case, generated from a small
  seed table `{ useCaseKey, buyerWalletLabel }`. For **carbon-credit**:

| Email | Password | Role | Wallet |
|-------|----------|------|--------|
| `carbon.admin@tokenlayer.dev` | `carbon123` | UseCaseAdmin | — |
| `carbon.issuer@tokenlayer.dev` | `carbon123` | Issuer | — |
| `carbon.trader@tokenlayer.dev` | `carbon123` | Trader | Treasury |
| `carbon.buyer@tokenlayer.dev` | `carbon123` | Buyer | EcoFund Capital |
| `carbon.auditor@tokenlayer.dev` | `carbon123` | Auditor | — |

  Same pattern for **gold-loan** (`gold.*`) and **corporate-bond** (`bond.*`).
- The 6 buyer accounts (EcoFund, GreenWing, …) stay; buyer users link to them.
- Old global `issuer@/operator@/viewer@` users removed.
- The `roles` arrays in the `config/use-cases/*.json` files (currently the old
  `["Admin","Issuer","Operator","Viewer"]`) are updated to the new role set
  (e.g. `["UseCaseAdmin","Issuer","Trader","Buyer","Auditor"]`), since that field
  drives the roster screen's role dropdown.
- **Quick-login** buttons grouped by use case (Platform Admin first, then each
  roster) so trying a use case is one click.

## 7. Testing

- **Core (unit):** `RbacPolicy` — every role × action (allow + deny). `userPolicy`
  — who-can-create-whom.
- **API (integration):** carbon Issuer can't read/act on a gold-loan asset
  (404/403); issue forced to caller's use case; `GET /use-cases` & `/assets`
  filtered per caller (Platform Admin sees all); `/users` CRUD scope rules;
  Buyer read-only (mint/transfer → 403).
- **End-to-end:** new `e2e-tenancy.ts` — Platform Admin → UseCaseAdmin → roster →
  Issuer issues+mints → Trader sells to Buyer → Buyer sees holdings → Auditor reads
  trail → second use case's Issuer denied. Re-run existing carbon/gold/bond e2e
  under new rosters.
- **Verification:** `pnpm -r typecheck` + `pnpm -r test` green; live dashboard
  walkthrough as each role.

## Out of scope

Cross-use-case membership / a user in multiple use cases; org/tenant entities above
the use case; buyer self-service purchase (buy-side transfer initiated by Buyer);
SSO/SAML; email invitations (users are created with a password directly).
