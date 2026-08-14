/**
 * THE CONFIG AND THE CATALOGUE MUST DECIDE THE SAME WAY.
 *
 * `personaAllows` is the model. The generated nginx is what actually runs, and
 * it is evaluated by ANOTHER program's rules — nginx tries regex locations in
 * order and stops at the first match rather than the best one. A generator can
 * therefore be faithful line by line and still produce a config that disagrees
 * with the model, which is the worst outcome available here: the tests would be
 * green and the container would refuse an investor's purchase.
 *
 * So this file does not check that the generator emitted the lines someone
 * expected. It SIMULATES nginx's matching over every route in the real API
 * surface, for every method, for all six personas, and asserts the answer equals
 * `personaAllows`. Roughly 3,000 comparisons, and the interesting ones are the
 * shadowing pairs — `/assets` under `/assets/:id/buy`, `/me` under
 * `/me/login-keys` — which no hand-written case list would reliably contain.
 *
 * It also pins the committed files: regenerating must produce no diff, so the
 * config cannot be hand-edited into agreement with nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAS, personaAllows } from "@tokenlayer/core";
import { edgeDecision, generateAll, OUT_DIR, toRegex } from "../../../scripts/gen-persona-edges.js";
import { buildTestApp } from "./helpers.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** A route pattern as a concrete URL the edge would actually see. */
const toUrl = (pattern: string): string =>
  "/api/v1" + pattern.split("/").map((s) => (s.startsWith(":") ? "PARAM" : s)).join("/");

async function surfacePatterns(): Promise<string[]> {
  const app = await buildTestApp({ enabledDomains: ["tokenization", "identity"] });
  try {
    await app.ready();
    const spec = app.swagger() as { paths?: Record<string, unknown> };
    return Object.keys(spec.paths ?? {}).map((p) =>
      p.replace(/^\/api\/v1/, "").replace(/\{([^}]+)\}/g, ":$1") || "/");
  } finally {
    await app.close();
  }
}

describe("the generated edge configs are the catalogue, compiled", () => {
  it("regenerating produces no diff — the committed files cannot be hand-edited", () => {
    for (const [name, body] of generateAll()) {
      const onDisk = readFileSync(resolve(OUT_DIR, name), "utf8");
      expect(onDisk, `deploy/persona-edges/${name} is stale — run: pnpm gen:persona-edges`).toBe(body);
    }
  });

  it("emits one config per persona, each naming its own upstream", () => {
    const files = generateAll();
    expect(files.size).toBe(6);
    for (const persona of PERSONAS) {
      const body = files.get(`${persona.key}.conf`);
      expect(body).toBeDefined();
      expect(body).toContain(`set $upstream_api http://${persona.domain}-api:4000;`);
      // The other product's API must not appear anywhere in the file.
      const other = persona.domain === "identity" ? "tokenization" : "identity";
      expect(body).not.toContain(`http://${other}-api:4000`);
    }
  });

  it("every config ends in a default deny", () => {
    // Without this the whole design inverts: an unlisted route would be proxied.
    for (const [, body] of generateAll()) {
      expect(body).toMatch(/location \/ \{[\s\S]*?return 404/);
      expect(body).toContain("PERSONA_ROUTE_NOT_ALLOWED");
    }
  });
});

describe("nginx's decision equals personaAllows, route for route", () => {
  it("agrees on the entire API surface × every method × every persona", async () => {
    const patterns = await surfacePatterns();
    expect(patterns.length).toBeGreaterThan(60);   // not a vacuous pass

    const disagreements: string[] = [];
    for (const persona of PERSONAS) {
      for (const pattern of patterns) {
        for (const method of METHODS) {
          const model = personaAllows(persona, method, pattern);
          const edge = edgeDecision(persona, method, toUrl(pattern)) === "allow";
          if (model !== edge) {
            disagreements.push(`${persona.key}: ${method} ${pattern} — model=${model ? "allow" : "deny"} edge=${edge ? "allow" : "deny"}`);
          }
        }
      }
    }
    expect(
      disagreements,
      `the generated nginx would decide differently from the catalogue:\n  ${disagreements.slice(0, 25).join("\n  ")}`,
    ).toEqual([]);
  }, 60_000);

  it("specifically: the marketplace can POST a buy that sits under a GET-only rule", async () => {
    // The shadowing case that motivated emitting personaMethodsFor rather than
    // each rule's own methods. Named here so a regression reads as itself rather
    // than as one line in a list of three thousand.
    const market = PERSONAS.find((p) => p.key === "tokenization-marketplace")!;
    expect(edgeDecision(market, "POST", "/api/v1/assets/abc/buy")).toBe("allow");
    expect(edgeDecision(market, "GET", "/api/v1/assets/abc")).toBe("allow");
    expect(edgeDecision(market, "POST", "/api/v1/assets")).toBe("deny");
  });

  it("specifically: a wallet's /me does not become /me/portfolio at the edge either", () => {
    const holder = PERSONAS.find((p) => p.key === "identity-holder")!;
    expect(edgeDecision(holder, "GET", "/api/v1/me")).toBe("allow");
    expect(edgeDecision(holder, "GET", "/api/v1/me/credentials")).toBe("allow");
    expect(edgeDecision(holder, "GET", "/api/v1/me/portfolio")).toBe("deny");
    expect(edgeDecision(holder, "POST", "/api/v1/orgs/o1/users")).toBe("deny");
  });
});

describe("the regex conversion", () => {
  it("turns params into one segment, and anchors exact rules", () => {
    expect(toRegex("/orgs/:id/members", false)).toBe("^/api/v1/orgs/[^/]+/members(/|$)");
    expect(toRegex("/me", true)).toBe("^/api/v1/me$");
  });

  it("escapes a literal dot so certificate.pdf is not a wildcard", () => {
    // `certificate.pdf` unescaped would also match `certificateXpdf`.
    const rx = toRegex("/credentials/:id/certificate.pdf", false);
    expect(rx).toContain("certificate\\.pdf");
    expect(new RegExp(rx).test("/api/v1/credentials/c1/certificateXpdf")).toBe(false);
    expect(new RegExp(rx).test("/api/v1/credentials/c1/certificate.pdf")).toBe(true);
  });

  it("a prefix rule stops at a segment boundary", () => {
    const rx = toRegex("/credentials", false);
    expect(new RegExp(rx).test("/api/v1/credentials/abc")).toBe(true);
    expect(new RegExp(rx).test("/api/v1/credential-types")).toBe(false);
  });
});
