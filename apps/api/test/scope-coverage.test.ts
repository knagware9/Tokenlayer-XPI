import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_SCOPES } from "@tokenlayer/core";
import { describe, expect, it } from "vitest";

/**
 * EN-B: THE SCOPE MAP IS FAIL-OPEN BY OMISSION, SO THIS TEST CLOSES IT.
 *
 * A route written as `{ schema: S.x, ...auth }` authenticates the caller but
 * applies NO scope gate, which for an API key means "any key, any scope, may do
 * this". That default is silent and compiles fine — three real holes
 * (provisioning's desk users, the invoice register's second door onto
 * issueAssetCore, and the maker-checker approval that EXECUTES what the drafting
 * routes gate) all existed for exactly that reason.
 *
 * Rather than force ~125 call sites to spell out "unscoped", this test makes the
 * decision mandatory in ONE reviewable place: EVERY route — read as well as
 * write — must either carry `authScoped(...)` or appear below with a reason. A
 * new route that does neither fails the build.
 *
 * READS COUNT. An earlier version of this test filtered `method !== "GET"`, and
 * that exemption was itself the next hole: `GET /proposals` returned the bcrypt
 * password hash of a pending human account to any key with any scope. A scope
 * map that governs only mutations governs half the surface — disclosure is an
 * authorization decision too.
 *
 * It reads the source rather than Fastify's route table because what is under
 * test is the DECLARATION — the shape a future author will copy — and because a
 * runtime table cannot tell "no scope gate" from "a scope gate that passes".
 */
const ROUTES_TS = fileURLToPath(new URL("../src/http/routes.ts", import.meta.url));

/** `app.post("/path", { …options… }` — the options object never nests braces. */
const ROUTE_RE = /app\.(get|post|put|patch|delete)\("([^"]+)",\s*\{([^}]*)\}/g;

type Decl = { method: string; path: string; scope: string | null; authed: boolean };

function declaredRoutes(): Decl[] {
  const src = readFileSync(ROUTES_TS, "utf8");
  const out: Decl[] = [];
  for (const m of src.matchAll(ROUTE_RE)) {
    const [, method, path, opts] = m as unknown as [string, string, string, string];
    const scoped = /\.\.\.authScoped\("([^"]+)"\)/.exec(opts);
    out.push({ method: method.toUpperCase(), path, scope: scoped?.[1] ?? null, authed: opts.includes("...auth") });
  }
  return out;
}

const key = (d: { method: string; path: string }): string => `${d.method} ${d.path}`;

/**
 * Routes that deliberately carry NO scope gate. Each entry states WHY. Adding a
 * line here is the explicit decision the default cannot express — it should be
 * as reviewable as adding the gate itself.
 */
