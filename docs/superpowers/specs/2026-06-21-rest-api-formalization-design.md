# TokenLayer — REST API Formalization for Asset Tokenization

## Context

The platform is API-driven and already exposes working REST endpoints for the full tokenization
lifecycle (auth, chains, use-case CRUD, asset issuance, lifecycle actions, holders, audit). This
work makes that surface **integrator-grade**: versioned, schema-validated, and self-documented —
without changing the underlying behaviour, engine, adapters, or contracts.

## Goals

1. **Versioning** — all routes under `/api/v1`.
2. **OpenAPI 3 + Swagger UI** — generated from route schemas; `/openapi.json` + `/docs`.
3. **Request/response validation** — Fastify JSON schemas on every route.
4. **Consistent envelopes** — uniform error shape; list envelope with pagination.
5. **Query gaps** — filter + paginate `GET /assets` and paginate `GET /assets/:id/audit`.

## Design

### Versioning
Register the API routes under the `/api/v1` prefix (including `/api/v1/auth/login`). The
dashboard's `apps/web/src/api.ts` base URL is updated to `${BASE}/api/v1`.

### OpenAPI + Swagger
`@fastify/swagger` (OpenAPI 3) + `@fastify/swagger-ui`. Each route supplies a Fastify schema
(`tags`, `summary`, `params`/`querystring`/`body`, `response`); the spec is generated from these.
Served: the document at `/openapi.json`, interactive UI at `/docs` (Bearer security scheme so the
"Authorize" button works).

### Schema validation
Shared schema components registered with `app.addSchema` and referenced via `$ref`:
`Asset`, `UseCase`, `AuditEntry`, `AccountState`, `TokenInfo`, `Chain`, `Error`, `Pagination`,
`AssetList`. Request bodies/params/query are validated by Fastify (malformed → 400); responses are
serialised to their declared schema.

### Envelopes
- **Error** (all non-2xx): `{ error: "<CODE>", message: string, details?: object }`. The global
  error handler maps: `PolicyError.code`; Fastify validation → `VALIDATION_ERROR`; unauthenticated
  → `UNAUTHORIZED`; missing resource → `NOT_FOUND`; otherwise `REQUEST_FAILED`.
- **List** (unbounded collections): `{ data: T[], pagination: { limit, offset, total } }` for
  `GET /assets` and `GET /assets/:id/audit`. Bounded lists (`/chains`, `/use-cases`, `/accounts`,
  `/assets/:id/accounts`, `/assets/:id/tokens`) remain plain arrays.

### Query gaps
- `GET /assets?useCaseKey=&chainId=&status=&limit=&offset=` — `AssetRepository.list(filter, page)`
  gains optional filtering + `{ items, total }`; implemented for memory + Prisma (Prisma uses
  `where` + `skip`/`take` + `count`).
- `GET /assets/:id/audit?limit=&offset=` — `AuditRepository.listByAsset(id, page)` returns
  `{ items, total }`.

### Structure
Split the growing `app.ts` into focused units under `apps/api/src/http/`:
```
http/
  schemas.ts            shared components + per-route schema objects
  error-handler.ts      maps errors → the error envelope
  authenticate.ts       JWT preHandler
  routes/
    auth.ts  catalog.ts  use-cases.ts  assets.ts  actions.ts
```
`buildApp(deps)` registers `@fastify/swagger`, the shared schemas, JWT, the error handler, then the
route plugins under `/api/v1`. `AppDeps` injection is unchanged, so tests run over memory repos.

### Endpoints (unchanged paths, now under /api/v1)
- `POST /auth/login`, `GET /me`
- `GET /chains`
- `GET /use-cases`, `GET /use-cases/:key`, `POST /use-cases`, `PUT /use-cases/:key`
- `GET /accounts`
- `POST /assets`, `GET /assets` (filter+paginate), `GET /assets/:id`
- `GET /assets/:id/accounts`, `GET /assets/:id/tokens`, `GET /assets/:id/audit` (paginate)
- `POST /assets/:id/actions/:action`

## Testing

- Rewrite `apps/api/test/api.test.ts` for the `/api/v1` prefix and `{ data, pagination }` list shape.
- New tests: `GET /openapi.json` is a valid OpenAPI 3 doc with the documented paths; a malformed
  POST body → `400 VALIDATION_ERROR`; `/assets` filtering + pagination (`total`/`limit`/`offset`);
  a 404 returns the error envelope.
- Full `pnpm -r typecheck` + `pnpm -r test`; run the server and fetch `/openapi.json` + `/docs`.

## Out of scope

Machine API keys, webhooks, idempotency keys, bulk endpoints (these were the "new capabilities"
option, not selected). No change to auth model, engine, adapters, or contracts.

## Dependencies

`@fastify/swagger`, `@fastify/swagger-ui` (apps/api only).
