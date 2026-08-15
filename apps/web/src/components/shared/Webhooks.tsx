import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { orgDomainEnabled } from "../../lib/shared/capabilities.js";
import { modeBlurb, modeLabel, modeTone, type ResourceMode } from "../../lib/shared/modes.js";
import { setNavGuard } from "../../lib/shared/nav-guard.js";
import {
  EVENT_DESCRIPTIONS,
  EVENT_TYPES,
  type EventType,
  type OrgCapabilities,
  type Organization,
  type Role,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "../../types.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

/** The header every delivery carries: `t=<unix>,v1=<hex>`. */
const SIGNATURE_HEADER = "Tokenlayer-Signature";

/**
 * Which product domain an event type belongs to — a MIRROR of the server's
 * `eventTypeDomain` (apps/api/src/http/routes.ts), which is what actually gates
 * a subscription with 403 ORG_CAPABILITY_MISSING. `null` means domain-neutral:
 * `proposal.executed` is maker-checker governance, which both domains use.
 *
 * Mirroring rather than sharing is the same trade `API_SCOPES` and `EVENT_TYPES`
 * already make (the web app has no dependency on core). The failure mode of a
 * stale copy here is a type offered that the server then refuses with a clear
 * 403 — never a subscription that should have been refused and was not, because
 * the server re-checks the whole subscription at create AND at update.
 */
function eventTypeDomain(t: string): "tokenization" | "identity" | null {
  if (t.startsWith("asset.")) return "tokenization";
  if (t.startsWith("credential.") || t.startsWith("verification.")) return "identity";
  return null;
}

/**
 * The event types this organization may actually subscribe to.
 *
 * `capabilities === null` is the UNRESTRICTED LEGACY envelope (the org predates
 * EN-A), not "no capabilities" — it offers everything, exactly as
 * `orgDomainEnabled` treats it.
 *
 * THE ANSWER DOES NOT DEPEND ON THE CALLER'S ROLE, and `role` is taken only so
 * that stays visible at every call site. There used to be a PlatformAdmin
 * bypass here, justified by "the server does not apply the envelope to them
 * either" — which is false for THIS resource. The member-add routes do exempt a
 * PlatformAdmin (routes.ts, POST /users and POST /orgs/:id/users); the webhook
 * create and update routes call `subscriptionOutsideEnvelope(org, eventTypes)`
 * unconditionally, on the TARGET org's envelope, whoever is asking. So the
 * bypass offered a platform operator ticks the server would refuse.
 *
 * That is worse than untidy, and it is the exact harm the filter exists to
 * prevent: the create call fails the WHOLE subscription with one 403, so a
 * single out-of-envelope tick loses the operator every other choice they made
 * in the form. DO NOT reintroduce a branch on `role` without first changing the
 * server to match.
 */
export function subscribableEventTypes(capabilities: OrgCapabilities | null, role: Role | null | undefined): EventType[] {
  void role;
  return EVENT_TYPES.filter((t) => {
    const domain = eventTypeDomain(t);
    return domain === null || orgDomainEnabled(capabilities, domain);
  });
}

/** What the create form has collected so far. */
export interface WebhookDraft {
  url: string;
  description: string;
  eventTypes: readonly EventType[];
  /** "" means "every use case in this org", which is also the server's `null`. */
  useCaseKey: string;
  /**
   * Which stream to join (EN-D2). Not on `checkWebhookDraft`'s ok arm and
   * deliberately so: unlike a url or an event list there is no draft state that
   * fails validation — both values are always valid and one is always chosen —
   * so it travels beside the check like `description` does, rather than
   * pretending to be something the check narrows.
   */
  mode: ResourceMode;
}

/**
 * The starting draft — subscribed to NOTHING.
 *
 * The tempting default is "all of them" (or "everything this org is entitled
 * to"), and it is the wrong one: an operator who pastes a URL and submits
 * without reading the list would point their handler at every credential,
 * asset and governance fact the organization produces, including classes of
 * event their integration has no code for. Under-subscribing is a missing
 * delivery the operator goes looking for; over-subscribing is a firehose at a
 * URL that was only ever meant to hear about one thing. The choice is required.
 */
/**
 * …and starting in the LIVE stream, which is the one place in this form a
 * default is right. It is the server's own default, it is the pre-EN-D2
 * behaviour of every endpoint that already exists, and — unlike the role on a
 * key or the event list here — neither value is the privileged one: a `test`
 * endpoint hears strictly less. What matters is that the choice is VISIBLE, so
 * an operator registering a sandbox listener cannot do it without seeing which
 * stream they picked.
 */
export const EMPTY_WEBHOOK_DRAFT: WebhookDraft = { url: "", description: "", eventTypes: [], useCaseKey: "", mode: "live" };

/**
 * Everything the draft must satisfy before it is worth sending. A discriminated
 * union rather than a message-or-null, so the `ok` arm CARRIES the validated
 * values — an incomplete draft has no `url`/`eventTypes` to hand the create call
 * and therefore cannot reach it.
 */
export type WebhookDraftCheck =
  | { ok: true; url: string; eventTypes: EventType[] }
  | { ok: false; message: string };

export function checkWebhookDraft(draft: WebhookDraft): WebhookDraftCheck {
  const url = draft.url.trim();
  if (!url) return { ok: false, message: "Enter the URL TokenLayer should POST to" };
  // A LOCAL PRE-CHECK, not the authority. The server runs the real guard — it
  // resolves the host and refuses anything that lands on a private or loopback
  // address (400 INVALID_WEBHOOK_URL), which no browser can do. What this
  // catches is the one mistake that is obvious without a round trip: a scheme
  // that is not https. Saying so here is faster and explains better than a 400
  // whose text is about resolution. (A local API in dev mode may accept plain
  // http on loopback; this console does not offer that, because a URL typed
  // here is meant for a real integration.)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "That is not a full URL — it must start with https:// and include a host" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "Webhook URLs must use https:// — signed payloads are never sent over plain HTTP" };
  }
  if (draft.eventTypes.length === 0) {
    return { ok: false, message: "Choose at least one event type — an endpoint subscribed to nothing is never delivered anything" };
  }
  return { ok: true, url, eventTypes: [...draft.eventTypes] };
}

