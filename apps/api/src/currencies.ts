import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CURRENCIES_FILE = fileURLToPath(new URL("../../../config/currencies.json", import.meta.url));

export interface Currency {
  code: string;
  label: string;
}

let cached: Currency[] | null = null;

export function loadCurrencies(): Currency[] {
  if (!cached) {
    cached = JSON.parse(readFileSync(CURRENCIES_FILE, "utf8")) as Currency[];
  }
  return cached;
}

export function isSupportedCurrency(code: string): boolean {
  return loadCurrencies().some((c) => c.code === code);
}
