/**
 * Shared helper for the dev/e2e scripts under this directory, all of which
 * drive the platform's HTTP API directly via `app.inject` (never through
 * `test/helpers.ts` — these run as standalone `tsx` scripts, not vitest).
 *
 * Every new asset now starts `pending_approval` (see the due-diligence
 * review feature) — a script that issues an asset and then immediately acts
 * on it (mint/allow/buy/...) needs to complete the due-diligence flow first,
 * or every such action now 409s/400s on a non-active asset. This mirrors
 * `apps/api/test/helpers.ts`'s own `completeDueDiligence`, adapted to the
 * plain `app.inject` calls these scripts already use instead of that file's
 * test-only wrappers.
 */
import type { FastifyInstance } from "fastify";

/**
 * Attach a throwaway prospectus (as `actorToken`, who must hold the
 * `assets:issue` scope on the asset's own use case), submit it for review,
 * then approve it (as `deciderToken`, who must be a UseCaseAdmin of that same
 * use case or a PlatformAdmin, and — the one rule that can't be waived —
 * someone OTHER than whoever created the asset). Throws if any step fails,
 * so a script's own `main().catch(...)` surfaces the real cause instead of
 * limping on with an asset stuck at `pending_approval`.
 */
export async function completeDueDiligence(
  app: FastifyInstance,
  assetId: string,
  actorToken: string,
  deciderToken: string,
): Promise<void> {
  async function inject(url: string, token: string, payload: unknown) {
    return app.inject({ method: "POST", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
  }

  const upload = await inject(`/assets/${assetId}/diligence/documents`, actorToken, {
    slot: "prospectus",
    contentType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.4 dev-script fixture").toString("base64"),
  });
  if (upload.statusCode !== 201) {
    throw new Error(`completeDueDiligence(${assetId}): prospectus upload failed: ${upload.statusCode} ${upload.payload}`);
  }
  const submitted = await inject(`/assets/${assetId}/submit-for-review`, actorToken, {});
  if (submitted.statusCode !== 200) {
    throw new Error(`completeDueDiligence(${assetId}): submit-for-review failed: ${submitted.statusCode} ${submitted.payload}`);
  }
  const decision = await inject(`/assets/${assetId}/review-decision`, deciderToken, { decision: "approved", riskTier: "low" });
  if (decision.statusCode !== 200) {
    throw new Error(`completeDueDiligence(${assetId}): review-decision failed: ${decision.statusCode} ${decision.payload}`);
  }
}
