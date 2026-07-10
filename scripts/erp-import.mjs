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
    String(inv.buyerName).trim().toUpperCase(),
    String(inv.currency).trim().toUpperCase(),
    String(parseInt(String(inv.amount), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  return "0x" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Template header ("Invoice No") or camelCase → canonical field name.
const HEADER_MAP = { invoiceno: "invoiceNumber", invoicenumber: "invoiceNumber", invoicedate: "invoiceDate", buyername: "buyerName", buyer: "buyerName", currency: "currency", amount: "amount", amountinr: "amount", duedate: "dueDate", status: "status", invoicedocurl: "invoiceDocUrl" };
const mapHeader = (h) => HEADER_MAP[h.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? h;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = lines[0].split(",").map((h) => mapHeader(h.trim()));
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
// The MSME seller that receives the tokenized invoice (formerly --financier). It
// then lists the tokens on the marketplace for financiers to buy at a discount.
const HOLDER = arg("holder", arg("financier"));
const PAR = Math.max(1, parseInt(arg("par", "1"), 10) || 1); // ₹ face value per fungible token
const FILE = arg("file", "samples/erp/invoices.csv");

if (!EMAIL || !PASSWORD || !HOLDER) {
  console.error("usage: erp-import.mjs --api <url> --email <op> --password <pw> --holder <wallet> [--par <inr-per-token>] [--use-case k] [--chain c] [--file f]");
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
console.log(`ERP import: ${rows.length} invoice(s) from ${FILE} → use case '${USE_CASE}' on '${CHAIN}', holder ${HOLDER}, par ₹${PAR}/token\n`);

const results = { TOKENIZED: 0, "DUPLICATE-BLOCKED": 0, SKIPPED: 0, INVALID: 0 };
for (const inv of rows) {
  const label = `${inv.invoiceNumber} ${inv.currency ?? "INR"} ${inv.amount}`;
  const fingerprint = computeFingerprint(inv); // display only — the server derives + enforces this
  const supply = Math.max(1, Math.round(Number(inv.amount) / PAR));
  // ERP eligibility gate: only 'Available' invoices tokenize — an expected skip.
  if ((inv.status ?? "").trim() && inv.status.trim().toLowerCase() !== "available") {
    results.SKIPPED += 1;
    console.log(`  ○ SKIPPED            ${label} — status '${inv.status}' (only Available tokenize)`);
    continue;
  }
  const metadata = {
    // invoiceHash is intentionally omitted: the platform derives it server-side
    // from the canonical fields and rejects duplicates (409 DUPLICATE_ASSET).
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    buyerName: inv.buyerName,
    currency: (inv.currency ?? "INR").toUpperCase(),
    amount: Number(inv.amount),
    dueDate: inv.dueDate,
    ...(inv.status ? { status: inv.status } : {}),
    ...(inv.discountRatePct ? { discountRatePct: Number(inv.discountRatePct) } : {}),
    ...(inv.invoiceDocUrl ? { invoiceDocUrl: inv.invoiceDocUrl } : {}),
  };

  // Tokenize the invoice into `supply` fungible tokens minted to the holder. The
  // issue path auto-allowlists + mints the treasury, and rejects a duplicate
  // fingerprint with 409 DUPLICATE_ASSET (cross-channel double-financing block).
  const issued = await call("POST", "/assets", TOKEN, {
    useCaseKey: USE_CASE,
    name: `${inv.invoiceNumber} · ${inv.buyerName}`,
    chainId: CHAIN,
    initialSupply: String(supply),
    treasuryAccount: HOLDER,
    metadata,
  });
  if (issued.status === 201) {
    results.TOKENIZED += 1;
    console.log(`  ✓ TOKENIZED          ${label} → ${supply} tokens → holder (${fingerprint.slice(0, 14)}…)`);
  } else if (issued.status === 409 && issued.json?.error === "DUPLICATE_ASSET") {
    results["DUPLICATE-BLOCKED"] += 1;
    console.log(`  ⛔ DUPLICATE-BLOCKED ${label} — invoice already tokenized (${fingerprint.slice(0, 14)}…)`);
  } else {
    results.INVALID += 1;
    console.log(`  ✗ INVALID            ${label} — ${issued.json?.error}: ${String(issued.json?.message ?? "").slice(0, 80)}`);
  }
}

console.log(`\nSummary: ${results.TOKENIZED} tokenized · ${results["DUPLICATE-BLOCKED"]} duplicate-blocked · ${results.SKIPPED} skipped · ${results.INVALID} invalid`);
process.exit(results.INVALID > 0 ? 1 : 0);
