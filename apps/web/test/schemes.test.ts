/**
 * THE NUMBERS A SCHEME GETS REPORTED BY.
 *
 * These counts end up in a review meeting, a funding request or an RTI reply.
 * The failure they exist to prevent is a single "issued: N" standing in for
 * everything — which overstates delivery (it counts credentials the issuer
 * later withdrew) and understates it (it hides that most holders never accepted
 * theirs) in the same breath.
 *
 * The precedence — revoked, then acceptance, then expiry — is the same order the
 * server's identity predicate, the certificate renderer and the identity
 * dashboard use. A beneficiary must not read "active" on one screen and
 * "lapsed" on another, so it is pinned here rather than left to whichever
 * condition happens to be checked first.
 */
import { describe, expect, it } from "vitest";
import { beneficiariesOf, countsFor, groupByScheme, matchesQuery, nameFrom, schemesRunBy, statusOf } from "../src/lib/schemes.js";
import type { CredentialUseCase, IssuedCredential } from "../src/types.js";

const NOW = Date.parse("2026-08-13T00:00:00.000Z");
const cred = (over: Partial<IssuedCredential> = {}): IssuedCredential => ({
  id: `cred_${Math.random().toString(36).slice(2, 8)}`,
  type: "DomicileCredential", holderDid: "did:key:zA", claims: { holderName: "Asha Rao" },
  issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null,
  credentialUseCaseKey: "domicile-certificate", acceptance: "accepted", ...over,
});

describe("statusOf — one credential's standing", () => {
  it("active when issued, accepted and unexpired", () => {
    expect(statusOf(cred(), NOW)).toBe("active");
  });

  it("REVOKED wins over everything — the issuer withdrew it", () => {
    // Even if it also lapsed and was never accepted, the operative fact is the
    // withdrawal: it is not "expired", it was taken away.
    expect(statusOf(cred({ revoked: true, acceptance: "pending", expiresAt: "2020-01-01T00:00:00.000Z" }), NOW)).toBe("revoked");
  });

  it("pending beats expiry — never taken up is not the same as lapsed", () => {
    expect(statusOf(cred({ acceptance: "pending", expiresAt: "2020-01-01T00:00:00.000Z" }), NOW)).toBe("pending");
  });

  it("treats rejected and changes_requested as rejected", () => {
    expect(statusOf(cred({ acceptance: "rejected" }), NOW)).toBe("rejected");
    expect(statusOf(cred({ acceptance: "changes_requested" }), NOW)).toBe("rejected");
  });

  it("an ABSENT acceptance means accepted — the untouched default", () => {
    // The API omits `acceptance` for a credential born accepted. Reading that
    // absence as "pending" would report every pre-ceremony credential as not
    // taken up.
    expect(statusOf(cred({ acceptance: undefined }), NOW)).toBe("active");
  });

  it("expired only when the instant has passed, and compares instants not strings", () => {
    expect(statusOf(cred({ expiresAt: "2099-01-01T00:00:00.000Z" }), NOW)).toBe("active");
    expect(statusOf(cred({ expiresAt: "2020-01-01T00:00:00.000Z" }), NOW)).toBe("expired");
    // `2026-08-13T05:30:00+05:30` IS midnight UTC — the same instant as NOW, so
    // not yet expired. Lexicographically it sorts after and would read expired.
    expect(statusOf(cred({ expiresAt: "2026-08-13T05:30:00+05:30" }), NOW)).toBe("active");
  });
});

describe("countsFor — what gets quoted in a review", () => {
  it("separates issued from in force", () => {
    const c = countsFor([
      cred({ holderDid: "did:key:z1" }),
      cred({ holderDid: "did:key:z2", revoked: true }),
      cred({ holderDid: "did:key:z3", acceptance: "pending" }),
      cred({ holderDid: "did:key:z4", expiresAt: "2020-01-01T00:00:00.000Z" }),
    ], NOW);
    expect(c.issued).toBe(4);
    expect(c.active).toBe(1);
    expect(c.revoked).toBe(1);
    expect(c.pending).toBe(1);
    expect(c.expired).toBe(1);
  });

  it("counts BENEFICIARIES as distinct holders, not credentials", () => {
    // A reissue is not a second person. Counting rows here is how a scheme
    // reports more beneficiaries than the population it serves.
    const c = countsFor([
      cred({ holderDid: "did:key:zSame", issuedAt: "2026-01-01T00:00:00.000Z" }),
      cred({ holderDid: "did:key:zSame", issuedAt: "2026-06-01T00:00:00.000Z" }),
      cred({ holderDid: "did:key:zOther" }),
    ], NOW);
    expect(c.issued).toBe(3);
    expect(c.beneficiaries).toBe(2);
  });

  it("expiringSoon is the work queue: active, and lapsing within 30 days", () => {
    const c = countsFor([
      cred({ holderDid: "did:key:z1", expiresAt: "2026-08-20T00:00:00.000Z" }), // 7 days
      cred({ holderDid: "did:key:z2", expiresAt: "2026-10-20T00:00:00.000Z" }), // beyond
      cred({ holderDid: "did:key:z3", expiresAt: null }),                        // never
      cred({ holderDid: "did:key:z4", expiresAt: "2020-01-01T00:00:00.000Z" }), // already gone
      cred({ holderDid: "did:key:z5", expiresAt: "2026-08-20T00:00:00.000Z", revoked: true }),
    ], NOW);
    expect(c.expiringSoon).toBe(1);
    // A revoked credential is not a renewal to chase.
    expect(c.revoked).toBe(1);
  });

  it("an empty scheme counts zero, not NaN", () => {
    expect(countsFor([], NOW)).toMatchObject({ issued: 0, beneficiaries: 0, active: 0, expiringSoon: 0 });
  });
});

