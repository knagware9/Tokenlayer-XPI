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
});
