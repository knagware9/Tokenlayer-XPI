export const KYC_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/** True if `expiresAt` is already past, or falls within the 30-day warning window. Null/undefined (grandfathered, never-expiring) is always false. */
export function isExpiringOrExpired(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - nowMs < KYC_EXPIRY_WARNING_MS;
}