describe("groupByScheme", () => {
  it("groups by programme and keeps unscoped credentials OUT of every scheme", () => {
    // A KycCredential minted at onboarding belongs to no programme. Folding it
    // into one inflates that scheme with enrolment paperwork.
    const { byScheme, unscoped } = groupByScheme([
      cred({ credentialUseCaseKey: "domicile-certificate" }),
      cred({ credentialUseCaseKey: "domicile-certificate" }),
      cred({ credentialUseCaseKey: "egovernance-certificate" }),
      cred({ credentialUseCaseKey: null, type: "KycCredential" }),
    ]);
    expect(byScheme.get("domicile-certificate")).toHaveLength(2);
    expect(byScheme.get("egovernance-certificate")).toHaveLength(1);
    expect(unscoped).toHaveLength(1);
    expect(byScheme.has("null")).toBe(false);
  });

  it("treats an undefined key the same as null — an older API answer", () => {
    const { byScheme, unscoped } = groupByScheme([cred({ credentialUseCaseKey: undefined })]);
    expect(byScheme.size).toBe(0);
    expect(unscoped).toHaveLength(1);
  });
});

describe("beneficiariesOf — one row per person", () => {
  it("collapses a holder's history and takes the NEWEST credential's status", () => {
    // The renewal case: an expired certificate reissued last month. The person
    // is active — reporting them as expired would send a chaser to someone who
    // already renewed.
    const rows = beneficiariesOf([
      cred({ holderDid: "did:key:zA", issuedAt: "2024-01-01T00:00:00.000Z", expiresAt: "2025-01-01T00:00:00.000Z" }),
      cred({ holderDid: "did:key:zA", issuedAt: "2026-07-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }),
    ], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.credentials).toHaveLength(2);
    expect(rows[0]!.latest.issuedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("orders newest first", () => {
    const rows = beneficiariesOf([
      cred({ holderDid: "did:key:zOld", issuedAt: "2025-01-01T00:00:00.000Z" }),
      cred({ holderDid: "did:key:zNew", issuedAt: "2026-08-01T00:00:00.000Z" }),
    ], NOW);
    expect(rows.map((r) => r.holderDid)).toEqual(["did:key:zNew", "did:key:zOld"]);
  });

  it("finds a name wherever the scheme put it, and tolerates none", () => {
    expect(nameFrom({ holderName: "Asha Rao" })).toBe("Asha Rao");
    expect(nameFrom({ legalName: "Ravi Kumar" })).toBe("Ravi Kumar");
    expect(nameFrom({ businessName: "Acme Traders" })).toBe("Acme Traders");
    expect(nameFrom({ holderName: "   " })).toBeNull(); // blank is not a name
    expect(nameFrom({ annualIncome: 120000 })).toBeNull();
  });
});

describe("matchesQuery — what an operator types at a counter", () => {
  const rows = beneficiariesOf([
    cred({ holderDid: "did:key:zAsha", id: "cred_abc", claims: { holderName: "Asha Rao", district: "Pune" } }),
  ], NOW);
  const row = rows[0]!;

  it("matches the name, case-insensitively", () => {
    expect(matchesQuery(row, "asha")).toBe(true);
    expect(matchesQuery(row, "RAO")).toBe(true);
  });

  it("matches the DID and the credential id — what a support ticket quotes", () => {
    expect(matchesQuery(row, "zAsha")).toBe(true);
    expect(matchesQuery(row, "cred_abc")).toBe(true);
  });

  it("matches any string claim, so a district or ward finds its people", () => {
    expect(matchesQuery(row, "pune")).toBe(true);
  });

  it("an empty query matches everything rather than nothing", () => {
    expect(matchesQuery(row, "")).toBe(true);
    expect(matchesQuery(row, "   ")).toBe(true);
  });

  it("does not match an unrelated term", () => {
    expect(matchesQuery(row, "mumbai")).toBe(false);
  });
});

describe("schemesRunBy — which programmes are this authority's", () => {
  const uc = (over: Partial<CredentialUseCase>): CredentialUseCase => ({
    key: "k", name: "N", credentialTypes: [], issuer: { kind: "platform" },
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" }, ...over,
  } as CredentialUseCase);

  it("matches on the ISSUER BINDING — the field every provisioned scheme carries", () => {
    // The bug this test exists for: filtering on ownerOrgId alone showed every
    // authority an empty console, because a platform-provisioned use case has
    // ownerOrgId null while being issued by a real org.
    const rows = schemesRunBy([
      uc({ key: "domicile", issuer: { kind: "org", orgId: "org_district" }, ownerOrgId: null }),
      uc({ key: "someone-else", issuer: { kind: "org", orgId: "org_other" }, ownerOrgId: null }),
    ], "org_district");
    expect(rows.map((r) => r.key)).toEqual(["domicile"]);
  });

  it("also matches configuration ownership — an org that owns the definition runs it", () => {
    const rows = schemesRunBy([uc({ key: "own", issuer: { kind: "platform" }, ownerOrgId: "org_a" })], "org_a");
    expect(rows.map((r) => r.key)).toEqual(["own"]);
  });

  it("does not claim a platform-issued, unowned programme for anybody", () => {
    expect(schemesRunBy([uc({ key: "platform", issuer: { kind: "platform" }, ownerOrgId: null })], "org_a")).toEqual([]);
  });

  it("no org selected means no schemes, not every scheme", () => {
    expect(schemesRunBy([uc({ key: "x", issuer: { kind: "org", orgId: "org_a" } })], null)).toEqual([]);
  });
});
