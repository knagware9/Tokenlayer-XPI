/**
 * EN-D1 (task D1-6): the API reference, rendered from the live OpenAPI document.
 *
 * GENERATED, NEVER TRANSCRIBED. Every fact on this page is read out of
 * `/openapi.json` at load time, so it cannot drift from the API the way a
 * hand-written page would. That is not hypothetical here: for three
 * sub-projects the document itself claimed all 121 routes wanted a human JWT
 * while the server had been accepting org API keys the whole time. Tasks
 * D1-1…D1-5 fixed the document against the `authScoped(...)` gate that actually
 * runs; this page's job is to surface that work without adding a second copy of
 * it that can rot.
 *
 * The one thing the page adds on top of the document is the CREDENTIAL LINE —
 * "which credential may call this, with which scope" — which is the question
 * integrators actually arrive with, and which OpenAPI has no field for on a
 * bearer scheme. It comes from `lib/openapi.ts`, which is unit-tested, rather
 * than from anything in this file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../api.js";
import { useAuth } from "../auth.js";
import {
  type OpenApiDocument,
  type OpenApiParameter,
  type RouteEntry,
  type TagGroup,
  apiOrigin,
  bodySchema,
  credentialInfo,
  credentialLine,
  curlFor,
  describeShape,
  fillPath,
  groupByTag,
  mutatingGetReason,
  openapiUrl,
  resolveRef,
  responseMediaTypes,
  tryItAllowed,
  withQuery,
} from "../lib/openapi.js";
import { Card, CopyBlock, EmptyState, Pill, Skeleton } from "./ui.js";

const METHOD_TONE: Record<string, string> = {
  get: "bg-sky-100 text-sky-700",
  post: "bg-emerald-100 text-emerald-700",
  put: "bg-amber-100 text-amber-700",
  patch: "bg-amber-100 text-amber-700",
  delete: "bg-red-100 text-red-700",
};

export function ApiReference(): JSX.Element {
  const { token } = useAuth();
  const [doc, setDoc] = useState<OpenApiDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [openTag, setOpenTag] = useState<string | null>(null);
  // Bumped by the retry button; the effect keys off it so a retry is a real
  // refetch rather than a re-render of the same failed state.
  const [attempt, setAttempt] = useState(0);
  const loadGen = useRef(0);

  useEffect(() => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    // The document is gated behind `principal` in production (apps/api/src/app.ts)
    // — it enumerates every route, field name and error code, which is a recon
    // aid unauthenticated and the product an integrator was sold otherwise. So
    // the session token goes with the request; outside production the route is
    // open and the header is simply ignored.
    fetch(openapiUrl(API_BASE), { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The API answered ${res.status} ${res.statusText || ""}`.trim());
        return (await res.json()) as OpenApiDocument;
      })
      .then((json) => {
        if (loadGen.current !== gen) return;
        setDoc(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (loadGen.current !== gen) return;
        // NEVER a blank pane. A reference that fails silently is
        // indistinguishable from an API with no routes.
        setError(err instanceof Error ? err.message : "The request failed before it reached the API.");
        setLoading(false);
      });
    return () => { loadGen.current++; };
  }, [token, attempt]);

  const groups = useMemo(() => (doc ? groupByTag(doc.paths, doc.tags) : []), [doc]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((g) => ({
        ...g,
        routes: g.routes.filter((r) =>
          r.path.toLowerCase().includes(needle) ||
          r.method.includes(needle) ||
          (r.op.summary ?? "").toLowerCase().includes(needle) ||
          g.name.toLowerCase().includes(needle)),
      }))
      .filter((g) => g.routes.length > 0);
  }, [groups, filter]);

  if (loading) {
    return <Card><Skeleton lines={8} /></Card>;
  }

  if (error) {
    return (
      <Card title="The API reference could not be loaded">
        <p className="text-sm text-slate-600">{error}</p>
        <p className="text-xs text-slate-500 mt-2">
          The document is served by the API itself at <span className="font-mono">{openapiUrl(API_BASE) || "/openapi.json"}</span>, and
          in production it requires a signed-in session — a <span className="font-mono">401</span> here usually means the session
          expired, and a network error usually means the API is not reachable from this browser.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="mt-4 rounded-lg border border-slate-300 text-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
        >
          Try again
        </button>
      </Card>
    );
  }

  if (!doc || groups.length === 0) {
    return (
      <Card>
        <EmptyState icon="code" title="The document declares no routes" hint="This is the API's own OpenAPI document — an empty one means the API served an empty document, not that the reference failed." />
      </Card>
    );
  }

  const baseUrl = documentBaseUrl(doc);
  const total = groups.reduce((n, g) => n + g.routes.length, 0);

  return (
    <div className="space-y-4">
      <Card
        title={doc.info?.title ?? "API reference"}
        description={`Version ${doc.info?.version ?? "—"} · ${total} operations across ${groups.length} groups · generated from this deployment's own OpenAPI document.`}
      >
        <div className="space-y-3">
          <div className="text-xs text-slate-500">
            Base URL <span className="font-mono text-slate-700">{baseUrl || "(same origin)"}</span>. Both credentials travel in the
            same header: <span className="font-mono">Authorization: Bearer …</span> — a human session JWT from{" "}
            <span className="font-mono">POST /auth/login</span>, or an opaque organization key (<span className="font-mono">tl_live_…</span>).
          </div>
          <input
            className="input"
            placeholder="Filter by path, method, summary or group…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter.trim() !== "" && shown.length === 0 && (
            <p className="text-sm text-slate-500">Nothing matches “{filter.trim()}”.</p>
          )}
        </div>
      </Card>

      {shown.map((group) => (
        <TagSection
          key={group.name}
          group={group}
          doc={doc}
          baseUrl={baseUrl}
          // A filter is a search: expand what it found rather than making the
          // reader open every group to see whether the hit is in there.
          forceOpen={filter.trim() !== ""}
          open={openTag === group.name}
          onToggle={() => setOpenTag((cur) => (cur === group.name ? null : group.name))}
        />
      ))}
    </div>
  );
}

/**
 * The base URL to show and to call.
 *
 * `servers[0].url` is the deployment's own public answer (EN-D1 added it — before
 * that every generated client and every "Try it" was guessing), so it wins for
 * DISPLAY. But it can name a host this browser cannot reach, so anything
 * executed goes to the origin the console already talks to.
 */
