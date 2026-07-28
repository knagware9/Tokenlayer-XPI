import { describe, expect, it } from "vitest";
import { sign as edSign } from "node:crypto";
import { generateDidKey } from "@tokenlayer/core";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

const b64u = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signChallenge = (privateKey: import("node:crypto").KeyObject, sessionId: string, challenge: string): string =>
  b64u(edSign(null, Buffer.from(`qr-login:${sessionId}:${challenge}`, "utf8"), privateKey));

describe("passwordless QR login", () => {
  it("enrol → start → authenticate → poll yields a working token", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    // enrol
    const enrol = await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "Test device" } });
    expect(enrol.statusCode).toBe(201);
    // start (public)
    const start = await app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    expect(start.statusCode).toBe(200);
    const { sessionId, challenge, qrSvg, signUrl } = start.json();
    expect(qrSvg).toContain("<svg");
    expect(signUrl).toContain("/qr-sign?session=");
    // authenticate (public, signed)
    const authn = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, challenge) } });
    expect(authn.statusCode).toBe(200);
    // poll → token, once
    const poll = await app.inject({ method: "GET", url: `${V1}/auth/qr/${sessionId}` });
    expect(poll.json().status).toBe("authenticated");
    const token = poll.json().token as string;
    expect(token).toBeTruthy();
    const poll2 = await app.inject({ method: "GET", url: `${V1}/auth/qr/${sessionId}` });
    expect(poll2.json().status).toBe("consumed");
    expect(poll2.json().token ?? null).toBeNull();
    // the token authenticates
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(me.statusCode).toBe(200);
  });

  it("rejects a bad signature, an unknown did, and a revoked key", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    const enrol = await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "d" } });
    const keyId = enrol.json().id as string;
    const start = await app.inject({ method: "POST", url: `${V1}/auth/qr/start` });
    const { sessionId, challenge } = start.json();
    // bad signature (wrong message)
    const bad = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, "wrong") } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("BAD_SIGNATURE");
    // unknown did
    const other = generateDidKey();
    const unk = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: other.did, signature: signChallenge(other.privateKey, sessionId, challenge) } });
    expect(unk.statusCode).toBe(401);
    expect(unk.json().error).toBe("UNKNOWN_KEY");
    // revoke then try the real one
    expect((await app.inject({ method: "DELETE", url: `${V1}/me/login-keys/${keyId}`, headers: auth(admin) })).statusCode).toBe(204);
    const revoked = await app.inject({ method: "POST", url: `${V1}/auth/qr/${sessionId}/authenticate`, payload: { did: key.did, signature: signChallenge(key.privateKey, sessionId, challenge) } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error).toBe("UNKNOWN_KEY");
  });

  it("enrol rejects a malformed did (400) and a duplicate (409); lists + is caller-scoped", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = generateDidKey();
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: "nope", label: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "x" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${V1}/me/login-keys`, headers: auth(admin), payload: { did: key.did, label: "x" } })).statusCode).toBe(409);
    const list = await app.inject({ method: "GET", url: `${V1}/me/login-keys`, headers: auth(admin) });
    expect((list.json() as unknown[]).length).toBe(1);
  });
});
