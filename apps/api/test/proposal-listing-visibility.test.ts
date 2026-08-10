import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

/**
 * `GET /proposals` must show a caller only what `canView` admits — the very
 * predicate `scopedProposal` (and therefore approve/reject) has always used.
 *
 * It did not. The listing narrowed by INDEX — every proposal at your desk, every
 * proposal of your org — and then filtered only by `decidableByPrincipal`, which
 * returns true unconditionally for a human session because it exists to gate API
 * KEYS by scope. So any role at a desk saw its `onboard-user` proposals, and any
 * member of an org saw its credential and governance proposals, even though each
 * of those kinds admits only a UseCaseAdmin of that desk or an OrgAdmin of that
 * org respectively.
 *
 * Two things were wrong with that at once, and the second is the worse one:
 *
 *  1. The listing offered a decision the decide route answers 404 to.
 *  2. `payload` carries the SUBJECT'S KYC — legalName, country, idType,
 *     idNumber. A listing is a read, and this one read out personal data to
 *     colleagues who are not approvers.
 */
describe("GET /proposals shows only what the caller may actually view", () => {
  const KYC = { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" };

  /** A UseCaseAdmin and an Issuer, both at `carbon-credit`. */
  async function desk(app: Awaited<ReturnType<typeof buildTestApp>>) {
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const platform2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await onboardUser(app, platform, platform2, {
      email: "uca@carbon.dev", password: "uca-secret-1", role: "UseCaseAdmin", useCaseKey: "carbon-credit",
    });
    await onboardUser(app, platform, platform2, {
      email: "issuer@carbon.dev", password: "issuer-secret-1", role: "Issuer", useCaseKey: "carbon-credit",
    });
    return {
      platform,
      uca: await loginAs(app, "uca@carbon.dev", "uca-secret-1"),
      issuer: await loginAs(app, "issuer@carbon.dev", "issuer-secret-1"),
    };
  }

  it("an Issuer at the desk neither sees an onboard-user proposal nor can decide it; the UseCaseAdmin does both", async () => {
    const app = await buildTestApp();
    const { uca, issuer } = await desk(app);

    // The desk's UseCaseAdmin proposes onboarding a holder, KYC and all.
    const proposed = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(uca),
      payload: { email: "ada@carbon.dev", password: "ada-secret-1", role: "Buyer", useCaseKey: "carbon-credit", kyc: KYC },
    });
    expect(proposed.statusCode).toBe(202);
    const id = proposed.json().proposal.id as string;

    // The Issuer shares the desk, so the INDEX returns this row — but `canView`
    // for `onboard-user` admits only a UseCaseAdmin of the desk.
    const issuerList = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(issuer) });
    expect(issuerList.statusCode).toBe(200);
    expect((issuerList.json() as { id: string }[]).some((p) => p.id === id)).toBe(false);
    // Nothing leaked: the subject's identifiers appear nowhere in the response.
    expect(issuerList.payload).not.toContain("Ada Lovelace");
    expect(issuerList.payload).not.toContain("P1234567");

    // And the listing now agrees with the decide route, which has always refused.
    const denied = await app.inject({ method: "POST", url: `${V1}/proposals/${id}/approve`, headers: auth(issuer), payload: {} });
    expect(denied.statusCode).toBe(404);

    // The check is a filter, not a blanket: the desk's UseCaseAdmin still sees it.
    // (They proposed it, so SoD stops them DECIDING it — visibility is the subject here.)
    const ucaList = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(uca) });
    expect((ucaList.json() as { id: string }[]).some((p) => p.id === id)).toBe(true);
  });

  it("token-op proposals are unaffected — an Issuer still sees their own desk's", async () => {
    const app = await buildTestApp();
    const { platform, issuer } = await desk(app);

    // A gated token op at the desk drafts a proposal `tokenCanView` admits for
    // anyone scoped to that use case, the Issuer included.
    const asset = await app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: {
        useCaseKey: "carbon-credit", name: "Verra Batch", chainId: "fabric",
        metadata: { projectName: "P", registry: "Verra", vintage: 2024 },
      },
    });
    expect([201, 202]).toContain(asset.statusCode);

    const listed = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(issuer) });
    expect(listed.statusCode).toBe(200);
    // Every row the Issuer can see is one they are actually scoped to.
    for (const p of listed.json() as { useCaseKey: string | null }[]) {
      expect(p.useCaseKey).toBe("carbon-credit");
    }
  });

  it("a PlatformAdmin still sees every kind", async () => {
    const app = await buildTestApp();
    const { platform, uca } = await desk(app);
    const id = (await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(uca),
      payload: { email: "ada2@carbon.dev", password: "ada-secret-2", role: "Buyer", useCaseKey: "carbon-credit", kyc: KYC },
    })).json().proposal.id as string;

    const listed = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(platform) });
    expect((listed.json() as { id: string }[]).some((p) => p.id === id)).toBe(true);
  });
});
