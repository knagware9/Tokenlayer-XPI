import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

/**
 * OrgAdmin gained full operator rights (mint/transfer/burn/freeze/unfreeze/
 * allow/disallow — the same set UseCaseAdmin has) on every use case its own
 * org owns, on top of what it already did (govern the org, propose use
 * cases). UseCaseAdmin itself is unchanged; that's covered by the rest of
 * the suite continuing to pass unmodified.
 */

const platformAdmin = (h: TestAppHandle): Promise<string> => loginAs(h.app, "admin@tokenlayer.dev", "admin123");

async function makeOrg(h: TestAppHandle, admin: string, name: string): Promise<string> {
  const res = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType: "corporate" } });
  if (res.statusCode !== 201) throw new Error(`makeOrg(${name}) failed: ${res.statusCode} ${res.payload}`);
  return res.json().id as string;
}

async function makeOrgAdmin(h: TestAppHandle, admin: string, orgId: string, email: string): Promise<string> {
  const res = await h.app.inject({
    method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(admin),
    payload: { email, password: "secret1", role: "OrgAdmin" },
  });
  if (res.statusCode !== 201) throw new Error(`makeOrgAdmin failed: ${res.statusCode} ${res.payload}`);
  return loginAs(h.app, email, "secret1");
}

const TOK_DEF = (key: string) => ({
  key, name: `Notes ${key}`, symbol: "NTS", tokenStandard: "ERC-20",
  allowedChainIds: ["fabric"], defaultChainId: "fabric",
  metadataSchema: { type: "object", properties: {} },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: true, transferRestrictions: false },
  roles: ["UseCaseAdmin", "Issuer"],
});

/** The real org self-service path to an org-OWNED use case: draft → PlatformAdmin approves. */
async function ownedUseCase(h: TestAppHandle, admin: string, orgAdmin: string, key: string): Promise<string> {
  const draft = await h.app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(orgAdmin), payload: TOK_DEF(key) });
  if (draft.statusCode !== 202) throw new Error(`ownedUseCase draft failed: ${draft.statusCode} ${draft.payload}`);
  const appr = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin), payload: {} });
  const p = appr.json().proposal as { status: string };
  if (p?.status !== "executed") throw new Error(`ownedUseCase approve failed: ${appr.statusCode} ${appr.payload}`);
  return key;
}

async function issueAndMint(h: TestAppHandle, actorToken: string, useCaseKey: string, treasury: string): Promise<string> {
  const issued = await h.app.inject({
    method: "POST", url: `${V1}/assets`, headers: auth(actorToken),
    payload: { useCaseKey, name: "Op Note", symbol: "NTS", chainId: "fabric", metadata: {} },
  });
  if (issued.statusCode !== 201) throw new Error(`issue failed: ${issued.statusCode} ${issued.payload}`);
  const assetId = issued.json().asset.id as string;
  const allowTreasury = await h.app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(actorToken), payload: { account: treasury },
  });
  if (allowTreasury.statusCode !== 200) throw new Error(`allow treasury failed: ${allowTreasury.statusCode} ${allowTreasury.payload}`);
  const mint = await h.app.inject({
    method: "POST", url: `${V1}/assets/${assetId}/actions/mint`, headers: auth(actorToken), payload: { to: treasury, amount: "100" },
  });
  if (mint.statusCode !== 200) throw new Error(`mint failed: ${mint.statusCode} ${mint.payload}`);
  return assetId;
}