/**
 * May this delivery be replayed?
 *
 * Only a SETTLED FAILURE. `inflight` means a dispatcher has already claimed the
 * row and is mid-POST: the server answers 409 DELIVERY_INFLIGHT, and it is right
 * to — resetting a claimed row would let a second worker claim it while the
 * first is still sending, which is a double delivery. `pending` is already
 * queued and will be attempted on the next poll, so replaying it would only
 * reset its attempt budget for no reason, and `delivered` already succeeded —
 * replaying it sends the integrator a duplicate they did not ask for.
 */
export function canRetry(status: WebhookDelivery["status"]): boolean {
  return status === "failed" || status === "dead";
}

/**
 * May a test ping be sent to this endpoint? Not to a disabled one: the
 * dispatcher settles a delivery to a non-active endpoint as `dead` WITHOUT
 * sending, so the server answers 409 ENDPOINT_DISABLED rather than reporting
 * success for something guaranteed not to happen. Re-enable first.
 */
export function canSendTest(status: WebhookEndpoint["status"]): boolean {
  return status === "active";
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString();
}

/**
 * Which stream an endpoint (and therefore every delivery to it) belongs to.
 *
 * ABSENT MEANS LIVE. The server sends `mode` and declares it `required` on the
 * `WebhookEndpoint` schema, so this default only covers a row from an older API
 * build — but a blank pill on a row that decides whether a payload is real is
 * worse than a default that matches the column's own.
 */
function endpointMode(e: Pick<WebhookEndpoint, "mode">): ResourceMode {
  return e.mode ?? "live";
}

function deliveryTone(status: WebhookDelivery["status"]): "ok" | "warn" | "danger" | "info" | "muted" {
  switch (status) {
    case "delivered": return "ok";
    case "failed": return "warn";
    case "dead": return "danger";
    case "inflight": return "info";
    default: return "muted";
  }
}

/**
 * The Webhooks surface: an organization's delivery destinations.
 *
 * THIS PANEL IS THE ONLY PLACE AN AUTO-DISABLE IS EVER ANNOUNCED. When an
 * endpoint fails persistently the platform switches it off, and there is
 * deliberately no `webhook.endpoint.disabled` event — the only channel that
 * could carry it is the endpoint that was just switched off, so the notification
 * would be delivered exactly when it cannot be. Nothing else tells the
 * organization. That is why a disabled endpoint is rendered as a banner with its
 * reason, its timestamp and a Re-enable button, and never as a grey pill in a
 * table cell that a reader's eye slides past.
 *
 * SECRET HYGIENE — same invariant as Developers.tsx above it. A signing secret
 * is returned exactly once (create and rotate), lives in the `revealed` state
 * and NOWHERE ELSE: no localStorage, no sessionStorage, no URL, no console, no
 * ref that outlives the panel. No read route returns it again, so dismissing it
 * or navigating away is a permanent discard — hence the acknowledgement
 * checkbox and the nav guard.
 */
