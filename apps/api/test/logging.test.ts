import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos } from "./helpers.js";

describe("structured logging", () => {
  it("redacts sensitive fields logged via app.log, and leaves non-sensitive fields intact", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const h = await buildTestAppWithRepos({ logStream: sink });
    h.app.log.info({ email: "alice@example.com", assetName: "Gold Bar #12" }, "test log line");
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "test log line");
    expect(logged.email).toBe("[Redacted]");
    expect(logged.assetName).toBe("Gold Bar #12");
  });

  // Task 6 shipped with a live bug: Fastify's OWN automatic request/response
  // logging (not a manual app.log.info call) passes real FastifyRequest/
  // FastifyReply instances through formatters.log before pino's serializers
  // ever see them. Those instances expose method/url/statusCode etc. as
  // prototype getters, which redactSensitiveFields's Object.entries()-based
  // walk cannot see — it silently rebuilds them as `{}`, and pino's
  // serializers then run on that already-emptied object instead of the real
  // request/reply. The manual-log test above never caught this because a
  // plain object literal survives an Object.entries() walk regardless of
  // serializer timing; only a REAL app.inject() request exercises the path
  // that actually breaks.
  it("preserves real method/url/statusCode on Fastify's own request/response auto-logging", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const h = await buildTestAppWithRepos({ logStream: sink });
    await h.app.inject({ method: "GET", url: "/health" });

    const logged = lines.map((l) => JSON.parse(l));
    const incoming = logged.find((l) => l.msg === "incoming request");
    const completed = logged.find((l) => l.msg === "request completed");

    expect(incoming.req).toBeDefined();
    expect(incoming.req.method).toBe("GET");
    expect(incoming.req.url).toBe("/health");

    expect(completed.res).toBeDefined();
    expect(completed.res.statusCode).toBe(200);
  });
});
