import { describe, expect, it } from "vitest";
import { createMemoryQrLoginStore } from "../src/qr-login-sessions.js";

describe("qr-login store", () => {
  it("start → authenticate → consume (once)", () => {
    const s = createMemoryQrLoginStore();
    const sess = s.start();
    expect(sess.status).toBe("pending");
    expect(s.authenticate(sess.id, { userId: "u1", token: "jwt" })).toBe(true);
    const c = s.consume(sess.id);
    expect(c?.token).toBe("jwt");
    expect(s.consume(sess.id)).toBeNull(); // only once
    expect(s.get(sess.id)?.status).toBe("consumed");
  });
  it("expires past TTL and cannot authenticate", () => {
    let t = 0; const s = createMemoryQrLoginStore(1000, () => t);
    const sess = s.start();
    t = 2000;
    expect(s.get(sess.id)?.status).toBe("expired");
    expect(s.authenticate(sess.id, { userId: "u1", token: "j" })).toBe(false);
  });
});
