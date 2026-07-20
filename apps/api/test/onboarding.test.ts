import { describe, expect, it } from "vitest";
import { buildTestApp, V1, loginAs } from "./helpers.js";
import { PLATFORM_ORG_NAME } from "../src/platform-org.js";

describe("platform issuer org", () => {
  it("is seeded at boot: verifier type, verified, has a did:key", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: { authorization: `Bearer ${platform}` } });
    const org = (res.json() as Array<{ name: string; orgType: string; verified: boolean; did: string }>).find((o) => o.name === PLATFORM_ORG_NAME);
    expect(org).toBeDefined();
    expect(org!.orgType).toBe("verifier");
    expect(org!.verified).toBe(true);
    expect(org!.did.startsWith("did:key:z")).toBe(true);
  });
});
