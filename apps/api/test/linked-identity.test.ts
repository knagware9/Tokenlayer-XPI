/**
 * A HOLDER WHOSE IDENTITY LIVES ON ANOTHER DEPLOYMENT.
 *
 * Onboarding mints a custodial DID. On a split topology that is exactly wrong:
 * the same person onboarded on the identity deployment and on the tokenization
 * deployment ends up with TWO DIDs, and `requireVerifiedIdentity` asks the
 * identity service about one it has never issued anything to. The answer is no,
 * for every holder, forever — a gate that reads as policy and is really a
 * plumbing mismatch, and the kind of thing that only shows up once the two
 * halves are actually apart.
 *
 * So `POST /users` takes an optional `did`: LINK the identity issued elsewhere
 * instead of minting one. Three rules make that safe rather than a back door:
 *
 *   · a deployment that RUNS the identity product refuses it outright — there
 *     it mints its own, and accepting a caller's would let an operator point a
 *     wallet at somebody else's verified identity;
 *   · `did` and `kyc` are alternatives, never a pair — one links an identity
 *     issued elsewhere, the other asks THIS deployment to issue one;
 *   · a linked user gets NO custodial seed, because this deployment does not
 *     hold that key and must never be able to sign as them.
 */
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const EXTERNAL_DID = "did:key:z6MkIssuedByTheIdentityDeployment";

/** Onboard through the real gated door: 202 proposal, approved by a second manager. */
async function onboard(h: TestAppHandle, maker: string, checker: string, body: Record<string, unknown>) {
  const res = await h.app.inject({ method: "POST", url: `${V1}/users`, headers: auth(maker), payload: body });
  if (res.statusCode !== 202) return res;
  const approve = await h.app.inject({
    method: "POST", url: `${V1}/proposals/${res.json().proposal.id}/approve`, headers: auth(checker), payload: {},
  });
  return approve;
}

async function tokenizationOnly() {
  const h = await buildTestAppWithRepos({ enabledDomains: ["tokenization"] });
  const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
  const checker = await loginAs(h.app, "admin2@tokenlayer.dev", "admin123");
  return { h, maker, checker };
}

describe("linking a DID issued by a separately-deployed identity service", () => {
  it("links it instead of minting, and stores NO seed for it", async () => {
    const { h, maker, checker } = await tokenizationOnly();
    try {
      const email = `linked-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const res = await onboard(h, maker, checker, {
        email, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit",
        walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", did: EXTERNAL_DID,
      });
      expect(res.statusCode, res.payload).toBe(200);

      const user = await h.deps.users.findByEmail(email);
      expect(user?.did, "the DID the identity service knows them by").toBe(EXTERNAL_DID);
      // THE LOAD-BEARING HALF. A seed here would mean this deployment could sign
      // as the holder — custody it does not have and must not claim.
      expect(user?.didSeedEncrypted ?? null).toBeNull();
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("still mints its own when none is supplied — the unchanged path", async () => {
    // The positive control: without it, the assertion above would pass on a
    // build that had simply stopped minting DIDs for everybody.
    const { h, maker, checker } = await tokenizationOnly();
    try {
      const email = `minted-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const res = await onboard(h, maker, checker, {
        email, password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit",
      });
      expect(res.statusCode, res.payload).toBe(200);
      const user = await h.deps.users.findByEmail(email);
      expect(user?.did).toMatch(/^did:key:/);
      expect(user?.did).not.toBe(EXTERNAL_DID);
      expect(user?.didSeedEncrypted, "a minted DID is custodial, so its seed is kept").toBeTruthy();
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("is REFUSED by a deployment that runs the identity product", async () => {
    const h = await buildTestAppWithRepos({ enabledDomains: ["tokenization", "identity"] });
    try {
      const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
      const res = await h.app.inject({
        method: "POST", url: `${V1}/users`, headers: auth(maker),
        payload: { email: "nope@example.com", password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit", did: EXTERNAL_DID },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "DID_NOT_ACCEPTED" });
    } finally {
      await h.app.close();
    }
  }, 30_000);

  it("is refused together with `kyc` — they are alternatives, not a pair", async () => {
    const { h, maker } = await tokenizationOnly();
    try {
      const res = await h.app.inject({
        method: "POST", url: `${V1}/users`, headers: auth(maker),
        payload: {
          email: "both@example.com", password: "Password123!", role: "Buyer", useCaseKey: "carbon-credit",
          did: EXTERNAL_DID, kyc: { legalName: "Asha Rao", country: "IN" },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "DID_NOT_ACCEPTED" });
      // The failure mode this refusal prevents: a holder created, looking
      // onboarded, with a linked DID and a locally-issued credential against it
      // — two identities' worth of state and no way to tell which one counts.
      expect(await h.deps.users.findByEmail("both@example.com")).toBeNull();
    } finally {
      await h.app.close();
    }
  }, 30_000);
});
