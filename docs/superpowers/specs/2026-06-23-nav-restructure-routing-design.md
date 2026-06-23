# Dashboard Nav Restructure + Per-Use-Case Routing — Design

**Date:** 2026-06-23
**Status:** Approved (pending written-spec review)

## Problem

The dashboard's top nav is a flat per-role tab list (Assets / Issue Asset / Users / …).
We want a clearer two-section information architecture, sub-tabs within each section, a
fuller user-management surface (edit + revoke), and a **per-use-case URL** so each use
case has its own deep-linkable space (e.g. `localhost:5173/carbon-credit`).

## Decisions (confirmed)

1. **Routing** — path-based `/<use-case-key>` via a lightweight in-app router (no new dep).
2. **Edit user** — resets the user's password (only).
3. **Revoke** — reversible **suspend** (a new `active` flag), distinct from permanent Delete.
4. **PlatformAdmin** — a Platform home with a use-case **switcher**; choosing a use case
   navigates to `/<key>` and scopes everything to it.

## 1. Routing

A minimal client router (`apps/web/src/router.tsx`): a `RouterProvider` holding
`window.location.pathname`, updated via `history.pushState` and a `popstate` listener,
exposed through `useRoute() → { path, segments, navigate(to) }`. No external library.

- The **first path segment** is the active use-case key (`/carbon-credit` → `carbon-credit`).
  Empty path (`/`) = Platform home.
- **On login / load:**
  - Scoped user (useCaseKey set) → if the current path's first segment ≠ their useCaseKey,
    `navigate("/" + useCaseKey)`. They are clamped to their own use case.
  - PlatformAdmin (useCaseKey null) → may sit at `/` (home) or any `/<key>`.
- Vite dev already serves `index.html` for unknown paths, so refresh/deep-link works.
- The active use-case key drives data scoping in the UI: for PlatformAdmin it is passed as
  the `?useCaseKey=` filter to `GET /assets` and pre-selected/locked in issuance; scoped
  users are already server-scoped.

## 2. Information architecture

Top nav renders **sections** (gated by role); each section has **sub-tabs** (gated by role).

### Asset Management
| Sub-tab | Component | Roles |
| --- | --- | --- |
| Token Issuance | IssuePanel (issue + mint), use case locked to route | PlatformAdmin, UseCaseAdmin, Issuer |
| Marketplace | AssetList → AssetDetail (role-gated actions) | all |
| My Holdings | MyHoldings | Buyer, Trader (wallet-linked) |

### User Management (PlatformAdmin, UseCaseAdmin only)
| Sub-tab | Component | Notes |
| --- | --- | --- |
| Add User | UsersAdmin create form | PlatformAdmin → UseCaseAdmin (+ use-case select); UseCaseAdmin → Issuer/Trader/Buyer/Auditor |
| Manage Users | roster table | row actions: **Edit** (reset password modal), **Revoke/Reactivate** (toggle suspend), **Delete** (permanent) |

### Platform home (PlatformAdmin, path `/`)
Use-case catalog (cards) + the Use-Case Builder + a switcher. Selecting a use case →
`navigate("/" + key)`, where PlatformAdmin sees Asset + User Management scoped to it.

The existing `App.tsx` tab logic is replaced by: resolve `(role, routeUseCaseKey)` →
the allowed sections/sub-tabs. Existing components (`IssuePanel`, `AssetList`,
`AssetDetail`, `MyHoldings`, `UseCaseBuilder`) are reused; new container components
`AssetManagement.tsx` and `UserManagement.tsx` host the sub-tabs, and `PlatformHome.tsx`
hosts the catalog + builder + switcher.

## 3. Backend changes

### `User.active` (suspend)
- Prisma `User` gains `active Boolean @default(true)`.
- `UserRecord` gains `active: boolean`; repos map it; `update` patch widens to
  `Partial<Pick<UserRecord, "passwordHash" | "accountId" | "active">>`.
- **Login** rejects an inactive user: `401 { error: "ACCOUNT_SUSPENDED" }`.

### `PATCH /api/v1/users/:id`
- Body: `{ password?: string (min 6), active?: boolean }`.
- Scope: same guard as `DELETE /users/:id` — PlatformAdmin any; UseCaseAdmin only within
  their own use case and only for non-UseCaseAdmin targets; else 403.
- Reset password → `update(id, { passwordHash: hash(password) })`; suspend/reactivate →
  `update(id, { active })`. Returns the updated user summary (no passwordHash).
- Schema added to `S` (Users tag).

### `GET /users`
- Summary now includes `active` so the UI can show status + the Revoke/Reactivate toggle.

## 4. Testing

- **Core:** `userPolicy` unchanged (edit/suspend use the same who-can-manage rules — assert
  via the route tests).
- **API integration:** PATCH resets password (old fails / new works on next login); suspend
  → login returns 401 ACCOUNT_SUSPENDED; reactivate → login works again; UseCaseAdmin cannot
  PATCH a user in another use case (403) nor a UseCaseAdmin (403); `/users` returns `active`.
- **Web:** typecheck clean; live preview per role — correct landing route, sub-tab gating,
  issuance locked to route use case, edit/revoke/delete in Manage Users, PlatformAdmin
  switcher navigates and scopes.

## Out of scope

Real subdomains (host/DNS); editing a user's role or wallet (Edit = password only);
audit of user-management actions; bulk user ops; SSO. The 16 seeded demo logins and their
`@tokenlayer.dev` emails are unchanged.
