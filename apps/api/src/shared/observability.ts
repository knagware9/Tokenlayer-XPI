import * as Sentry from "@sentry/node";
import { scrubEvent } from "@tokenlayer/core";

let initialized = false;

/**
 * Pilot-scale error tracking: a total no-op unless SENTRY_DSN is set (unset
 * in local dev/tests — no network call, no dependency cost). `sendDefaultPii:
 * false` plus `scrubEvent` are belt-and-suspenders: this platform carries KYC
 * and identity data that must never leave the process toward a third-party
 * SaaS, even inside an error report. No performance tracing or session replay
 * is enabled — this is error tracking only, sized for a pilot, not full APM.
 */
export function initObservability(opts: { dsn: string | undefined; environment: string }): void {
  if (!opts.dsn) return;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
  });
  initialized = true;
}

/** No-op when observability isn't configured, so every call site stays simple. */
export function captureException(err: unknown): void {
  if (!initialized) return;
  Sentry.captureException(err);
}

/**
 * Boot/fatal-path variant: flushes before returning. A request-handler
 * capture can rely on Sentry's normal background send because the process
 * keeps running; a capture made right before `process.exit()` cannot.
 */
export async function captureFatalAndFlush(err: unknown): Promise<void> {
  if (!initialized) return;
  Sentry.captureException(err);
  await Sentry.flush(2000);
}
