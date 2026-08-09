/**
 * Unit cover for the pure half of the developer portal's Reference tab (EN-D1,
 * task D1-6).
 *
 * apps/web has no DOM test environment — on the same terms as
 * developers-key-lifecycle.test.ts and webhooks-panel.test.ts, rendering is
 * verified in the browser and what is asserted here is the logic the render
 * delegates to. That is not a limitation for this surface: the three things the
 * reference can get WRONG rather than merely ugly are all pure functions.
 *
 *  1. Executing the wrong thing from a documentation page.
 *  2. Telling an integrator the wrong credential, or the right credential and
 *     no scope.
 *  3. Losing a route.
 *
 * The credential assertions are EXACT STRING EQUALITY, not `toContain`, and
 * deliberately so. A `toContain("API key")` check passes against the
 * human-session sentence too — it says "an organization API key is refused
 * here" — so a `credentialLine` that ignored `apiKeyAuth` entirely would sail
 * through a substring test while telling every machine integrator that machine
 * access does not exist. That is the exact falsehood the pre-EN-D1 document
 * shipped, and it is what this file exists to prevent recurring.
 */
import { describe, expect, it } from "vitest";
import {
  UNTAGGED_GROUP,
  apiOrigin,
  canTryIt,
  credentialInfo,
  credentialLine,
  curlFor,
  describeShape,
  extractScope,
  fillPath,
  groupByTag,
  openapiUrl,
  resolveRef,
  securitySchemesOf,
  withQuery,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiPaths,
} from "../src/lib/openapi.js";

/** A key-callable route, shaped exactly as @fastify/swagger emits it: both
 * schemes as separate alternatives, empty scope arrays, and the scope stated in
 * prose. Copied from the real `GET /api/v1/accounts`. */
const BOTH_CREDENTIALS: OpenApiOperation = {
  summary: "List demo accounts",
  tags: ["Catalog"],
  description: "Requires the `assets:read` scope. The settlement accounts within the caller's scope.",
  security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
};

/** A human-only route: one alternative, no scope prose. Copied from `GET /api/v1/me`. */
const SESSION_ONLY: OpenApiOperation = {
  summary: "Current session principal",
  tags: ["Auth"],
  description: "The caller's own principal, self-describing enough to drive a UI.",
  security: [{ bearerAuth: [] }],
};

/** A public route. The generator omits `security` entirely rather than emitting
 * `[]`; both must read as public. Copied from `POST /api/v1/auth/login`. */
const PUBLIC: OpenApiOperation = { summary: "Authenticate and obtain a JWT", tags: ["Auth"] };

describe("canTryIt", () => {
  it("is true for get", () => {
    expect(canTryIt("get")).toBe(true);
  });

  it("is case-insensitive about get", () => {
    // A document, a route table and a UI each spell the method differently and
    // none of them may change the answer.
    expect(canTryIt("GET")).toBe(true);
    expect(canTryIt(" Get ")).toBe(true);
  });

  it.each(["post", "patch", "put", "delete"])("is false for %s", (method) => {
    // The point of the restriction: a documentation page must not be able to
    // mint a credential, onboard a user or move tokens against live data — and
    // on this API most mutations return 202 into a real approval queue, so a
    // "try" would leave a proposal behind for a human to deal with.
    expect(canTryIt(method)).toBe(false);
  });

  it("is false for every non-get method, upper-cased too", () => {
    // Guards the mutation "canTryIt returns true for post": a case-only check
    // above would still fail, but this pins the whole method vocabulary so no
    // single method can be quietly re-admitted.
    for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS", "TRACE", ""]) {
      expect(canTryIt(method)).toBe(false);
    }
  });
});

describe("securitySchemesOf", () => {
  it("flattens every alternative", () => {
    expect(securitySchemesOf(BOTH_CREDENTIALS)).toEqual(["bearerAuth", "apiKeyAuth"]);
    expect(securitySchemesOf(SESSION_ONLY)).toEqual(["bearerAuth"]);
    expect(securitySchemesOf(PUBLIC)).toEqual([]);
  });
});

