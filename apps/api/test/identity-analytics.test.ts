import { describe, expect, it } from "vitest";
import { computeIdentityDashboard, derivedCredentialStatus } from "../src/identity/identity-analytics.js";
import type { CredentialRecord, VerificationRequestRecord } from "../src/persistence/types.js";
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";

const NOW = "2026-08-06T12:00:00.000Z";

const uc = (key: string, types: string[] = ["ScoreCredential"]): CredentialUseCaseDefinition => ({
  key, name: `UC ${key}`,
  credentialTypes: types.map((name) => ({ name, title: name, validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: [], properties: {} } })),
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
});

const cred = (id: string, over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  // Realistic-length DID (>24 chars) so the label-miss truncation fallback engages.
  id, holderDid: `did:key:z6MkHolderFixture-${id}`, issuerDid: "did:key:issuer", type: "ScoreCredential",
  vcJwt: "jwt", subjectClaims: {}, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
  credentialUseCaseKey: "uc-a", acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  ...over,
});

const vreq = (id: string, over: Partial<VerificationRequestRecord> = {}): VerificationRequestRecord => ({
  id, verifierOrgId: "org-1", holderDid: "did:key:h", requestedTypes: ["ScoreCredential"],
  purpose: "p", credentialUseCaseKey: "uc-a", challenge: "ch", status: "pending",
  presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
  verifierResult: null, verifiedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z", ...over,
});

const fold = (over: Partial<Parameters<typeof computeIdentityDashboard>[0]> = {}) =>
  computeIdentityDashboard({
    useCases: [uc("uc-a")], credentials: [], verifications: [],
    holderLabels: new Map(), now: NOW, days: 30, ...over,
  });

describe("derivedCredentialStatus", () => {
  it("rejected wins over revoked (ID-L reject revokes on-chain first)", () => {
    expect(derivedCredentialStatus({ revoked: true, expiresAt: null, acceptance: "rejected" }, NOW)).toBe("rejected");
  });
  it("revoked wins over expired", () => {
    expect(derivedCredentialStatus({ revoked: true, expiresAt: "2020-01-01T00:00:00.000Z", acceptance: "accepted" }, NOW)).toBe("revoked");
  });
  it("expired wins over acceptance", () => {
    expect(derivedCredentialStatus({ revoked: false, expiresAt: "2020-01-01T00:00:00.000Z", acceptance: "pending" }, NOW)).toBe("expired");
  });
  it("otherwise the acceptance state", () => {
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "pending" }, NOW)).toBe("pending");
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "changes_requested" }, NOW)).toBe("changes_requested");
    expect(derivedCredentialStatus({ revoked: false, expiresAt: null, acceptance: "accepted" }, NOW)).toBe("accepted");
  });
});

