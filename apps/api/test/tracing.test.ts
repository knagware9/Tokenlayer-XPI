import { describe, expect, it, beforeEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withSpan } from "../src/shared/tracing.js";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

describe("withSpan", () => {
  beforeEach(() => exporter.reset());

  it("creates a span with the given name and attributes, and returns fn's result", async () => {
    const result = await withSpan("test.op", { "proposal.kind": "onboard-user" }, async () => "ok");
    expect(result).toBe("ok");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("test.op");
    expect(spans[0]!.attributes["proposal.kind"]).toBe("onboard-user");
  });

  it("records the exception and still rethrows on failure", async () => {
    const boom = new Error("fail");
    await expect(withSpan("test.op.fail", {}, async () => { throw boom; })).rejects.toBe(boom);
    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});

describe("review-decision span", () => {
  beforeEach(() => exporter.reset());

  it("opens a span named review-decision with proposal.kind and decision attributes", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const carbonAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const issue = await h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(platform),
      payload: { useCaseKey: "carbon-credit", name: "T", symbol: "T", chainId: "fabric", metadata: { projectName: "P", registry: "Verra", vintage: 2024 } },
    });
    const assetId = issue.json().asset.id as string;
    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/diligence/documents`, headers: auth(platform),
      payload: { slot: "prospectus", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 x").toString("base64") },
    });
    await h.app.inject({ method: "POST", url: `${V1}/assets/${assetId}/submit-for-review`, headers: auth(platform) });

    await h.app.inject({
      method: "POST", url: `${V1}/assets/${assetId}/review-decision`, headers: auth(carbonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });

    const span = exporter.getFinishedSpans().find((s) => s.name === "review-decision");
    expect(span).toBeDefined();
    expect(span!.attributes["proposal.kind"]).toBe("asset-review-decision");
    expect(span!.attributes.decision).toBe("approved");
  });
});

describe("proposal execution span", () => {
  beforeEach(() => exporter.reset());

  it("opens a proposal.execute span labeled with the proposal's kind for onboard-user", async () => {
    const h = await buildTestAppWithRepos();
    const carbon = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const propose = await h.app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(carbon),
      payload: {
        email: "new.user@example.com", password: "secret1", role: "Buyer",
        walletAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", kyc: { legalName: "New User", country: "IN" },
      },
    });
    const proposalId = propose.json().proposal.id as string;
    await h.app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin), payload: {} });

    const span = exporter.getFinishedSpans().find((s) => s.name === "proposal.execute");
    expect(span).toBeDefined();
    expect(span!.attributes["proposal.kind"]).toBe("onboard-user");
  });
});