function documentBaseUrl(doc: OpenApiDocument): string {
  const declared = doc.servers?.[0]?.url?.trim();
  return declared && declared !== "/" ? declared.replace(/\/+$/, "") : apiOrigin(API_BASE);
}

function TagSection({ group, doc, baseUrl, open, forceOpen, onToggle }: {
  group: TagGroup;
  doc: OpenApiDocument;
  baseUrl: string;
  open: boolean;
  forceOpen: boolean;
  onToggle: () => void;
}): JSX.Element {
  const expanded = open || forceOpen;
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-4 px-5 py-3.5 text-left hover:bg-slate-50"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{group.name}</h3>
          {group.description
            ? <p className="text-xs text-slate-500 mt-0.5">{group.description}</p>
            : (
              // "Other" is the bin for an operation whose tag the document does
              // not describe. Saying so is better than an unexplained heading.
              <p className="text-xs text-slate-400 mt-0.5 italic">
                No description in the document for this group.
              </p>
            )}
        </div>
        <span className="shrink-0 text-xs text-slate-500 pt-0.5">{group.routes.length} · {expanded ? "hide" : "show"}</span>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 divide-y divide-slate-100">
          {group.routes.map((route) => (
            <Route key={`${route.method} ${route.path}`} route={route} doc={doc} baseUrl={baseUrl} />
          ))}
        </div>
      )}
    </div>
  );
}

function Route({ route, doc, baseUrl }: { route: RouteEntry; doc: OpenApiDocument; baseUrl: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { method, path, op } = route;
  const cred = credentialInfo(op);

  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-start gap-3 px-5 py-3 text-left hover:bg-slate-50">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${METHOD_TONE[method] ?? "bg-slate-100 text-slate-700"}`}>
          {method}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-slate-800 break-all">{path}</span>
          {op.summary && <span className="block text-xs text-slate-500 mt-0.5">{op.summary}</span>}
        </span>
        <span className="shrink-0 flex items-center gap-1.5">
          {cred.kind === "public"
            ? <Pill tone="muted">public</Pill>
            : cred.kind === "session"
              ? <Pill tone="warn">session only</Pill>
              : <Pill tone="info">{cred.scope ?? "API key"}</Pill>}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <CredentialNote route={route} />
          {op.description && <Prose text={op.description} />}
          <Parameters params={op.parameters} doc={doc} />
          <RequestBody route={route} doc={doc} />
          <Responses route={route} doc={doc} />
          {/* `tryItAllowed`, never `canTryIt`: the method alone does not answer
              this. One GET on this API consumes a verification request and
              notifies every registered webhook endpoint. */}
          {tryItAllowed(route)
            ? <TryIt route={route} />
            : <NoTryIt route={route} doc={doc} baseUrl={baseUrl} />}
        </div>
      )}
    </div>
  );
}