const DELIBERATELY_UNSCOPED: Record<string, string> = {
  // --- public: no principal at all, so there is no key to narrow ------------
  "POST /auth/login": "public; a key cannot authenticate here and a service user is refused outright",
  "POST /auth/qr/start": "public; unauthenticated QR session bootstrap",
  "POST /auth/qr/:id/authenticate": "public; refuses service users at the JWT-minting step",
  "POST /orgs/register/documents": "public; self-registration KYB upload",
  "POST /orgs/register": "public; org self-registration, gated by PlatformAdmin approval",

  // --- refuse machine principals outright (stronger than any scope) ---------
  "POST /me/login-keys": "403 MACHINE_PRINCIPAL: a key may not enrol a durable device credential",
  "POST /orgs/:id/api-keys": "403 MACHINE_PRINCIPAL: a key may not mint another key (the one scope-widening path)",
  "POST /orgs/:id/api-keys/:keyId/rotate": "403 MACHINE_PRINCIPAL: key lifecycle is a human act",
  "DELETE /orgs/:id/api-keys/:keyId": "403 MACHINE_PRINCIPAL: key lifecycle is a human act",
  "POST /orgs/:id/approve": "403 MACHINE_PRINCIPAL: platform governance (admitting a tenant)",
  "POST /orgs/:id/reject": "403 MACHINE_PRINCIPAL: platform governance (admitting a tenant)",
  "PATCH /orgs/:id/capabilities": "403 MACHINE_PRINCIPAL: a key may never raise the envelope that bounds it",

  // --- gated dynamically, by something a static scope cannot express --------
  "POST /proposals/:id/approve": "scope derived from the proposal's KIND inside decide() — see ProposalKindHandler.apiScope",
  "POST /proposals/:id/reject": "scope derived from the proposal's KIND inside decide() — deciding either way is a decision",
  "POST /orgs/:id/capabilities/request": "drafts only; the change applies via org-capability-change, which no key may approve",

  // --- self-affecting: acts on the caller's own artefacts, grants nothing ---
  "DELETE /me/login-keys/:id": "removes the caller's OWN device key; revoking access needs no scope",
  "POST /me/credentials/:id/accept": "the caller's OWN held credential; confers no authority over anyone",
  "POST /me/credentials/:id/reject": "the caller's OWN held credential; confers no authority over anyone",
  "POST /me/credentials/:id/request-changes": "the caller's OWN held credential; confers no authority over anyone",
  "POST /verification-requests/:id/reject": "holder DECLINING disclosure; denies rather than grants",

  // --- no persistence, or no authority conferred ---------------------------
  "POST /use-cases/preview-code": "pure render of contract source; writes nothing",
  "POST /credential-use-case-templates/:key/preview": "pure template render; writes nothing",
  "POST /audit/anchor": "integrity-only on-chain write; confers no authority, bounded by role + the per-key rate limit",
  // Scoped on PRIVILEGE only, and that is the whole claim: the bytes are
  // opaque, reading one back needs assets:read, and every act that USES a
  // document is scoped, so an upload confers no authority. It says NOTHING
  // about storage growth — a key with `issue` rights can upload repeatedly up
  // to DOC_UPLOAD_BODY_LIMIT per request, bounded only by the per-key rate
  // limit, with no quota and no retention. That is the review's LOW-3, left
  // open on purpose; do not read this entry as covering it.
  "POST /documents": "stores opaque bytes; every act that USES a document is scoped (privilege only — not a storage bound)",
  "POST /identity/mint": "dev-only demo minter (404 unless DEV_ISSUER_SEED is set); absent in production",

  // === READS ===============================================================
  // --- public: no principal, so no key to narrow ---------------------------
  "GET /auth/qr/:id": "public; QR session poll",
  "GET /dids/:did/resolve": "public by design; a DID document is public key material",
  "GET /credentials/:id/status": "public by design; a third-party verifier holding only the VC must resolve its status",
  "GET /credentials/:id/certificate.pdf": "public by design; the certificate is the credential's own presentation",

  // --- the caller's own session/device state -------------------------------
  "GET /me": "the caller's OWN claims — the identity the key already proved",
  "GET /config": "deployment's enabled domains; no principal data",
  "GET /me/login-keys": "the caller's own device keys (public did:key values); enrolling one is refused to keys outright",

  // --- deployment configuration, identical for every tenant ----------------
  "GET /chains": "chain catalog; deployment config, no principal or asset data",
  "GET /chains/:id/status": "chain connectivity; deployment config",
  "GET /currencies": "currency catalog; static deployment config",
  "GET /registry": "on-chain registry contract addresses; public chain data",
  "GET /credential-types": "the closed built-in credential-type catalog; static",
  "GET /credential-templates": "starter credential-type catalog; static",
  "GET /credential-use-case-templates": "template catalog metadata; authoring input, no principal data",
  "GET /credential-use-case-templates/:key": "one template's parameters; authoring input",
  "GET /use-cases": "use-case config the caller is already scoped to; no principal or holding data",
  "GET /use-cases/:key": "one use-case config; scoped by the existing tenancy check",
  "GET /use-cases/:key/code": "the use case's own contract source; configuration, not data",
  "GET /credential-use-cases": "credential use-case config; no principal data",
  "GET /credential-use-cases/:key": "one credential use-case config",
  "GET /dids/:did/document": "the same public key material the unauthenticated /dids/:did/resolve returns",

  // --- gated by something a static scope cannot express --------------------
  "GET /proposals": "filtered per-kind for key principals — a key sees only proposals it could DECIDE (see decidableByPrincipal); payloads are redacted for everyone",
  "GET /orgs/:id/api-keys": "403 MACHINE_PRINCIPAL: a key may not enumerate keys",
};

describe("API-key scope coverage (EN-B)", () => {
  const routes = declaredRoutes();

  it("parses the route table", () => {
    // A parser that silently matched nothing would make every assertion below vacuous.
    expect(routes.length).toBeGreaterThan(60);
    expect(routes.some((r) => r.scope !== null)).toBe(true);
  });

  it("EVERY route — read and write — is either scope-gated or listed with a reason", () => {
    const undecided = routes
      .filter((r) => r.scope === null && !(key(r) in DELIBERATELY_UNSCOPED))
      .map(key);
    // If this fails you added a route without deciding what an API key may do
    // with it. Add `...authScoped("<scope>")`, or add it to
    // DELIBERATELY_UNSCOPED above WITH the reason. Reads need the decision as
    // much as writes: disclosure is an authorization decision. Do not delete
    // this test, and do not re-introduce a `method !== "GET"` filter — that
    // exemption is exactly how the GET /proposals password-hash leak survived.
    expect(undecided).toEqual([]);
  });

  it("every declared scope is a real one from core's closed vocabulary", () => {
    for (const r of routes.filter((x) => x.scope !== null)) {
      expect(API_SCOPES as readonly string[]).toContain(r.scope!);
    }
  });

  it("the allowlist has no stale entries", () => {
    // A route that has since been scoped (or deleted) must not keep a standing
    // exemption — that is how an allowlist rots into a rubber stamp.
    const ungated = new Set(routes.filter((r) => r.scope === null).map(key));
    const stale = Object.keys(DELIBERATELY_UNSCOPED).filter((k) => !ungated.has(k));
    expect(stale).toEqual([]);
  });

  it("the two doors onto asset issuance agree", () => {
    // The H2 regression in one line: whatever gates POST /assets must gate the
    // invoice register's tokenize, because both call issueAssetCore.
    const scopeOf = (k: string) => routes.find((r) => key(r) === k)?.scope;
    expect(scopeOf("POST /assets")).toBe("assets:issue");
    expect(scopeOf("POST /use-cases/:key/invoices/tokenize")).toBe("assets:issue");
  });
});
