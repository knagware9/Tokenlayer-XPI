/**
 * A TOKENIZATION DEPLOYMENT THAT HAS NO USE FOR CREDENTIALS.
 *
 * Not every tokenization customer is running digital identity. `SUBJECT_
 * IDENTIFIERS=plain` says so: users are ordinary accounts with an id, an email
 * and a role, and onboarding mints no custodial seed and issues no credential.
 *
 * ORGANIZATIONS STILL CARRY A DID either way, and that asymmetry is the point
 * worth testing. An org's DID signs its members' credentials and is what the
 * on-chain registry trusts — dropping it would take the platform's own issuer
 * identity with it, which is a much larger decision than "our users are not
 * credential holders".
 *
 * The failure this guards against is the quiet one: a deployment configured for
 * plain identifiers that mints DIDs anyway, or one that accepts a `kyc` block
 * and reports the user KYC-approved while they hold nothing. Both leave a user
 * who LOOKS verified to every screen that asks.
 */
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

/** Onboard through the maker-checker path and return the created user row. */
async function onboard(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, body: Record<string, unknown>) {
  const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
  const checker = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
  const res = await h.app.inject({ method: "POST", url: `${V1}/users`, headers: auth(maker), payload: body });
  if (res.statusCode !== 202) return { res, user: null };
  const appr = await h.app.inject({
    method: "POST", url: `${V1}/proposals/${res.json().proposal.id}/approve`, headers: auth(checker), payload: {},
  });
  const list = (await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(maker) })).json() as { email: string }[];
  return { res, appr, user: list.find((u) => u.email === body.email) ?? null };
}

describe("SUBJECT_IDENTIFIERS=plain — users are ordinary accounts", () => {
  const plain = { enabledDomains: ["tokenization"], subjectIdentifiers: "plain" as const };

  it("onboards a working user with NO did and NO credential", async () => {
    const h = await buildTestAppWithRepos(plain);
    try {
      const email = `plain-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const { res, user } = await onboard(h, { email, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit" });
      expect(res.statusCode).toBe(202);
      expect(user).toBeTruthy();

      const row = await h.deps.users.findByEmail(email);
      expect(row, "the user exists").toBeTruthy();
      expect(row?.did ?? null, "no DID was minted").toBeNull();
      expect((row as { didSeedEncrypted?: string | null })?.didSeedEncrypted ?? null, "no custodial seed was stored").toBeNull();

      // …and they can actually sign in. A mode that produced an unusable
      // account would pass every assertion above.
      const token = await loginAs(h.app, email, "Password123!");
      expect(token, "the plain user can sign in").toBeTruthy();
    } finally { await h.app.close(); }
  }, 45_000);

  it("REFUSES a kyc block rather than reporting a verification it did not do", async () => {
    // The dangerous alternative: accept it, mark kycStatus approved, issue
    // nothing. The user then looks verified to every screen that asks.
    const h = await buildTestAppWithRepos(plain);
    try {
      const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const res = await h.app.inject({
        method: "POST", url: `${V1}/users`, headers: auth(maker),
        payload: { email: `k-${Math.random().toString(36).slice(2, 8)}@example.com`, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit", kyc: { legalName: "Asha", country: "IN" } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("SUBJECT_IDENTIFIERS_PLAIN");
    } finally { await h.app.close(); }
  }, 45_000);

  it("REFUSES a linked DID too — there is nothing here to link it to", async () => {
    const h = await buildTestAppWithRepos(plain);
    try {
      const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const res = await h.app.inject({
        method: "POST", url: `${V1}/users`, headers: auth(maker),
        payload: { email: `d-${Math.random().toString(36).slice(2, 8)}@example.com`, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit", did: "did:key:z6MkExternal" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("SUBJECT_IDENTIFIERS_PLAIN");
    } finally { await h.app.close(); }
  }, 45_000);

  it("ORGANIZATIONS STILL GET A DID — the asymmetry this mode is built on", async () => {
    const h = await buildTestAppWithRepos(plain);
    try {
      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const res = await h.app.inject({
        method: "POST", url: `${V1}/orgs`, headers: auth(admin),
        payload: { name: `Org ${Math.random().toString(36).slice(2, 8)}`, orgType: "corporate" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().did, "an org's DID signs and anchors — it survives plain mode").toMatch(/^did:key:/);
    } finally { await h.app.close(); }
  }, 45_000);

  it("says so on /config, so the console can hide what does not exist", async () => {
    const h = await buildTestAppWithRepos(plain);
    try {
      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const cfg = (await h.app.inject({ method: "GET", url: `${V1}/config`, headers: auth(admin) })).json();
      // ADDITIVITY: absent from the response schema and fast-json-stringify
      // would drop it, leaving the console to guess.
      expect(cfg.subjectIdentifiers).toBe("plain");
    } finally { await h.app.close(); }
  }, 45_000);
});

describe("SUBJECT_IDENTIFIERS=did — unchanged, and the default", () => {
  it("still mints a custodial DID", async () => {
    const h = await buildTestAppWithRepos({ enabledDomains: ["tokenization"], subjectIdentifiers: "did" });
    try {
      const email = `did-${Math.random().toString(36).slice(2, 8)}@example.com`;
      await onboard(h, { email, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit" });
      const row = await h.deps.users.findByEmail(email);
      expect(row?.did, "a DID was minted").toMatch(/^did:key:/);
    } finally { await h.app.close(); }
  }, 45_000);

  it("ABSENT means did — every deployment that predates this setting is untouched", async () => {
    // The construction sites in e2e-*.ts and the test helpers pass nothing.
    const h = await buildTestAppWithRepos({ enabledDomains: ["tokenization"] });
    try {
      const email = `def-${Math.random().toString(36).slice(2, 8)}@example.com`;
      await onboard(h, { email, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit" });
      const row = await h.deps.users.findByEmail(email);
      expect(row?.did).toMatch(/^did:key:/);

      const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const cfg = (await h.app.inject({ method: "GET", url: `${V1}/config`, headers: auth(admin) })).json();
      expect(cfg.subjectIdentifiers).toBe("did");
    } finally { await h.app.close(); }
  }, 45_000);
});

describe("the identity gate under plain identifiers", () => {
  it("fails CLOSED, naming plain identifiers rather than an unreachable service", async () => {
    // The wrong answer here is "not verified": a gate that refuses everyone
    // while reporting that some identity service was down sends the operator
    // looking for a network problem that does not exist.
    const { selectIdentityAssertions } = await import("../src/identity/identity-assertions.js");
    const assertions = selectIdentityAssertions({
      subjectIdentifiers: "plain",
      enabledDomains: ["tokenization"],
      credentials: { listByHolder: async () => [] } as never,
    });
    await expect(assertions.holds("did:key:zAnything", "KycCredential")).rejects.toThrow(/plain/i);
  });
});