/** The credential line, given the most prominent position in the panel — it is
 * the question integrators actually have, and the one the document used to get
 * wrong for every route on the API. */
function CredentialNote({ route }: { route: RouteEntry }): JSX.Element {
  const { kind, scope } = credentialInfo(route.op);
  const tone = kind === "public"
    ? "border-slate-200 bg-slate-50"
    : kind === "session"
      ? "border-amber-200 bg-amber-50"
      : "border-sky-200 bg-sky-50";
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Credential</div>
      <p className="text-sm text-slate-800 mt-0.5">{credentialLine(route.op)}</p>
      {scope && (
        <p className="text-xs text-slate-500 mt-1">
          A key without <span className="font-mono">{scope}</span> is refused{" "}
          <span className="font-mono">403 INSUFFICIENT_SCOPE</span>. A scope only ever narrows the bound service user — it can
          never grant authority that user's role and its organization's capability envelope do not already allow.
        </p>
      )}
    </div>
  );
}

function Parameters({ params, doc }: { params: readonly OpenApiParameter[] | undefined; doc: OpenApiDocument }): JSX.Element | null {
  const rows = (params ?? []).filter((p) => p && typeof p.name === "string");
  if (rows.length === 0) return null;
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Parameters</h4>
      <table className="w-full text-xs">
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.in}:${p.name}`} className="align-top border-t border-slate-100 first:border-t-0">
              <td className="py-1.5 pr-3 font-mono text-slate-800 whitespace-nowrap">{p.name}</td>
              <td className="py-1.5 pr-3 text-slate-500 whitespace-nowrap">{p.in}{p.required ? " · required" : ""}</td>
              <td className="py-1.5 pr-3 font-mono text-slate-500">{describeShape(p.schema, doc)}</td>
              <td className="py-1.5 text-slate-500">{p.description ?? p.schema?.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RequestBody({ route, doc }: { route: RouteEntry; doc: OpenApiDocument }): JSX.Element | null {
  const schema = resolveRef(bodySchema(route.op.requestBody), doc);
  if (!schema) return null;
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = Object.keys(props);
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
        Request body{route.op.requestBody?.required ? " · required" : ""}
      </h4>
      {names.length === 0 ? (
        <p className="text-xs font-mono text-slate-600">{describeShape(schema, doc)}</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {names.map((name) => (
              <tr key={name} className="align-top border-t border-slate-100 first:border-t-0">
                <td className="py-1.5 pr-3 font-mono text-slate-800 whitespace-nowrap">{name}</td>
                <td className="py-1.5 pr-3 text-slate-500 whitespace-nowrap">{required.has(name) ? "required" : "optional"}</td>
                <td className="py-1.5 pr-3 font-mono text-slate-500">{describeShape(props[name], doc)}</td>
                <td className="py-1.5 text-slate-500">{resolveRef(props[name], doc)?.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Responses({ route, doc }: { route: RouteEntry; doc: OpenApiDocument }): JSX.Element | null {
  const entries = Object.entries(route.op.responses ?? {});
  if (entries.length === 0) return null;
  // Two routes in this document list ONLY failures — `GET /credentials/{id}/certificate.pdf`
  // (404) and `GET /documents/{id}` (401, 404). Both really do succeed; both
  // stream a binary body their route schema never described, so @fastify/swagger
  // had no 2xx to emit. Rendering that table unannotated tells the reader the
  // route always fails, which is worse than admitting the document is thin here.
  const documentsSuccess = entries.some(([status]) => status.startsWith("2") || status === "default");
  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Responses</h4>
      <table className="w-full text-xs">
        <tbody>
          {entries.map(([status, response]) => {
            const media = responseMediaTypes(response);
            const json = response?.content?.["application/json"]?.schema;
            return (
              <tr key={status} className="align-top border-t border-slate-100 first:border-t-0">
                <td className="py-1.5 pr-3 font-mono font-semibold text-slate-800 whitespace-nowrap">{status}</td>
                <td className="py-1.5 pr-3 font-mono text-slate-600 break-all">
                  {/* A response can be non-JSON — the certificate route returns a
                      PDF — so name the media type rather than rendering "—" and
                      leaving the reader to guess it returns nothing. */}
                  {json ? describeShape(json, doc) : media.length > 0 ? media.join(", ") : "no body"}
                </td>
                <td className="py-1.5 text-slate-500">
                  {/* @fastify/swagger writes "Default Response" when a route's
                      schema names no description. It is noise, not information. */}
                  {response?.description === "Default Response" ? "" : response?.description ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!documentsSuccess && (
        <p className="text-[11px] text-amber-700 mt-1.5">
          This route&rsquo;s schema documents only failures — no success response. That is a thin spot in the API&rsquo;s own
          document, not a route that always fails: it happens where a handler streams a body OpenAPI never saw described (a PDF
          certificate, an uploaded document). Expect a <span className="font-mono">200</span> carrying that body.
        </p>
      )}
    </section>
  );
}

/**
 * Execute a GET with the signed-in session and show what actually came back.
 *
 * INCLUDING THE REFUSALS. A real `403 ORG_CAPABILITY_MISSING`, with
 * `details.missing` naming the domain or role, teaches an integrator more in one
 * click than any amount of prose about capability envelopes — and it is the
 * error they are most likely to hit and least likely to have anticipated. So
 * nothing here pre-checks permissions or disables the button: the API's own
 * answer is the lesson.
 */
function TryIt({ route }: { route: RouteEntry }): JSX.Element {
  const { token } = useAuth();
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ status: number; statusText: string; body: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const params = route.op.parameters ?? [];
  const pathParams = params.filter((p) => p.in === "path");
  const queryParams = params.filter((p) => p.in === "query");

  const run = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const filled = fillPath(route.path, pathValues);
      if (filled.missing.length > 0) {
        // Refuse rather than send `/assets//holders`, which is a different route
        // and 404s for a reason the reader cannot see.
        setFailure(`Fill in ${filled.missing.join(", ")} first — a blank path parameter would call a different route.`);
        return;
      }
      const url = `${apiOrigin(API_BASE)}${withQuery(filled.url, queryValues)}`;
      const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const contentType = res.headers.get("content-type") ?? "";
      // Not every GET here answers with text. `GET /credentials/{id}/certificate.pdf`
      // streams a PDF; dumping its bytes into a <pre> would fill the panel with
      // mojibake and hide the status line, which is the part that teaches. Name
      // the body instead.
      if (contentType !== "" && !/json|text|xml|javascript/i.test(contentType)) {
        const blob = await res.blob();
        setResult({ status: res.status, statusText: res.statusText, body: `(${blob.size} bytes of ${contentType} — a binary body, not shown)` });
        return;
      }
      const text = await res.text();
      let body = text;
      try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON — show it raw */ }
      setResult({ status: res.status, statusText: res.statusText, body: body.length > 20000 ? `${body.slice(0, 20000)}\n… truncated` : body });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "The request failed before it reached the API.");
    } finally {
      setBusy(false);
    }
  }, [route.path, pathValues, queryValues, token]);

  const tone = !result ? "" : result.status < 300 ? "text-emerald-700" : result.status < 500 ? "text-amber-700" : "text-red-700";

  /**
   * The URL this button will ACTUALLY call.
   *
   * Built from the same expression `run` uses, deliberately. The panel header
   * above prints `documentBaseUrl(doc)` — the `servers[0].url` the deployment
   * declares — and the button sends to `apiOrigin(API_BASE)`, the origin this
   * browser build was pointed at. They agree in every normal deployment, and
   * when they do not (a document declaring a public gateway while the console
   * talks to an internal host, say) the reader would otherwise be told one
   * thing and shown the answer from another. Showing the real target costs a
   * line and removes the ambiguity.
   */
  const target = useMemo(
    () => `${apiOrigin(API_BASE) || "(same origin)"}${withQuery(fillPath(route.path, pathValues).url, queryValues)}`,
    [route.path, pathValues, queryValues],
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Try it</h4>
        <span className="text-[11px] text-slate-500">Runs as you, with your signed-in session — not with an API key.</span>
      </div>

      <div className="text-[11px] text-slate-500">
        Sends <span className="font-mono text-slate-700">GET {target}</span>
      </div>

      {(pathParams.length > 0 || queryParams.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {pathParams.map((p) => (
            <label key={`path-${p.name}`} className="block">
              <span className="block text-[11px] text-slate-500 mb-0.5">{p.name} <span className="text-slate-400">(path)</span></span>
              <input
                className="input"
                value={pathValues[p.name] ?? ""}
                onChange={(e) => setPathValues((cur) => ({ ...cur, [p.name]: e.target.value }))}
              />
            </label>
          ))}
          {queryParams.map((p) => (
            <label key={`query-${p.name}`} className="block">
              <span className="block text-[11px] text-slate-500 mb-0.5">
                {p.name} <span className="text-slate-400">(query{p.required ? ", required" : ""})</span>
              </span>
              <input
                className="input"
                value={queryValues[p.name] ?? ""}
                onChange={(e) => setQueryValues((cur) => ({ ...cur, [p.name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-brand-700 disabled:opacity-40"
      >
        {busy ? "Sending…" : `Send ${route.method.toUpperCase()}`}
      </button>

      {failure && <p className="text-xs text-red-600">{failure}</p>}

      {result && (
        <div className="space-y-1.5">
          <div className={`text-xs font-semibold ${tone}`}>
            {result.status} {result.statusText}
            {result.status === 403 && (
              <span className="font-normal text-slate-500">
                {" "}— a real refusal. <span className="font-mono">ORG_CAPABILITY_MISSING</span> means this organization&rsquo;s
                envelope does not cover the call; <span className="font-mono">INSUFFICIENT_SCOPE</span> means a key was missing a
                scope. <span className="font-mono">details</span> below names which.
              </span>
            )}
          </div>
          <CopyBlock code={result.body || "(empty body)"} />
        </div>
      )}
    </section>
  );
}

/**
 * What every route with no button gets instead, and the honest reason.
 *
 * Naming the reason matters more than the curl does. An absent affordance with
 * no explanation reads as an unfinished page; an absent affordance with a
 * stated reason reads as a decision — and the decision here is real: a
 * documentation page must not be able to issue a credential or move tokens
 * against live data with the reader's own session, and on this API most
 * mutations answer `202` into a maker-checker queue a human then has to clear.
 *
 * A GET can land here too, and when it does the generic sentence would be a
 * LIE — the reader can see it is a GET. So a mutating GET states its own,
 * specific reason from `MUTATING_GET_PATHS` instead.
 */
function NoTryIt({ route, doc, baseUrl }: { route: RouteEntry; doc: OpenApiDocument; baseUrl: string }): JSX.Element {
  const cred = credentialInfo(route.op);
  const mutatingGet = mutatingGetReason(route.path);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Run it yourself</h4>
        <span className="text-[11px] text-slate-500">{route.method.toUpperCase()} — copy and run in your own shell</span>
      </div>
      <CopyBlock code={curlFor(route, baseUrl, doc)} language="bash" />
      {mutatingGet ? (
        <p className="text-xs text-amber-700">
          <span className="font-semibold">This GET is not read-only.</span> {mutatingGet} So it gets no button here even though
          its method would normally earn one — run it when you mean to, against a request you intend to consume.
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          Interactive calls are read-only here: a documentation page should not issue a credential or move tokens against live
          data, and most mutations on this API answer <span className="font-mono">202</span> with a proposal into a real
          maker-checker queue that a second person then has to clear. Sandbox keys — a test mode where a mutation is safe to try —
          arrive with EN-D2; until then this snippet is deliberately something you run deliberately.
        </p>
      )}
      {cred.kind !== "public" && (
        <p className="text-xs text-slate-500">
          Set <span className="font-mono">{cred.kind === "session" ? "TL_SESSION" : "TL_API_KEY"}</span> first
          {cred.kind === "session"
            ? <> — this route takes a human session token from <span className="font-mono">POST /auth/login</span>, not an organization key.</>
            : <> — an organization key from the API keys tab, with the <span className="font-mono">{cred.scope ?? "required"}</span> scope.</>}
        </p>
      )}
    </section>
  );
}

/**
 * Descriptions in this document are markdown-lite: backticked code, `**bold**`
 * and blank-line paragraphs. Rendering them raw would show the asterisks; this
 * handles exactly the three constructs the API's schemas actually use.
 */
function Prose({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-sm text-slate-600 space-y-1.5">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>{inlineMarkdown(para.replace(/\n/g, " "))}</p>
      ))}
    </div>
  );
}

/** Backticks → `<code>`, `**…**` → bold. Shared with Guides.tsx's renderer in
 * spirit but not in code: this one only ever sees a one-paragraph description. */
function inlineMarkdown(text: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out.push(<span key={key++} className="font-mono text-[0.9em] text-slate-800 bg-slate-100 rounded px-1">{match[1]}</span>);
    } else {
      out.push(<strong key={key++} className="font-semibold text-slate-800">{match[2]}</strong>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
