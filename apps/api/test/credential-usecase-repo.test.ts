import { describe, expect, it } from "vitest";
import type { CredentialUseCaseDefinition } from "@tokenlayer/core";
import { MemoryCredentialUseCaseRepository } from "../src/persistence/memory/index.js";

const def: CredentialUseCaseDefinition = {
  key: "kyc-onboarding", name: "KYC Onboarding",
  credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365,
    claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
  issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
};

describe("MemoryCredentialUseCaseRepository", () => {
  it("creates, reads, lists, updates, and reports existence", async () => {
    const repo = new MemoryCredentialUseCaseRepository();
    expect(await repo.has("kyc-onboarding")).toBe(false);
    const created = await repo.create(def);
    expect(created.key).toBe("kyc-onboarding");
    expect((await repo.get("kyc-onboarding"))?.name).toBe("KYC Onboarding");
    expect(await repo.has("kyc-onboarding")).toBe(true);
    expect(await repo.list()).toHaveLength(1);
    const updated = await repo.update("kyc-onboarding", { ...def, name: "KYC v2" });
    expect(updated.name).toBe("KYC v2");
    expect((await repo.get("kyc-onboarding"))?.name).toBe("KYC v2");
    expect(await repo.get("missing")).toBeNull();
  });
});
