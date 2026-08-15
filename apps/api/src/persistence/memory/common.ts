/** Shared in-memory helpers. Ids are per-process and monotonic, never persisted. */
let counter = 0;
export const id = (prefix: string): string => `${prefix}_${(++counter).toString(36)}`;
export const now = (): string => new Date().toISOString();

/** Slice a materialised array into a page. Both products' list routes use it. */
import type { Page, Paged } from "../types/index.js";
export function paginate<T>(rows: T[], page: Page): Paged<T> {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? rows.length;
  return { items: rows.slice(offset, offset + limit), total: rows.length };
}