describe("computeIdentityDashboard", () => {
  it("totals partition issued across the six states", () => {
    const d = fold({ credentials: [
      cred("c1"),
      cred("c2", { acceptance: "pending" }),
      cred("c3", { acceptance: "changes_requested" }),
      cred("c4", { acceptance: "rejected", revoked: true }),
      cred("c5", { revoked: true }),
      cred("c6", { expiresAt: "2026-01-01T00:00:00.000Z" }),
    ] });
    expect(d.totals).toEqual({ issued: 6, accepted: 1, pendingAcceptance: 1, changesRequested: 1, rejectedByHolder: 1, revoked: 1, expired: 1 });
    const sum = d.totals.accepted + d.totals.pendingAcceptance + d.totals.changesRequested
      + d.totals.rejectedByHolder + d.totals.revoked + d.totals.expired;
    expect(sum).toBe(d.totals.issued);
  });

  it("drops credentials outside the scoped use cases (incl. null-key catalog credentials)", () => {
    const d = fold({ credentials: [cred("c1"), cred("c2", { credentialUseCaseKey: null }), cred("c3", { credentialUseCaseKey: "other" })] });
    expect(d.totals.issued).toBe(1);
  });

  it("byUseCase seeds every configured type at zero and buckets per type", () => {
    const d = fold({
      useCases: [uc("uc-a", ["ScoreCredential", "BadgeCredential"])],
      credentials: [cred("c1"), cred("c2", { acceptance: "pending" })],
    });
    expect(d.byUseCase).toHaveLength(1);
    const types = Object.fromEntries(d.byUseCase[0]!.byType.map((t) => [t.type, t.counts]));
    expect(types.ScoreCredential!.issued).toBe(2);
    expect(types.BadgeCredential!.issued).toBe(0);
  });

  it("board: newest first, capped at 200, boardTotal uncapped, labels resolved with DID fallback", () => {
    const creds = Array.from({ length: 205 }, (_, i) =>
      cred(`c${i}`, { issuedAt: `2026-07-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` }));
    // c179 has the highest (seconds, millis) sort key = (59, 179): guaranteed on the
    // board (in fact newest). The 200-cap drops the 5 oldest: c0, c60, c120, c180, c1.
    const c179 = creds.find((c) => c.id === "c179")!;
    const labels = new Map([[c179.holderDid, "holder179@x.dev"]]);
    const d = fold({ credentials: creds, holderLabels: labels });
    expect(d.board).toHaveLength(200);
    expect(d.boardTotal).toBe(205);
    expect(d.board[0]!.issuedAt >= d.board[199]!.issuedAt).toBe(true);
    expect(d.board[0]!.credentialId).toBe("c179");
    expect(d.board[0]!.holderLabel).toBe("holder179@x.dev");
    const unlabeled = d.board.find((r) => r.credentialId !== "c179");
    expect(unlabeled!.holderLabel).toContain("…"); // truncated DID fallback
  });

  it("board rows carry the changes-requested note, and only then", () => {
    const d = fold({ credentials: [
      cred("c1", { acceptance: "changes_requested", acceptanceNote: "fix the name" }),
      cred("c2", { acceptance: "accepted", acceptanceNote: "stale note" }),
    ] });
    const byId = Object.fromEntries(d.board.map((r) => [r.credentialId, r]));
    expect(byId.c1!.acceptanceNote).toBe("fix the name");
    expect(byId.c2!.acceptanceNote).toBeNull();
  });

  it("activity buckets issuance per UTC day over the window", () => {
    const d = fold({ credentials: [
      cred("c1", { issuedAt: "2026-08-05T23:59:00.000Z" }),
      cred("c2", { issuedAt: "2026-08-05T01:00:00.000Z" }),
      cred("c3", { issuedAt: "2026-08-06T00:01:00.000Z" }),
      cred("c4", { issuedAt: "2026-06-01T00:00:00.000Z" }), // outside window: not bucketed
    ] });
    expect(d.activity).toHaveLength(30);
    expect(d.activity[d.activity.length - 1]).toEqual({ date: "2026-08-06", issued: 1 });
    expect(d.activity[d.activity.length - 2]).toEqual({ date: "2026-08-05", issued: 2 });
    expect(d.activity[0]!.date).toBe("2026-07-08");
  });

  it("verification: consented splits into verifiedValid/verifiedInvalid by stored result", () => {
    const d = fold({ verifications: [
      vreq("v1"),
      vreq("v2", { status: "consented" }),
      vreq("v3", { status: "consented", verifierResult: { valid: true } }),
      vreq("v4", { status: "consented", verifierResult: { valid: false } }),
      vreq("v5", { status: "rejected" }),
      vreq("v6", { status: "expired" }),
      vreq("v7", { credentialUseCaseKey: null }), // catalog request: excluded
      vreq("v8", { expiresAt: "2020-01-01T00:00:00.000Z" }), // stale pending: derived expired (lazy flip never ran)
    ] });
    expect(d.verification).toEqual({ pending: 1, consented: 1, rejected: 1, expired: 2, verifiedValid: 1, verifiedInvalid: 1 });
  });

  it("a credential of a type no longer in the config still buckets (renamed-type branch)", () => {
    const d = fold({ credentials: [cred("c1", { type: "LegacyCredential" })] });
    expect(d.totals.issued).toBe(1);
    const types = Object.fromEntries(d.byUseCase[0]!.byType.map((t) => [t.type, t.counts]));
    expect(types.LegacyCredential!.issued).toBe(1);
    expect(types.ScoreCredential!.issued).toBe(0); // configured type still seeded
  });

  it("empty use-case scope yields all-zero/empty output", () => {
    const d = fold({ useCases: [], credentials: [cred("c1")], verifications: [vreq("v1")] });
    expect(d.totals.issued).toBe(0);
    expect(d.byUseCase).toEqual([]);
    expect(d.board).toEqual([]);
    expect(d.boardTotal).toBe(0);
    expect(d.activity).toHaveLength(30);
    expect(d.activity.every((a) => a.issued === 0)).toBe(true);
    expect(d.verification).toEqual({ pending: 0, consented: 0, rejected: 0, expired: 0, verifiedValid: 0, verifiedInvalid: 0 });
  });
});
