#!/usr/bin/env node
// ============================================================================
// ERP → TokenLayer invoice connector.
//
// Reads an ERP invoice export (CSV), computes each invoice's canonical
// fingerprint, and tokenizes it through the PLATFORM'S PUBLIC API:
//   issue asset (validated metadata) → allowlist financier → mint token
//   (tokenId = fingerprint, uri = document link).
//
// The fingerprint doubles as the tokenId, so the ledger itself rejects a
// duplicate invoice — across every channel that uses the same canonicalisation
// (this script, the web Import tab, or any other integration).
//
//   node scripts/erp-import.mjs \
//     --api http://localhost:4000 --email m1.admin@tokenlayer.dev --password … \
//     --use-case invoice-tokenization --chain fabric \
//     --financier 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 \
//     --file samples/erp/invoices.csv
//
// Outcomes per row: TOKENIZED | DUPLICATE-BLOCKED | INVALID. Duplicates are an
// expected, successful outcome of de-dup (exit 0); INVALID rows exit non-zero.
// ============================================================================
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// --- canonical fingerprint (MUST match the web importer's WebCrypto version) --
export function computeFingerprint(inv) {
  const canonical = [
    String(inv.invoiceNumber).trim(),
    String(inv.sellerGstin).trim().toUpperCase(),
    String(inv.buyerGstin).trim().toUpperCase(),
    String(parseInt(String(inv.amountInr), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const API = (arg("api", "http://localhost:4000") ?? "").replace(/\/$/, "") + "/api/v1";
const EMAIL = arg("email");
const PASSWORD = arg("password");
const USE_CASE = arg("use-case", "invoice-tokenization");
const CHAIN = arg("chain", "fabric");
const FINANCIER = arg("financier");
const FILE = arg("file", "samples/erp/invoices.csv");

if (!EMAIL || !PASSWORD || !FINANCIER) {
  console.error("usage: erp-import.mjs --api <url> --email <op> --password <pw> --financier <wallet> [--use-case k] [--chain c] [--file f]");
  process.exit(2);
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const login = await call("POST", "/auth/login", null, { email: EMAIL, password: PASSWORD });
if (login.status !== 200) { console.error(`login failed (${login.status})`); process.exit(2); }
const TOKEN = login.json.token;

const rows = parseCsv(readFileSync(FILE, "utf8"));
console.log(`ERP import: ${rows.length} invoice(s) from ${FILE} → use case '${USE_CASE}' on '${CHAIN}', financier ${FINANCIER}\n`);

const results = { TOKENIZED: 0, "DUPLICATE-BLOCKED": 0, INVALID: 0 };
for (const inv of rows) {
  const label = `${inv.invoiceNumber} ₹${inv.amountInr}`;
  const fingerprint = computeFingerprint(inv);
  const metadata = {
    invoiceHash: fingerprint,
    invoiceNumber: inv.invoiceNumber,
    sellerGstin: inv.sellerGstin,
    buyerGstin: inv.buyerGstin,
    amountInr: Number(inv.amountInr),
    dueDate: inv.dueDate,
    ...(inv.discountRatePct ? { discountRatePct: Number(inv.discountRatePct) } : {}),
    ...(inv.invoiceDocUrl ? { invoiceDocUrl: inv.invoiceDocUrl } : {}),
  };

  // 1. issue the invoice asset (metadata validated by the platform)
  const issued = await call("POST", "/assets", TOKEN, {
    useCaseKey: USE_CASE,
    name: `${inv.invoiceNumber} · ${inv.sellerGstin.slice(0, 4)}→${inv.buyerGstin.slice(0, 4)}`,
    chainId: CHAIN,
    metadata,
  });
  if (issued.status !== 201) {
    results.INVALID += 1;
    console.log(`  ✗ INVALID            ${label} — ${issued.json?.error}: ${String(issued.json?.message ?? "").slice(0, 80)}`);
    continue;
  }
  const assetId = issued.json.asset.id;

  // 2. allowlist the financier on this asset (idempotent; KYC-gated by the platform)
  const allowed = await call("POST", `/assets/${assetId}/actions/allow`, TOKEN, { account: FINANCIER });
  if (allowed.status !== 200) {
    results.INVALID += 1;
    console.log(`  ✗ INVALID            ${label} — allow failed: ${allowed.json?.error}`);
    continue;
  }

  // 3. mint the token — tokenId IS the fingerprint; the ledger blocks duplicates
  const minted = await call("POST", `/assets/${assetId}/actions/mint`, TOKEN, {
    to: FINANCIER,
    tokenId: fingerprint,
    uri: inv.invoiceDocUrl || undefined,
  });
  if (minted.status === 200) {
    results.TOKENIZED += 1;
    console.log(`  ✓ TOKENIZED          ${label} — token ${fingerprint.slice(0, 14)}…`);
  } else {
    // The ledger rejecting an existing tokenId = duplicate financing blocked.
    results["DUPLICATE-BLOCKED"] += 1;
    console.log(`  ⛔ DUPLICATE-BLOCKED ${label} — invoice already tokenized (${fingerprint.slice(0, 14)}…)`);
  }
}

console.log(`\nSummary: ${results.TOKENIZED} tokenized · ${results["DUPLICATE-BLOCKED"]} duplicate-blocked · ${results.INVALID} invalid`);
process.exit(results.INVALID > 0 ? 1 : 0);