describe("extractScope", () => {
  it("reads the scope out of the stated sentence", () => {
    expect(extractScope("Requires the `assets:read` scope. Something else.")).toBe("assets:read");
  });

  it("reads a scope from a sentence that carries a role clause too", () => {
    // A real description: "Requires the `assets:transfer` scope **and** an
    // Issuer or admin role."
    expect(extractScope("Requires the `assets:transfer` scope **and** an Issuer or admin role.")).toBe("assets:transfer");
  });

  it("falls back to any scope-shaped token when the sentence is reworded", () => {
    expect(extractScope("This route needs `webhooks:write` on the key.")).toBe("webhooks:write");
  });

  it("returns null rather than guessing when there is no scope to find", () => {
    expect(extractScope("The caller's own principal.")).toBeNull();
    expect(extractScope(undefined)).toBeNull();
  });
});

describe("credentialLine", () => {
  it("names the API key AND the scope when both credentials are accepted", () => {
    // THE mutation guard. If credentialLine ignored `apiKeyAuth`, this
    // operation would fall through to the session-only sentence and this exact
    // comparison fails — where a substring check for "API key" would not,
    // because the session-only sentence mentions the API key to refuse it.
    expect(credentialLine(BOTH_CREDENTIALS)).toBe(
      "Callable with an organization API key holding the assets:read scope, or with a signed-in user session.",
    );
    // And the scope specifically: "you can use a key" without "which scope"
    // only moves the integrator's question along to a 403 they cannot act on.
    expect(credentialLine(BOTH_CREDENTIALS)).toContain("assets:read");
    expect(credentialInfo(BOTH_CREDENTIALS)).toEqual({ kind: "both", scope: "assets:read" });
  });

  it("says human session only when bearerAuth is the only scheme", () => {
    expect(credentialLine(SESSION_ONLY)).toBe(
      "Callable with a signed-in user session only — an organization API key is refused here.",
    );
    expect(credentialInfo(SESSION_ONLY)).toEqual({ kind: "session", scope: null });
  });

  it("says public when security is absent", () => {
    expect(credentialLine(PUBLIC)).toBe("Public — no credential required.");
    expect(credentialInfo(PUBLIC)).toEqual({ kind: "public", scope: null });
  });

  it("says public when security is an explicit empty array", () => {
    // The generator omits the key; a hand-written schema may write `[]`. This
    // document declares no document-level default, so the two coincide — and
    // reading `[]` as "needs something" would put a credential requirement on a
    // route that has none.
    expect(credentialLine({ ...PUBLIC, security: [] })).toBe("Public — no credential required.");
  });

  it("degrades honestly when a key-callable route does not state its scope", () => {
    const reworded: OpenApiOperation = { ...BOTH_CREDENTIALS, description: "Lists the things." };
    expect(credentialLine(reworded)).toBe(
      "Callable with an organization API key with the required scope, or with a signed-in user session.",
    );
    // Still says a key may call it — the missing scope must not silently
    // downgrade the route to human-only.
    expect(credentialInfo(reworded).kind).toBe("both");
  });

  it("handles a key-only route", () => {
    const keyOnly: OpenApiOperation = { ...BOTH_CREDENTIALS, security: [{ apiKeyAuth: [] }] };
    expect(credentialLine(keyOnly)).toBe(
      "Callable with an organization API key holding the assets:read scope. A user session cannot call this route.",
    );
  });

  it("gives each credential case a distinct sentence", () => {
    // Three cases, three answers. If any two collapsed to the same string the
    // portal would be telling two different audiences the same thing, and one
    // of them would be wrong.
    const lines = [credentialLine(BOTH_CREDENTIALS), credentialLine(SESSION_ONLY), credentialLine(PUBLIC)];
    expect(new Set(lines).size).toBe(3);
  });
});