export function Webhooks({ orgId, org }: { orgId: string | null; org: Organization | null }): JSX.Element {
  const { token, user } = useAuth();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  // `seq` keys the reveal panel: a second reveal (rotating while an earlier
  // panel is still open) must mount a FRESH panel, or it inherits the previous
  // one's ticked acknowledgement and is dismissable in a single click.
  const [revealed, setRevealed] = useState<{ url: string; secret: string; rotated: boolean; seq: number } | null>(null);
  const reveal = (url: string, secret: string, rotated: boolean): void =>
    setRevealed((cur) => ({ url, secret, rotated, seq: (cur?.seq ?? 0) + 1 }));

  /**
   * Generation-guarded, for the same reason the key list is: a PlatformAdmin can
   * switch orgs while a list is still in flight, and the counter (rather than a
   * per-effect flag) also invalidates the imperative reloads fired after create,
   * rotate, delete, test and re-enable.
   */
  const loadGen = useRef(0);
  const reload = (): void => {
    const gen = ++loadGen.current;
    if (!token || !orgId) { setEndpoints([]); return; }
    api.listWebhooks(token, orgId)
      .then((rows) => { if (loadGen.current === gen) setEndpoints(rows); })
      .catch((err) => { if (loadGen.current === gen) setError(errMessage(err, "Failed to load webhook endpoints")); });
  };
  useEffect(() => {
    setCreating(false);
    setOpenDeliveries(null);
    setNotice(null);
    reload();
    return () => { loadGen.current++; };
  }, [token, orgId]);

  /**
   * Leaving with an unacknowledged secret destroys it, so both exits are gated:
   * the console's own sidebar (the shared nav guard, which App.tsx consults
   * before swapping panels) and the browser's reload/close.
   */
  useEffect(() => {
    if (!revealed) return;
    const warn = (): boolean => window.confirm(
      "You have not acknowledged the new webhook signing secret. It is shown only once and cannot be retrieved — leaving this page loses it, and the only way back is to rotate (which invalidates the one you just minted). Leave anyway?",
    );
    const release = setNavGuard(warn);
    const onBeforeUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { release(); window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [revealed]);

  const disabled = endpoints.filter((e) => e.status === "disabled");

  async function act(id: string, run: () => Promise<void>): Promise<void> {
    setBusyId(id); setError(null); setNotice(null);
    try {
      await run();
    } catch (err) {
      setError(errMessage(err, "The request failed"));
    } finally {
      setBusyId(null);
    }
  }

  const rotate = (e: WebhookEndpoint): Promise<void> => act(e.id, async () => {
    if (!window.confirm(`Rotate the signing secret for ${e.url}?\n\nThere is no overlap window: the moment this returns, deliveries are signed with the new secret and the old one verifies nothing. Anything still checking the old secret will start rejecting deliveries.`)) return;
    const res = await api.rotateWebhookSecret(token!, orgId!, e.id);
    reveal(res.endpoint.url, res.secret, true);
    setCreating(false);
    reload();
  });

  const remove = (e: WebhookEndpoint): Promise<void> => act(e.id, async () => {
    if (!window.confirm(`Delete ${e.url}? It stops receiving events immediately. Anything already queued for it is dropped.`)) return;
    await api.deleteWebhook(token!, orgId!, e.id);
    if (openDeliveries === e.id) setOpenDeliveries(null);
    reload();
  });

  const sendTest = (e: WebhookEndpoint): Promise<void> => act(e.id, async () => {
    // Belt and braces for the render gate: a row can be stale by the time it is
    // clicked, and the server 409s a test at a disabled endpoint.
    if (!canSendTest(e.status)) { setError("This endpoint is disabled — re-enable it before testing."); return; }
    await api.testWebhook(token!, orgId!, e.id);
    // 202 = QUEUED. Saying "sent" would be a lie: the dispatcher sends on its
    // own poll, and the delivery row below is where the answer actually appears.
    setNotice("Test delivery queued. It is sent on the next dispatcher pass — watch the Deliveries list below for the result.");
    setOpenDeliveries(e.id);
    reload();
  });

  const reEnable = (e: WebhookEndpoint): Promise<void> => act(e.id, async () => {
    await api.updateWebhook(token!, orgId!, e.id, { status: "active" });
    setNotice(`${e.url} is active again. Its failure counters and failure clock were reset, so it starts from a clean slate — fix whatever caused the outage first, or it will simply disable itself again.`);
    reload();
  });

  if (!orgId) {
    return (
      <Card title="Webhooks">
        <EmptyState icon="code" title="No organization" hint="Your account is not linked to an organization, so there is nothing to deliver events for." />
      </Card>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <SectionHeader
        title="Webhooks"
        description="Register an HTTPS endpoint and TokenLayer POSTs this organization's events to it, signed with a shared secret. Every event is also readable from the cursor API, so a missed delivery is always recoverable."
        actions={
          // Gated on the RESOLVED org, not just its id: the create form needs the
          // capability envelope to filter the event-type list. Offering the
          // button without it would present a picker that cannot be filtered.
          org ? (
            <button
              onClick={() => { setCreating((v) => !v); setError(null); setNotice(null); }}
              className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
            >
              {creating ? "Close" : "Add endpoint"}
            </button>
          ) : undefined
        }
      />

      {org === null && (
        <p className="text-sm text-slate-500">
          Existing endpoints are listed below, but a new one cannot be registered here — this account&rsquo;s organization is
          not in the list you can see, so its capability envelope (which decides the events it may subscribe to) is unavailable.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{notice}</p>}

      {/*
        THE AUTO-DISABLE ANNOUNCEMENT. Not a pill — a banner, above the table,
        one per disabled endpoint, carrying the reason and the moment. This is
        the only notification that exists: the platform cannot tell an
        organization through the very endpoint it just switched off, so if an
        operator does not read it here, nobody tells them at all.
      */}
      {disabled.map((e) => (
        <div key={e.id} className="rounded-2xl border-2 border-red-300 bg-red-50/60 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-red-800">This endpoint is switched off and is receiving nothing</h3>
              <p className="font-mono text-xs text-slate-700 mt-1 break-all">{e.url}</p>
              {/* Which stream it was on, so an operator with a live and a test
                  endpoint at similar URLs knows which one went dark. */}
              <p className="mt-1"><Pill tone={modeTone(endpointMode(e))}>{modeLabel(endpointMode(e))}</Pill></p>
              <p className="text-xs text-red-700 mt-2">
                <span className="font-medium">Reason:</span> {e.disabledReason ?? "not recorded"}
              </p>
              <p className="text-xs text-red-700">
                <span className="font-medium">Switched off:</span> {fmt(e.disabledAt)}
              </p>
              <p className="text-xs text-slate-600 mt-2">
                Events that happened while it was off were not queued for it. Catch up with{" "}
                <span className="font-mono">GET /events?after=&lt;seq&gt;</span> — the cursor keeps every event this
                organization produced, whether or not a delivery was ever attempted.
              </p>
              <p className="text-xs text-slate-600 mt-1">
                Re-enabling resets the failure counters and the failure clock. Fix the cause first — an endpoint that is
                still failing will disable itself again.
              </p>
            </div>
            {/* A DELETED endpoint never appears here (the list route returns live
                rows only), so Re-enable is always applicable to what is shown. */}
            <button
              onClick={() => void reEnable(e)}
              disabled={busyId === e.id}
              className="shrink-0 rounded-lg bg-red-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-red-700 disabled:opacity-40"
            >
              Re-enable
            </button>
          </div>
        </div>
      ))}

      {revealed && (
        <SigningSecretPanel
          key={revealed.seq}
          url={revealed.url}
          secret={revealed.secret}
          rotated={revealed.rotated}
          onDismiss={() => setRevealed(null)}
        />
      )}

      {creating && org && (
        <CreateWebhook
          orgId={org.id}
          capabilities={org.capabilities ?? null}
          role={user?.role ?? null}
          onCreated={(url, secret) => { reveal(url, secret, false); setCreating(false); reload(); }}
        />
      )}

      {endpoints.length === 0 ? (
        <Card>
          <EmptyState
            icon="code"
            title="No webhook endpoints"
            hint="Register one to have this organization's events pushed to your system as they happen."
          />
        </Card>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Endpoint</th>
                <th className="text-left font-medium px-4 py-2.5">Stream</th>
                <th className="text-left font-medium px-4 py-2.5">Events</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-left font-medium px-4 py-2.5">Last delivery</th>
                <th className="text-left font-medium px-4 py-2.5">Recent failures</th>
                <th className="text-right font-medium px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <Fragment key={e.id}>
                  <tr className="border-t border-slate-100 align-top">
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-slate-800 break-all">{e.url}</div>
                      {e.description && <div className="text-xs text-slate-500 mt-0.5">{e.description}</div>}
                      <div className="text-xs text-slate-400 mt-0.5">
                        {e.useCaseKey ? <>only <span className="font-mono">{e.useCaseKey}</span></> : "all use cases"}
                      </div>
                    </td>
                    {/* Which environment's facts arrive here. Not derivable from
                        anything else on the row, and the difference between a
                        real payload and a simulated one. */}
                    <td className="px-4 py-2">
                      <Pill tone={modeTone(endpointMode(e))}>{modeLabel(endpointMode(e))}</Pill>
                      {endpointMode(e) === "test" && (
                        <div className="text-[11px] text-slate-400 mt-0.5 max-w-[10rem]">sandbox events only</div>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {e.eventTypes.map((t) => (
                          <Pill key={t} tone={t === "*" ? "warn" : "info"}>{t === "*" ? "* (everything)" : t}</Pill>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {/*
                        A bare "disabled" pill would be the whole story in a
                        cell nobody reads, so the pill says what happened and
                        the banner above carries the reason and the control.
                      */}
                      {e.status === "active"
                        ? <Pill tone="ok">active</Pill>
                        : <Pill tone="danger">switched off — see above</Pill>}
                    </td>
                    <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{fmt(e.lastDeliveryAt)}</td>
                    <td className="px-4 py-2">
                      <FailureCounters endpoint={e} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end flex-wrap gap-2">
                        <button
                          onClick={() => setOpenDeliveries((cur) => (cur === e.id ? null : e.id))}
                          className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50"
                        >
                          {openDeliveries === e.id ? "Hide deliveries" : "Deliveries"}
                        </button>
                        {/*
                          Send test is offered only for an ACTIVE endpoint: the
                          dispatcher settles a delivery to a switched-off
                          endpoint as dead without sending, so the server 409s
                          rather than pretend. Re-enable is the control that
                          applies instead, and it is in the banner above.
                        */}
                        {canSendTest(e.status) && (
                          <button
                            onClick={() => void sendTest(e)}
                            disabled={busyId === e.id}
                            className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                          >
                            Send test
                          </button>
                        )}
                        <button
                          onClick={() => void rotate(e)}
                          disabled={busyId === e.id}
                          className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                        >
                          Rotate secret
                        </button>
                        <button
                          onClick={() => void remove(e)}
                          disabled={busyId === e.id}
                          className="text-xs rounded border border-red-200 text-red-600 px-2.5 py-1 font-medium hover:bg-red-50 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {openDeliveries === e.id && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={7} className="px-4 py-3">
                        <Deliveries orgId={orgId} endpoint={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <VerifyingDeliveries />
    </div>
  );
}

/**
 * THE TWO COUNTERS, KEPT APART.
 *
 * They are not two views of "how broken is this" — they are evidence about
 * different machines, and conflating them sends the reader to the wrong one.
 *
 *  - `consecutiveFailures` — we sent, YOUR SERVER answered badly (or not at
 *    all). Look at your handler, your TLS, your uptime. This is the counter
 *    that eventually switches the endpoint off.
 *  - `consecutiveGuardFailures` — WE DID NOT SEND. The URL failed its safety
 *    re-check at delivery time: its DNS no longer resolves, or it now resolves
 *    to a private/loopback address. Your handler was never contacted, so its
 *    logs will show nothing at all — which is exactly why a reader who thinks
 *    this is "your server returned an error" burns hours in the wrong place.
 *    These NEVER auto-disable an endpoint, by design: otherwise anyone able to
 *    degrade a hostname's resolution could silence an organization's webhooks
 *    without touching it.
 */
function FailureCounters({ endpoint }: { endpoint: WebhookEndpoint }): JSX.Element {
  const { consecutiveFailures, consecutiveGuardFailures, failingSince } = endpoint;
  if (consecutiveFailures === 0 && consecutiveGuardFailures === 0) {
    return <span className="text-xs text-slate-400">none</span>;
  }
  return (
    <div className="space-y-1 max-w-[15rem]">
      {consecutiveFailures > 0 && (
        <div>
          <Pill tone="warn">{consecutiveFailures} in a row · your server</Pill>
          <p className="text-xs text-slate-500 mt-0.5">
            Delivered to your URL and got a bad answer (non-2xx, timeout or unreachable). This is the count that switches an
            endpoint off if it keeps up.
          </p>
        </div>
      )}
      {consecutiveGuardFailures > 0 && (
        <div>
          <Pill tone="danger">{consecutiveGuardFailures} in a row · blocked before sending</Pill>
          <p className="text-xs text-slate-500 mt-0.5">
            Nothing was sent: the URL failed its safety check at delivery time — the host stopped resolving, or now resolves to
            a private address. Your handler never saw a request, so check DNS and the hostname, not your logs. These do not
            switch an endpoint off.
          </p>
        </div>
      )}
      {failingSince && <p className="text-xs text-slate-400">failing since {fmt(failingSince)}</p>}
    </div>
  );
}

/**
 * The one-time signing secret. Same ceremony as the API-key panel next door and
 * for the same reason — no route returns it again — with copy about what THIS
 * secret is for. Dismissible only once acknowledged, so a stray click cannot
 * lose it.
 */
function SigningSecretPanel({ url, secret, rotated, onDismiss }: {
  url: string;
  secret: string;
  rotated: boolean;
  onDismiss: () => void;
}): JSX.Element {
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }

  return (
    <div className="bg-white rounded-2xl border-2 border-amber-300 shadow-sm">
      <div className="px-5 pt-4 pb-3 border-b border-amber-100">
        <h3 className="text-sm font-semibold text-slate-900">
          {rotated ? "New signing secret for" : "Signing secret for"} <span className="font-mono break-all">{url}</span>
        </h3>
        <p className="text-xs text-amber-700 mt-1 font-medium">
          This is the only time you will see this secret. It is not stored anywhere you can read it back — if you lose it,
          rotate the endpoint to mint a new one.
          {rotated && " The previous secret stopped signing the moment this one was created: deploy this to your verifier now, or deliveries will start failing verification."}
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Leaving this page — a sidebar click, a reload, closing the tab — discards it. You will be asked to confirm first.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 break-all rounded-lg bg-slate-900 text-slate-100 font-mono text-xs px-3 py-2.5">{secret}</code>
          <button
            onClick={() => void copy()}
            className="shrink-0 rounded-lg border border-slate-300 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            {copied === "ok" ? "Copied" : "Copy"}
          </button>
        </div>
        {copied === "fail" && <p className="text-xs text-red-600">Could not reach the clipboard — select the secret above and copy it manually.</p>}
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          I have stored this secret somewhere safe.
        </label>
        <button
          onClick={onDismiss}
          disabled={!acked}
          className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
        >
          Done — hide the secret
        </button>
      </div>
    </div>
  );
}

/**
 * Register an endpoint. The event-type list is filtered by the org's EN-A
 * envelope for the same reason the key form filters its role list: the server
 * refuses an out-of-envelope subscription with 403 ORG_CAPABILITY_MISSING, and
 * it refuses the WHOLE request — so one un-offerable tick would cost the
 * operator every other choice in the form.
 */
function CreateWebhook({ orgId, capabilities, role, onCreated }: {
  orgId: string;
  capabilities: OrgCapabilities | null;
  role: Role | null;
  onCreated: (url: string, secret: string) => void;
}): JSX.Element {
  const { token } = useAuth();
  const offered = subscribableEventTypes(capabilities, role);
  const hiddenByEnvelope = EVENT_TYPES.filter((t) => !offered.includes(t));

  const [url, setUrl] = useState(EMPTY_WEBHOOK_DRAFT.url);
  const [description, setDescription] = useState(EMPTY_WEBHOOK_DRAFT.description);
  const [useCaseKey, setUseCaseKey] = useState(EMPTY_WEBHOOK_DRAFT.useCaseKey);
  const [mode, setMode] = useState<ResourceMode>(EMPTY_WEBHOOK_DRAFT.mode);
  // Nothing preselected — see EMPTY_WEBHOOK_DRAFT for why.
  const [eventTypes, setEventTypes] = useState<EventType[]>([...EMPTY_WEBHOOK_DRAFT.eventTypes]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(t: EventType): void {
    setEventTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const check = checkWebhookDraft({ url, description, eventTypes, useCaseKey, mode });
    if (!check.ok) { setError(check.message); return; }
    setBusy(true);
    try {
      const res = await api.createWebhook(token!, orgId, {
        // From the CHECK, not from state: the validated values only exist on the
        // ok arm, so an incomplete draft cannot reach the wire.
        url: check.url,
        eventTypes: check.eventTypes,
        description: description.trim() || undefined,
        useCaseKey: useCaseKey.trim() || undefined,
        // FIXED AT REGISTRATION — there is no PATCH for it, so this is the only
        // moment the choice can be made and the reason it is on this form and
        // nowhere else.
        mode,
      });
      // Hand the secret straight to the reveal panel and keep NO copy here: this
      // form is about to unmount, and the secret must not outlive the handoff.
      onCreated(res.endpoint.url, res.secret);
    } catch (err) {
      setError(errMessage(err, "Could not register the endpoint"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
      <h2 className="font-semibold text-slate-900">Add a webhook endpoint</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-slate-500 mb-1">URL</label>
          <input className="input" placeholder="https://api.example.com/hooks/tokenlayer" value={url} onChange={(e) => setUrl(e.target.value)} />
          <p className="text-xs text-slate-500 mt-1">
            HTTPS only. The host is resolved and checked before every delivery — a URL that resolves to a private or loopback
            address is refused.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Description (optional)</label>
          <input className="input" placeholder="e.g. ERP inbound listener" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Use case (optional)</label>
          <input className="input" placeholder="all use cases" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)} />
          <p className="text-xs text-slate-500 mt-1">Leave empty to receive this organization&rsquo;s events from every use case.</p>
        </div>
      </div>

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Stream</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["live", "test"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`text-left rounded-xl border p-3 transition ${
                mode === m
                  ? m === "test"
                    ? "border-amber-500 bg-amber-50/60 shadow-sm"
                    : "border-brand-500 bg-brand-50/40 shadow-sm"
                  : "border-slate-200 hover:border-brand-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">{modeLabel(m)}</span>
                <Pill tone={modeTone(m)}>{modeLabel(m)}</Pill>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {m === "test"
                  ? "Hears only events from sandbox use cases."
                  : "Hears only events from real use cases."}
              </p>
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-2">
          The two streams never cross, so a sandbox event can never reach a production handler and a real one can never reach a
          test rig. <strong className="font-semibold text-slate-700">Fixed at registration</strong> — an endpoint cannot be
          moved between streams afterwards; register a second one instead.
        </p>
      </fieldset>

      <fieldset>
        <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Events to receive</legend>
        <p className="text-xs text-slate-500 mb-2">
          Nothing is selected by default — pick exactly the events your handler has code for. Subscribing to everything points
          a firehose at a URL that usually only cares about one thing.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          {offered.map((t) => (
            <label key={t} className="flex items-start gap-2 py-1 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={eventTypes.includes(t)}
                onChange={() => toggle(t)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="min-w-0">
                <span className="font-mono text-xs text-slate-800">{t}</span>
                <span className="block text-xs text-slate-500">{EVENT_DESCRIPTIONS[t]}</span>
              </span>
            </label>
          ))}
        </div>
        {hiddenByEnvelope.length > 0 && (
          <p className="text-xs text-slate-500 mt-2">
            {hiddenByEnvelope.join(", ")} {hiddenByEnvelope.length === 1 ? "is" : "are"} not offered — this
            organization&rsquo;s capability envelope does not include the product{" "}
            {hiddenByEnvelope.length === 1 ? "domain that event belongs to" : "domains those events belong to"}.
          </p>
        )}
      </fieldset>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Register endpoint
      </button>
    </form>
  );
}

/** The delivery log for one endpoint: what was attempted, what came back, and
 *  the only place a failed delivery can be pushed back onto the queue. */
function Deliveries({ orgId, endpoint }: { orgId: string; endpoint: WebhookEndpoint }): JSX.Element {
  const { token } = useAuth();
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadGen = useRef(0);
  const reload = (): void => {
    const gen = ++loadGen.current;
    if (!token) return;
    api.webhookDeliveries(token, orgId, endpoint.id)
      .then((d) => { if (loadGen.current === gen) { setRows(d); setError(null); } })
      .catch((err) => { if (loadGen.current === gen) setError(errMessage(err, "Failed to load deliveries")); });
  };
  useEffect(() => { reload(); return () => { loadGen.current++; }; }, [token, orgId, endpoint.id]);

  async function replay(d: WebhookDelivery): Promise<void> {
    if (!token) return;
    // Belt and braces for the render gate: a row can be claimed by a dispatcher
    // between the render and the click, and the server answers 409 for one that
    // is inflight rather than allow a double send.
    if (!canRetry(d.status)) { setError(`A ${d.status} delivery cannot be replayed.`); return; }
    setBusyId(d.id); setError(null);
    try {
      await api.replayWebhookDelivery(token, orgId, endpoint.id, d.id);
      reload();
    } catch (err) {
      setError(errMessage(err, "Replay failed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex items-center gap-2">
          Deliveries
          {/*
            A DELIVERY'S STREAM IS ITS ENDPOINT'S, by construction: the
            dispatcher only ever matches an event to an endpoint of the same
            mode, so every row below carries the same one. Repeating it per row
            would be noise; omitting it entirely would leave the one screen where
            payloads are inspected silent about whether they are real.
          */}
          <Pill tone={modeTone(endpointMode(endpoint))}>{modeLabel(endpointMode(endpoint))}</Pill>
        </h4>
        <button onClick={reload} className="text-xs rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50">
          Refresh
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {rows === null ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          Nothing has been queued for this endpoint yet. &ldquo;Send test&rdquo; queues a synthetic ping so you can prove
          signature verification before the first real event.
        </p>
      ) : (
        <table className="w-full text-xs bg-white rounded-lg border border-slate-200 overflow-hidden">
          <thead className="text-slate-500 bg-slate-50 uppercase tracking-wide">
            <tr>
              <th className="text-left font-medium px-3 py-2">Event</th>
              <th className="text-left font-medium px-3 py-2">Status</th>
              <th className="text-left font-medium px-3 py-2">Response</th>
              <th className="text-left font-medium px-3 py-2">Attempts</th>
              <th className="text-left font-medium px-3 py-2">Last attempt</th>
              <th className="text-left font-medium px-3 py-2">Next attempt</th>
              <th className="text-right font-medium px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2">
                  <div className="font-mono text-slate-700 break-all">{d.eventId}</div>
                  <div className="text-slate-400">seq {d.eventSeq}</div>
                </td>
                <td className="px-3 py-2"><Pill tone={deliveryTone(d.status)}>{d.status}</Pill></td>
                <td className="px-3 py-2">
                  <div className="text-slate-700">{d.responseStatus ?? "—"}{d.durationMs !== null ? ` · ${d.durationMs}ms` : ""}</div>
                  {d.responseError && <div className="text-red-600 break-words max-w-xs">{d.responseError}</div>}
                </td>
                <td className="px-3 py-2 text-slate-600">{d.attempts}</td>
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmt(d.lastAttemptAt)}</td>
                <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                  {d.status === "delivered" || d.status === "dead" ? "—" : fmt(d.nextAttemptAt)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end">
                    {/*
                      Replay is offered ONLY for a settled failure. `inflight` is
                      claimed by a running dispatcher (the server 409s, and
                      resetting it would risk a double send); `pending` is
                      already queued; `delivered` already arrived, and replaying
                      it would send the integrator a duplicate.
                    */}
                    {canRetry(d.status) && (
                      <button
                        onClick={() => void replay(d)}
                        disabled={busyId === d.id}
                        className="rounded border border-slate-300 text-slate-600 px-2.5 py-1 font-medium hover:bg-slate-50 disabled:opacity-40"
                      >
                        Replay
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-500">
        A delivery row records the attempt, not the payload. Read the event body from{" "}
        <span className="font-mono">GET /events</span> using the event id or seq above.
        {endpointMode(endpoint) === "test" && (
          <>
            {" "}Every delivery here is a <strong className="font-semibold text-slate-700">{modeLabel("test")}</strong> event:{" "}
            {modeBlurb("test")}
          </>
        )}
      </p>
    </div>
  );
}

/** The integration contract: how to verify a delivery, and what the delivery
 *  guarantees actually are. Both are things integrators build on and get wrong.
 *
 *  THE SNIPPET IS A MIRROR OF `verifySignature` (apps/api/src/webhooks/signing.ts)
 *  and must stay one. It is the only piece of this console an integrator copies
 *  into their own production server, so a shortcut taken here for brevity ships
 *  as a defect in someone else's code. The version this replaced took exactly
 *  the two shortcuts signing.ts warns against — a positional parse and a
 *  `timingSafeEqual` with no length check — and against real header output a
 *  short `v1=` threw RangeError, a missing header threw TypeError (both a 500 an
 *  unauthenticated attacker can trigger at will), and `v2=zz,t=…,v1=…` rejected
 *  a perfectly valid delivery, defeating the version prefix on the day we use it. */
function VerifyingDeliveries(): JSX.Element {
  const snippet = [
    `const sig = req.headers["${SIGNATURE_HEADER.toLowerCase()}"];   // t=<unix>,v1=<hex>`,
    "if (!sig) return res.sendStatus(400);",
    "",
    "// PARSE BY NAME, never by position: v1= is not promised to be the last (or",
    "// second) parameter, and a future v2= must not shift what you read.",
    "const parts = new Map();",
    "for (const part of sig.split(\",\")) {",
    "  const i = part.indexOf(\"=\");",
    "  if (i > 0) parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());",
    "}",
    "const rawT = parts.get(\"t\"), v1 = parts.get(\"v1\");",
    "// Number(\"\") is 0, not NaN, so an empty t= must be rejected here and not by",
    "// the freshness check below.",
    "if (!rawT || !v1 || !Number.isFinite(Number(rawT))) return res.sendStatus(400);",
    "const t = Number(rawT);",
    "if (Math.abs(Math.floor(Date.now() / 1000) - t) > 300) return res.sendStatus(400);",
    "",
    "// rawBody is the EXACT bytes of the request body — not JSON.parse'd and re-stringified.",
    "const expected = Buffer.from(",
    "  crypto.createHmac(\"sha256\", SECRET).update(`${t}.${rawBody}`).digest(\"hex\"), \"hex\");",
    "const got = Buffer.from(v1, \"hex\");",
    "// LENGTH FIRST: timingSafeEqual THROWS on a length mismatch, so comparing",
    "// straight away turns an attacker-controlled short v1= into a 500.",
    "const ok = expected.length === got.length && crypto.timingSafeEqual(expected, got);",
  ].join("\n");
  return (
    <Card
      title="Verifying a delivery"
      description="Every delivery carries Tokenlayer-Signature, Tokenlayer-Event-Id, Tokenlayer-Delivery-Id and Tokenlayer-Event-Type. Verify before you trust the body."
    >
      <pre className="overflow-x-auto rounded-lg bg-slate-900 text-slate-100 font-mono text-xs p-4 leading-5">{snippet}</pre>
      <div className="text-xs text-slate-500 mt-3 space-y-1.5">
        <p>
          <strong>Sign the RAW BYTES.</strong> This is the mistake almost everyone makes first: a framework that has already
          parsed the body hands you an object, and hashing <span className="font-mono">JSON.stringify(req.body)</span> gives a
          different string from what we signed — key order, whitespace and number formatting are all free to differ. Every
          signature then fails, and nothing in the error says why. Capture the raw body (Express:{" "}
          <span className="font-mono">express.raw()</span>, or <span className="font-mono">verify</span> on{" "}
          <span className="font-mono">express.json()</span>) and hash that.
        </p>
        <p>
          The timestamp is <em>inside</em> the signed material, so it cannot be re-stamped by someone replaying a captured
          delivery. Reject anything more than <strong>300 seconds</strong> from your clock, and compare with a constant-time
          comparison — never <span className="font-mono">===</span>.
        </p>
        <p>
          <strong>Two details above are load-bearing, not style.</strong> Compare buffer <em>lengths</em> before calling{" "}
          <span className="font-mono">timingSafeEqual</span>: it throws on a length mismatch, so a one-character{" "}
          <span className="font-mono">v1=</span> from an unauthenticated caller becomes a 500 in your handler rather than a
          rejected delivery. And read the parameters <em>by name</em>: splitting on{" "}
          <span className="font-mono">,</span> and taking positions works only until a delivery carries a parameter you have
          not seen — which is exactly what the <span className="font-mono">v1=</span> prefix exists to allow.
        </p>
        <p>
          <strong>At-least-once, not exactly-once.</strong> A delivery your server handled but answered slowly (or a replay an
          operator triggered from this page) arrives again. Deduplicate on{" "}
          <span className="font-mono">Tokenlayer-Event-Id</span>, which is stable across every attempt of the same event.
        </p>
        <p>
          <strong>Ordering is not guaranteed.</strong> Retries reorder by construction: an event that failed once is retried
          minutes later, long after the events that followed it were delivered. If order matters, sort by the{" "}
          <span className="font-mono">seq</span> field on the payload, or ignore delivery order entirely and read the log with{" "}
          <span className="font-mono">GET /events?after=&lt;seq&gt;</span> — <span className="font-mono">after</span> is
          exclusive, so <span className="font-mono">after = nextAfter</span> never re-reads and never skips.
        </p>
        <p>
          A failed delivery is retried six times over roughly <strong>8 hours</strong> and then dead-lettered. Dead deliveries
          stay in the list above and can be replayed by hand once your endpoint is healthy again. Answer{" "}
          <span className="font-mono">2xx</span> quickly and do your work asynchronously — a slow handler is a failed delivery.
        </p>
      </div>
    </Card>
  );
}
