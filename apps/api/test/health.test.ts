import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos } from "./helpers.js";

describe("GET /health", () => {
  it("200s once the process is up", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /ready", () => {
  it("200s once the DB (or in-memory store) answers", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
  });

  it("503s when the readiness check throws", async () => {
    const h = await buildTestAppWithRepos();
    h.deps.users.findByEmail = async () => {
      throw new Error("db unreachable");
    };
    const res = await h.app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /metrics", () => {
  it("is open when METRICS_TOKEN is unset", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("401s without a matching bearer token when METRICS_TOKEN is set", async () => {
    const h = await buildTestAppWithRepos({ metricsToken: "secret-token" });
    const open = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(open.statusCode).toBe(401);
    const wrong = await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const right = await h.app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer secret-token" } });
    expect(right.statusCode).toBe(200);
  });
});