describe("groupByTag", () => {
  const paths: OpenApiPaths = {
    "/api/v1/assets": { get: { tags: ["Assets"], summary: "List assets" }, post: { tags: ["Assets"], summary: "Issue an asset" } },
    "/api/v1/webhooks": { get: { tags: ["Webhooks"], summary: "List endpoints" } },
  };

  it("never drops an untagged operation", () => {
    // A reference that silently omits a route is worse than one that renders it
    // awkwardly: the reader has no way to know the gap exists. All three shapes
    // of "no tag" that a document can produce land in one place.
    const withUntagged: OpenApiPaths = {
      ...paths,
      "/api/v1/orphan": { get: { summary: "No tags key at all" } },
      "/api/v1/empty": { post: { tags: [], summary: "Empty tags array" } },
      "/api/v1/blank": { patch: { tags: ["  "], summary: "Blank tag" } },
    };
    const groups = groupByTag(withUntagged, [{ name: "Assets" }, { name: "Webhooks" }]);

    const other = groups.find((g) => g.name === UNTAGGED_GROUP);
    expect(other).toBeDefined();
    expect(other?.routes.map((r) => r.path).sort()).toEqual(["/api/v1/blank", "/api/v1/empty", "/api/v1/orphan"]);

    // And the count is conserved end to end — the strongest form of "nothing
    // was dropped", because it fails for a route lost from ANY group, not only
    // from "Other".
    const total = groups.reduce((n, g) => n + g.routes.length, 0);
    expect(total).toBe(6);
    // "Other" sorts last: it is the leftovers bin, not a headline group.
    expect(groups[groups.length - 1]?.name).toBe(UNTAGGED_GROUP);
  });

  it("follows the document's declared tag order, not alphabetical order", () => {
    // apps/api/src/http/openapi.ts orders its 23 tags editorially — the machine
    // integration surface first, then administration, then reference data.
    // Sorting alphabetically here would throw that away and open the reference
    // on "Analytics".
    const declared = [{ name: "Webhooks" }, { name: "Assets" }];
    const groups = groupByTag(paths, declared);
    expect(groups.map((g) => g.name)).toEqual(["Webhooks", "Assets"]);
    // Explicitly NOT alphabetical, and explicitly not path-encounter order
    // either (Assets appears first in `paths`).
    expect(groups.map((g) => g.name)).not.toEqual(["Assets", "Webhooks"]);
  });

  it("keeps a tag used by a route but never declared", () => {
    const groups = groupByTag(
      { ...paths, "/api/v1/mystery": { get: { tags: ["Mystery"], summary: "Undeclared tag" } } },
      [{ name: "Assets" }, { name: "Webhooks" }],
    );
    expect(groups.map((g) => g.name)).toEqual(["Assets", "Webhooks", "Mystery"]);
  });

  it("skips path-item keys that are not operations", () => {
    // `parameters`, `summary` and `$ref` are legal on a path item and are not
    // routes. Rendering them as operations would invent endpoints.
    const groups = groupByTag(
      { "/api/v1/assets/{id}": { parameters: [{ name: "id", in: "path" }], summary: "shared", get: { tags: ["Assets"] } } },
      [{ name: "Assets" }],
    );
    expect(groups.reduce((n, g) => n + g.routes.length, 0)).toBe(1);
    expect(groups[0]?.routes[0]?.method).toBe("get");
  });

  it("drops a declared tag no route uses, and carries the declared description", () => {
    const groups = groupByTag(paths, [
      { name: "Assets", description: "Tokenized asset issuance." },
      { name: "Unused", description: "Nothing points here." },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Assets", "Webhooks"]);
    expect(groups[0]?.description).toBe("Tokenized asset issuance.");
  });

  it("tolerates a document with no paths", () => {
    expect(groupByTag(undefined, [{ name: "Assets" }])).toEqual([]);
  });
});

describe("openapiUrl / apiOrigin", () => {
  it("puts the document at the API root, not under the version prefix", () => {
    // The docs plugin is registered at the app's root in apps/api/src/app.ts —
    // the document is a sibling of the versioned API, not a child of it.
    expect(openapiUrl("http://localhost:4000/api/v1")).toBe("http://localhost:4000/openapi.json");
  });

  it("works in same-origin dev mode, where API_BASE is a bare path", () => {
    expect(openapiUrl("/api/v1")).toBe("/openapi.json");
    expect(apiOrigin("/api/v1")).toBe("");
  });

  it("preserves a deeper mount point", () => {
    expect(apiOrigin("https://host/xi/api/v1")).toBe("https://host/xi");
  });
});

describe("fillPath", () => {
  it("substitutes path parameters", () => {
    expect(fillPath("/api/v1/assets/{id}/holders", { id: "asset-1" })).toEqual({ url: "/api/v1/assets/asset-1/holders", missing: [] });
  });

  it("leaves a blank parameter as its placeholder and reports it missing", () => {
    // Replacing it with "" makes `/assets//holders`, a different route that
    // usually 404s — a refusal the reader cannot explain teaches nothing.
    expect(fillPath("/api/v1/assets/{id}/holders", { id: "  " })).toEqual({ url: "/api/v1/assets/{id}/holders", missing: ["id"] });
    expect(fillPath("/api/v1/assets/{id}", {})).toEqual({ url: "/api/v1/assets/{id}", missing: ["id"] });
  });

  it("encodes a value that would otherwise change the path", () => {
    expect(fillPath("/api/v1/dids/{did}/resolve", { did: "did:key:z6Mk" }).url).toBe("/api/v1/dids/did%3Akey%3Az6Mk/resolve");
  });
});

describe("withQuery", () => {
  it("drops blank values", () => {
    expect(withQuery("/api/v1/assets", { limit: "10", offset: "  " })).toBe("/api/v1/assets?limit=10");
  });

  it("returns the url untouched when nothing was filled in", () => {
    expect(withQuery("/api/v1/assets", { limit: "" })).toBe("/api/v1/assets");
  });
});

describe("describeShape / resolveRef", () => {
  const doc: OpenApiDocument = {
    components: {
      schemas: {
        "def-0": { type: "object", properties: { error: { type: "string" }, code: { type: "string" } }, required: ["error"] },
        "def-loop": { type: "object", properties: { next: { $ref: "#/components/schemas/def-loop" } } },
      },
    },
  };

  it("resolves a $ref into its real shape", () => {
    // The document's components are named `def-0` … `def-28` — @fastify/swagger
    // generates them from anonymous inline schemas, so the name carries no
    // information and showing it to an integrator is worse than showing nothing.
    expect(describeShape({ $ref: "#/components/schemas/def-0" }, doc)).toBe("{error, code}");
    expect(resolveRef({ $ref: "#/components/schemas/def-0" }, doc)?.type).toBe("object");
  });

  it("stops on a recursive $ref rather than hanging", () => {
    expect(resolveRef({ $ref: "#/components/schemas/def-loop" }, doc)?.properties?.next).toBeDefined();
    expect(describeShape({ $ref: "#/components/schemas/def-loop" }, doc)).toBe("{next}");
  });

  it("marks array-valued fields and renders arrays of objects", () => {
    const schema = { type: "array", items: { type: "object", properties: { id: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } } };
    expect(describeShape(schema, doc)).toBe("[{id, scopes[]}]");
  });

  it("renders an enum as its alternatives", () => {
    expect(describeShape({ type: "string", enum: ["tokenization", "identity"] }, doc)).toBe('"tokenization" | "identity"');
  });

  it("returns a dash for an unresolvable ref rather than rendering the def name", () => {
    expect(describeShape({ $ref: "#/components/schemas/def-nope" }, doc)).toBe("—");
  });
});

describe("curlFor", () => {
  const doc: OpenApiDocument = { components: { schemas: {} } };

  it("uses an API key for a key-callable route and a session token otherwise", () => {
    // Getting this backwards hands an integrator a snippet that 403s with no
    // clue why.
    const keyCall = curlFor({ path: "/api/v1/accounts", method: "get", op: BOTH_CREDENTIALS }, "https://host", doc);
    expect(keyCall).toContain("$TL_API_KEY");
    const humanCall = curlFor({ path: "/api/v1/me", method: "get", op: SESSION_ONLY }, "https://host", doc);
    expect(humanCall).toContain("$TL_SESSION");
  });

  it("sends no authorization header for a public route", () => {
    const line = curlFor({ path: "/api/v1/auth/login", method: "post", op: PUBLIC }, "https://host", doc);
    expect(line).not.toContain("authorization");
    expect(line).toContain("curl -sS -X POST 'https://host/api/v1/auth/login'");
  });

  it("builds a body skeleton from the required properties", () => {
    const op: OpenApiOperation = {
      ...BOTH_CREDENTIALS,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "quantity"],
              properties: { name: { type: "string" }, quantity: { type: "integer" }, memo: { type: "string" } },
            },
          },
        },
      },
    };
    const line = curlFor({ path: "/api/v1/assets", method: "post", op }, "https://host", doc);
    expect(line).toContain(`-d '{"name":"…","quantity":0}'`);
    // Optional fields are left out: a skeleton an integrator can paste and run
    // beats one they must first prune.
    expect(line).not.toContain("memo");
  });
});