describe("OrgAdmin operational rights (merged with UseCaseAdmin)", () => {
  it("an OrgAdmin can issue, allow, and mint on a use case its OWN org owns", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Op Rights Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "opadmin@oprights.example");
    const key = await ownedUseCase(h, admin, orgAdmin, "op-rights-note");

    const uc = await h.app.inject({ method: "GET", url: `${V1}/use-cases/${key}`, headers: auth(orgAdmin) });
    expect(uc.statusCode).toBe(200);
    const treasuryAccountId = uc.json().treasuryAccountId as string;
    const treasury = (await h.app.inject({ method: "GET", url: `${V1}/accounts`, headers: auth(admin) })).json()
      .find((a: { id: string }) => a.id === treasuryAccountId).address as string;

    const assetId = await issueAndMint(h, orgAdmin, key, treasury);

    // Freeze/unfreeze and transfer, the rest of the operator surface.
    const freeze = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/freeze`, headers: auth(orgAdmin), payload: { account: treasury } });
    expect(freeze.statusCode).toBe(200);
    const unfreeze = await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/unfreeze`, headers: auth(orgAdmin), payload: { account: treasury } });
    expect(unfreeze.statusCode).toBe(200);
  });

  it("GET /assets merges results across every use case an OrgAdmin's org owns (no useCaseKey of its own to filter by)", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "Multi UC Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "multiuc@oprights.example");
    const keyA = await ownedUseCase(h, admin, orgAdmin, "multi-uc-a");
    const keyB = await ownedUseCase(h, admin, orgAdmin, "multi-uc-b");
    const otherOrgId = await makeOrg(h, admin, "Stranger UC Org");
    const strangerAdmin = await makeOrgAdmin(h, admin, otherOrgId, "strangeruc@oprights.example");
    const keyStranger = await ownedUseCase(h, admin, strangerAdmin, "multi-uc-stranger");

    for (const [token, key, name] of [[orgAdmin, keyA, "A Note"], [orgAdmin, keyB, "B Note"], [strangerAdmin, keyStranger, "Stranger Note"]] as const) {
      const res = await h.app.inject({
        method: "POST", url: `${V1}/assets`, headers: auth(token),
        payload: { useCaseKey: key, name, symbol: "NTS", chainId: "fabric", metadata: {} },
      });
      if (res.statusCode !== 201) throw new Error(`issue ${name} failed: ${res.statusCode} ${res.payload}`);
    }

    const list = await h.app.inject({ method: "GET", url: `${V1}/assets?limit=100&offset=0`, headers: auth(orgAdmin) });
    expect(list.statusCode).toBe(200);
    const names = (list.json().data as { name: string }[]).map((a) => a.name).sort();
    expect(names).toEqual(["A Note", "B Note"]); // both of ITS OWN use cases, never the stranger org's
  });

  it("an OrgAdmin is refused (scope) on a use case a DIFFERENT org owns", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const ownerOrgId = await makeOrg(h, admin, "Real Owner Org");
    const ownerOrgAdmin = await makeOrgAdmin(h, admin, ownerOrgId, "owner@realowner.example");
    const key = await ownedUseCase(h, admin, ownerOrgAdmin, "owner-only-note");

    const strangerOrgId = await makeOrg(h, admin, "Stranger Org");
    const strangerOrgAdmin = await makeOrgAdmin(h, admin, strangerOrgId, "stranger@stranger.example");

    // Cannot even read the use case it doesn't own.
    const uc = await h.app.inject({ method: "GET", url: `${V1}/use-cases/${key}`, headers: auth(strangerOrgAdmin) });
    expect(uc.statusCode).toBe(404);

    // Cannot issue against it either.
    const issued = await h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(strangerOrgAdmin),
      payload: { useCaseKey: key, name: "Should Fail", symbol: "NTS", chainId: "fabric", metadata: {} },
    });
    expect([403, 404]).toContain(issued.statusCode);
  });

  it("UseCaseAdmin is unaffected: still cannot see or operate a use case it isn't assigned to", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await platformAdmin(h);
    const orgId = await makeOrg(h, admin, "UCA Sanity Org");
    const orgAdmin = await makeOrgAdmin(h, admin, orgId, "ucasanity@example.com");
    const key = await ownedUseCase(h, admin, orgAdmin, "uca-sanity-note");

    // A plain seeded UseCaseAdmin scoped to a DIFFERENT use case gets the same 404 it always did.
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const uc = await h.app.inject({ method: "GET", url: `${V1}/use-cases/${key}`, headers: auth(carbonAdmin) });
    expect(uc.statusCode).toBe(404);
  });
});
