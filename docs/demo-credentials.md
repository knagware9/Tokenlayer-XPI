# Demo credentials & endpoints

Every login below was verified against a running deployment on 2026-08-18 — all
18 seed accounts authenticate, on the combined stack and through all six persona
edges.

> **These are SEEDED DEV ACCOUNTS, and the passwords are already in the source**
> (`apps/api/src/shared/seed.ts`). Writing them down here changes nothing about
> their exposure. It would change everything for a real deployment: these
> accounts must never exist outside dev, and this file must never be extended
> with a real one.

## What is deliberately NOT in this file

`JWT_SECRET`, `DID_MASTER_KEY`, `BESU_OPERATOR_KEY`, `MST_OPERATOR_KEY` and the
`IDENTITY_SERVICE_KEY` peer credential. They live only in git-ignored env files
(`.env`, `.env.personas`), are generated per machine, and must stay there.

`DID_MASTER_KEY` deserves a specific warning: every organization's custodial DID
seed is encrypted under it. Rotating it does not lock you out cleanly — the
organizations survive and silently lose the ability to sign, surfacing much
later as `Unsupported state or unable to authenticate data` on an unrelated
onboarding. Back the file up; never regenerate it for a deployment that has data.

## Endpoints

### Combined stack — both products in one app
| | |
|---|---|
| Web | http://localhost:8080 |
| API | http://localhost:4000/api/v1 |
| Besu RPC | http://localhost:8545 — chainId 1337, 5 QBFT validators |

Start with `./scripts/deploy.sh` (add `--sim` for simulated ledgers only).

### Split stacks — six audience apps behind route-allowlist edges
| App | Web | API edge |
|---|---|---|
| Identity · Issuer Console | http://localhost:8090 | http://localhost:4110 |
| Identity · Verifier Console | http://localhost:8091 | http://localhost:4111 |
| Identity · Wallet | http://localhost:8092 | http://localhost:4112 |
| Tokenization · Issuer Desk | http://localhost:8100 | http://localhost:4120 |
| Tokenization · Marketplace | http://localhost:8101 | http://localhost:4121 |
| Tokenization · Platform Admin | http://localhost:8102 | http://localhost:4122 |

Start with `bash deploy/identity.sh --chain=besu` and/or
`bash deploy/tokenization.sh --chain=besu` — `--chain=` takes `besu`, `mst`,
`fabric` or a list (see `deploy/README.md`). Neither API publishes a host port of its own — the
edges above are the only way in, and each serves only its persona's routes.

## Logins

The same credentials work on every endpoint above. All emails are `@tokenlayer.dev`.

### Platform
`admin2` exists so onboarding proposals have a second eligible approver —
maker–checker refuses `SELF_APPROVAL`, so a one-admin deployment cannot execute
a single gated action.

| Email | Password | Role |
|---|---|---|
| `admin@tokenlayer.dev` | `admin123` | PlatformAdmin |
| `admin2@tokenlayer.dev` | `admin123` | PlatformAdmin |

### Carbon credit — password `carbon123`
| Email | Role |
|---|---|
| `carbon.admin@tokenlayer.dev` | UseCaseAdmin |
| `carbon.issuer@tokenlayer.dev` | Issuer — **owns the treasury**, mints and sells |
| `carbon.buyer@tokenlayer.dev` | Buyer |
| `carbon.auditor@tokenlayer.dev` | Auditor |

### Gold loan — password `gold123`
`gold.admin@` · `gold.issuer@` · `gold.buyer@` · `gold.auditor@` — same four roles.

### Corporate bond — password `bond123`
`bond.admin@` · `bond.issuer@` · `bond.buyer@` · `bond.auditor@` — same four roles.

### Invoice tokenization (M1xchange TReDS)
Passwords differ **per user** here, unlike the three rosters above.

| Email | Password | Role |
|---|---|---|
| `m1.admin@tokenlayer.dev` | `m1admin123` | UseCaseAdmin — operates the desk |
| `m1.issuer@tokenlayer.dev` | `m1issuer123` | Issuer |
| `m1.buyer@tokenlayer.dev` | `m1buyer123` | Buyer |
| `m1.auditor@tokenlayer.dev` | `m1auditor123` | Auditor |

## Notes that save an hour

- **Start at the Issuer.** Each use case's Issuer owns the treasury wallet that
  mints and sells; the admin configures, the issuer transacts.
- **The invoice use case gates on jurisdiction.** A treasury or holder must be
  KYC-approved with `country: IN` and hold a valid KYC credential, or issuance
  refuses with `JURISDICTION_NOT_ALLOWED`. Suppliers onboarded by the e2e
  scripts satisfy this; the plain seed accounts do not.
- **Invoices are fingerprinted.** The same invoice cannot be tokenized twice —
  the second attempt returns `DUPLICATE_ASSET` against the stored hash.
- **Each stack has its own database.** The combined stack and the two split
  stacks do not share users, orgs or assets, so an account created in one is
  absent from the others.
