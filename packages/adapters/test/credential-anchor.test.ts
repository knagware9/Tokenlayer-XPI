import { describe, expect, it } from "vitest";
import { supportsCredentialAnchor } from "../src/credential-anchor.js";

describe("supportsCredentialAnchor", () => {
  it("is false for an adapter without the capability", () => {
    expect(supportsCredentialAnchor({ chainId: "fabric", family: "fabric" } as never)).toBe(false);
  });

  it("is true only when every registry method is present", () => {
    const partial = { chainId: "besu", family: "evm", anchorCredential: () => {} };
    expect(supportsCredentialAnchor(partial as never)).toBe(false);
    const full = {
      chainId: "besu",
      family: "evm",
      deployRegistries: () => {},
      registerDid: () => {},
      deactivateDid: () => {},
      didRegistration: () => {},
      anchorCredential: () => {},
      revokeCredential: () => {},
      credentialStatusOf: () => {},
    };
    expect(supportsCredentialAnchor(full as never)).toBe(true);
  });
});
