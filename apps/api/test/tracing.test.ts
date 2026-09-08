import { describe, expect, it, beforeEach } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { withSpan } from "../src/shared/tracing.js";

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
