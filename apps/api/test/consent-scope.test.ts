import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, V1, type TestAppHandle } from "./helpers.js";

/**
 * `POST /verification-requests/:id/consent` is a DISCLOSURE, and it used to be
 * gated by `credentials:read`.
 *
 * What the route actually does: decrypt the holder's custodial signing key,
 * sign a Verifiable Presentation AS them, and release the selected credentials'
 * contents to a third-party verifier. None of that can be recalled. So a key
 * minted for a dashboard, an expiry sweep or a reconciliation job — all of
 * which legitimately want `credentials:read` — could speak for the holder and
 * hand their KYC to whoever had raised a request.
 *
 * `credentials:present` is its own scope for that reason, and it is separate
 * from `credentials:issue` too: issuing speaks for the ISSUER, presenting
 * speaks for the HOLDER, and neither should arrive as a side effect of asking
 * for the other.
 *
 * THE SCOPE GATE RUNS IN `preHandler`, so these assertions are about the gate
 * and nothing downstream: the request id is deliberately one that does not
 * exist. A key without the scope is stopped with `INSUFFICIENT_SCOPE` before
 * the handler runs; a key WITH it gets past the gate and meets the route's own
 * 404. That difference — not a bare status code — is what proves the scope is
 * the thing being enforced.
 */
describe("consent is gated by credentials:present, not credentials:read", () => {
  const TEST_ROUNDS = 4;

  async function keyWith(h: TestAppHandle, scopes: string[]): Promise<string> {
    const tag = Math.random().toString(36).slice(2, 10);
    const svc = await h.users.create({
      email: `svc-consent-${tag}@tokenlayer.dev`,
      passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
      role: "PlatformAdmin", useCaseKey: null, accountId: null, active: true,
      kycStatus: "approved", kyc: null, kind: "service",
    });
    const minted = await mintSecret(TEST_ROUNDS);
    await h.apiKeys.create({
      orgId: null, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix,
      secretHash: minted.hash, scopes, expiresAt: null, createdBy: "test",
    });
    return minted.secret;
  }

  const consent = (h: TestAppHandle, secret: string) => h.app.inject({
    method: "POST", url: `${V1}/verification-requests/vreq_does_not_exist/consent`,
    headers: auth(secret), payload: { credentialIds: ["cred_1"] },
  });

  it("a key holding only credentials:read is refused, and told which scope it needs", async () => {
    const h = await buildTestAppWithRepos();
    const readOnly = await keyWith(h, ["credentials:read"]);

    const denied = await consent(h, readOnly);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      error: "INSUFFICIENT_SCOPE",
      details: { required: "credentials:present" },
    });

    // AND THE READ SCOPE STILL READS. The tightening must not have turned
    // `credentials:read` into a scope that does nothing — that would be a
    // different bug wearing this fix's clothes.
    const read = await h.app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(readOnly) });
    expect(read.statusCode).toBe(200);
  });

  it("issuing is not presenting: credentials:issue does not carry it either", async () => {
    const h = await buildTestAppWithRepos();
    const issuer = await keyWith(h, ["credentials:issue", "credentials:revoke", "verifications:read"]);

    const denied = await consent(h, issuer);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "credentials:present" } });
  });

  it("a key holding credentials:present clears the gate", async () => {
    const h = await buildTestAppWithRepos();
    const presenter = await keyWith(h, ["credentials:present"]);

    const past = await consent(h, presenter);
    // Past the scope gate and into the handler, which cannot find the request.
    expect(past.statusCode).toBe(404);
    expect(past.json().error).not.toBe("INSUFFICIENT_SCOPE");
  });

  it("the wildcards still cover it — `credentials:*` and `*`", async () => {
    // A grant that was working before this change must keep working: the scope
    // is new, so nobody could have been granted it explicitly, and a wildcard
    // holder losing consent would be a silent break for existing integrations.
    const h = await buildTestAppWithRepos();
    for (const scopes of [["credentials:*"], ["*"]]) {
      const secret = await keyWith(h, scopes);
      const past = await consent(h, secret);
      expect(past.statusCode, scopes[0]).toBe(404);
    }
  });
});
