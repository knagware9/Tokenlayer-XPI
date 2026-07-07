import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, UseCase } from "../types.js";

// ============================================================================
// Invoice Import — browser-side counterpart of scripts/erp-import.mjs.
// Parses a CSV/JSON invoice export, computes each invoice's CANONICAL
// fingerprint (identical byte-for-byte to the Node connector), previews the
// batch with local validation, then tokenizes each valid row through the
// public API: issue → allowlist financier → mint (tokenId = fingerprint).
// The ledger's duplicate-tokenId rejection blocks double financing across
// channels (ERP connector, this tab, any other integration).
// ============================================================================

const INVOICE_FIELDS = ["invoiceNumber", "sellerGstin", "buyerGstin", "amountInr", "dueDate"] as const;
const OPTIONAL_FIELDS = ["discountRatePct", "invoiceDocUrl"] as const;
const CSV_HEADERS = [...INVOICE_FIELDS, ...OPTIONAL_FIELDS].join(",");

type RowStatus = "invalid" | "pending" | "working" | "tokenized" | "duplicate" | "error";

interface ImportRow {
  invoiceNumber: string;
  sellerGstin: string;
  buyerGstin: string;
  amountInr: string;
  dueDate: string;
  discountRatePct: string;
  invoiceDocUrl: string;
  fingerprint: string;
  problems: string[];
  status: RowStatus;
  message?: string;
}

/** Canonical fingerprint — MUST match computeFingerprint in scripts/erp-import.mjs. */
async function computeFingerprint(inv: {
  invoiceNumber: string; sellerGstin: string; buyerGstin: string; amountInr: string; dueDate: string;
}): Promise<string> {
  const canonical = [
    String(inv.invoiceNumber).trim(),
    String(inv.sellerGstin).trim().toUpperCase(),
    String(inv.buyerGstin).trim().toUpperCase(),
    String(parseInt(String(inv.amountInr), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Simple CSV: first line headers, comma-split, trimmed cells (matches the connector). */
function parseCsv(text: string): Record<string, string>[] {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!headerLine || lines.length === 0) return [];
  const headers = headerLine.split(",").map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** Local validation: required fields, schema patterns (generic), positive amount. */
function validate(raw: Record<string, string>, useCase: UseCase): string[] {
  const problems: string[] = [];
  for (const field of INVOICE_FIELDS) {
    const value = (raw[field] ?? "").trim();
    if (!value) {
      problems.push(`${field} missing`);
      continue;
    }
    const pattern = useCase.metadataSchema.properties[field]?.pattern;
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(value)) problems.push(`${field} fails pattern`);
      } catch {
        /* invalid pattern in schema — let the API decide */
      }
    }
  }
  const amount = Number(raw.amountInr);
  if (raw.amountInr && (!Number.isFinite(amount) || amount <= 0)) problems.push("amountInr must be a positive number");
  return problems;
}

interface Props {
  useCase: UseCase;
  chains: ChainInfo[];
  onTokenized: () => void;
}

export function InvoiceImport({ useCase, chains, onTokenized }: Props): JSX.Element {
  const { token } = useAuth();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [financier, setFinancier] = useState("");
  const [accounts, setAccounts] = useState<{ address: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Mintable chains = the ones this use case has actually DEPLOYED a contract on.
  const deployedChains = useMemo(() => {
    const deployed = Object.keys(useCase.contracts ?? {});
    return deployed.map((id) => chains.find((c) => c.id === id) ?? { id, label: id } as ChainInfo);
  }, [useCase, chains]);
  const [chainId, setChainId] = useState("");
  useEffect(() => {
    const preferred = deployedChains.find((c) => c.id === useCase.defaultChainId) ?? deployedChains[0];
    setChainId(preferred?.id ?? "");
  }, [deployedChains, useCase]);

  useEffect(() => {
    if (!token) return;
    void api.accounts(token).then(setAccounts).catch(() => {});
  }, [token]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    setRows([]);
    setDone(false);
    try {
      const text = await file.text();
      let raws: Record<string, string>[];
      if (/\.json$/i.test(file.name)) {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("JSON must be an array of invoice objects");
        raws = parsed.map((o) => {
          const rec: Record<string, string> = {};
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) rec[k] = v == null ? "" : String(v).trim();
          return rec;
        });
      } else {
        raws = parseCsv(text);
      }
      if (raws.length === 0) throw new Error("No invoice rows found in file");
      const parsedRows = await Promise.all(
        raws.map(async (raw): Promise<ImportRow> => {
          const problems = validate(raw, useCase);
          return {
            invoiceNumber: (raw.invoiceNumber ?? "").trim(),
            sellerGstin: (raw.sellerGstin ?? "").trim(),
            buyerGstin: (raw.buyerGstin ?? "").trim(),
            amountInr: (raw.amountInr ?? "").trim(),
            dueDate: (raw.dueDate ?? "").trim(),
            discountRatePct: (raw.discountRatePct ?? "").trim(),
            invoiceDocUrl: (raw.invoiceDocUrl ?? "").trim(),
            fingerprint: problems.length === 0 ? await computeFingerprint(raw as Parameters<typeof computeFingerprint>[0]) : "",
            problems,
            status: problems.length === 0 ? "pending" : "invalid",
          };
        }),
      );
      setRows(parsedRows);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Could not parse file");
    } finally {
      e.target.value = ""; // allow re-selecting the same file
    }
  }

  const validCount = rows.filter((r) => r.status !== "invalid").length;
  const invalidCount = rows.length - validCount;

  function patchRow(index: number, patch: Partial<ImportRow>): void {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function tokenize(): Promise<void> {
    if (!token || !financier || !chainId) return;
    setBusy(true);
    setDone(false);
    let anyMinted = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.status === "invalid" || row.status === "tokenized" || row.status === "duplicate") continue;
      patchRow(i, { status: "working", message: undefined });
      try {
        // 1. issue the invoice asset (metadata validated by the platform)
        const metadata: Record<string, unknown> = {
          invoiceHash: row.fingerprint,
          invoiceNumber: row.invoiceNumber,
          sellerGstin: row.sellerGstin,
          buyerGstin: row.buyerGstin,
          amountInr: Number(row.amountInr),
          dueDate: row.dueDate,
          ...(row.discountRatePct ? { discountRatePct: Number(row.discountRatePct) } : {}),
          ...(row.invoiceDocUrl ? { invoiceDocUrl: row.invoiceDocUrl } : {}),
        };
        const issued = await api.issue(token, {
          useCaseKey: useCase.key,
          name: `${row.invoiceNumber} · ${row.sellerGstin.slice(0, 4)}→${row.buyerGstin.slice(0, 4)}`,
          chainId,
          metadata,
        });
        const assetId = issued.asset.id;
        // 2. allowlist the financier (idempotent; KYC-gated by the platform)
        await api.action(token, assetId, "allow", { account: financier });
        // 3. mint — tokenId IS the fingerprint; the ledger blocks duplicates
        try {
          const mintBody: Record<string, string> = { to: financier, tokenId: row.fingerprint };
          if (row.invoiceDocUrl) mintBody.uri = row.invoiceDocUrl;
          await api.action(token, assetId, "mint", mintBody);
          patchRow(i, { status: "tokenized", message: undefined });
          anyMinted = true;
        } catch (mintErr) {
          // Mint rejected after a successful issue = duplicate financing blocked by the ledger.
          patchRow(i, { status: "duplicate", message: mintErr instanceof ApiError ? mintErr.message : "token already exists" });
        }
      } catch (err) {
        patchRow(i, { status: "error", message: err instanceof ApiError ? err.message : "request failed" });
      }
    }
    setBusy(false);
    setDone(true);
    if (anyMinted) onTokenized();
  }

  const tokenized = rows.filter((r) => r.status === "tokenized").length;
  const duplicates = rows.filter((r) => r.status === "duplicate").length;
  const errors = rows.filter((r) => r.status === "error").length;
  const pending = rows.filter((r) => r.status === "pending" || r.status === "working").length;

  const sampleCsvHref = useMemo(
    () =>
      "data:text/csv;charset=utf-8," +
      encodeURIComponent(`${CSV_HEADERS}\nINV-2026-001,24AAACS1429B1ZL,27AABCR1718E1ZP,500000,2026-09-30,2.5,https://docs.example.com/INV-2026-001.pdf\n`),
    [],
  );

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-slate-900">Import invoices</h2>
          <p className="text-xs text-slate-500 mt-1">
            Upload an ERP export (.csv or .json). Each invoice gets a canonical fingerprint used as its token ID, so an
            already-financed invoice is rejected by the ledger — even if it arrived through another channel.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Invoice file</span>
            <input
              type="file"
              accept=".csv,.json"
              onChange={(e) => void handleFile(e)}
              disabled={busy}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:text-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-brand-700 file:cursor-pointer"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Financier (mint recipient)</span>
            <select className="select" value={financier} onChange={(e) => setFinancier(e.target.value)} disabled={busy}>
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.address} value={a.address}>{a.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Chain / DLT</span>
            <select className="select" value={chainId} onChange={(e) => setChainId(e.target.value)} disabled={busy}>
              {deployedChains.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-[11px] text-slate-400">
          Expected columns: <span className="font-mono">{CSV_HEADERS}</span>{" "}
          <a href={sampleCsvHref} download="invoices-sample.csv" className="text-brand-600 hover:underline">
            Download sample CSV
          </a>
        </p>

        {deployedChains.length === 0 && (
          <p className="text-sm text-amber-600">This use case has no deployed contract yet — deploy it to a chain before importing.</p>
        )}
        {parseError && <p className="text-sm text-red-600">Could not parse {fileName}: {parseError}</p>}
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <p className="text-sm text-slate-600">
              <span className="font-medium text-slate-800">{fileName}</span> — {rows.length} row(s), {validCount} valid
              {invalidCount > 0 && <span className="text-red-600"> · {invalidCount} invalid (excluded)</span>}
            </p>
            <button
              onClick={() => void tokenize()}
              disabled={busy || pending === 0 || !financier || !chainId}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Tokenizing…" : `Tokenize ${pending} invoice${pending === 1 ? "" : "s"}`}
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Invoice</th>
                <th className="text-left font-medium px-4 py-2.5">Seller → Buyer</th>
                <th className="text-right font-medium px-4 py-2.5">Amount (INR)</th>
                <th className="text-left font-medium px-4 py-2.5">Due date</th>
                <th className="text-left font-medium px-4 py-2.5">Fingerprint</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={`${r.invoiceNumber}-${i}`} className={r.status === "invalid" ? "bg-red-50/40" : undefined}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{r.invoiceNumber || <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-xs font-mono text-slate-600">{r.sellerGstin || "?"} → {r.buyerGstin || "?"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{r.amountInr || "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{r.dueDate || "—"}</td>
                  <td className="px-4 py-2.5 text-xs font-mono text-slate-500" title={r.fingerprint}>
                    {r.fingerprint ? `${r.fingerprint.slice(0, 12)}…` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={r.status} />
                    {(r.message ?? (r.problems.length > 0 ? r.problems.join("; ") : "")) && (
                      <div className="text-[11px] text-slate-400 mt-0.5 max-w-[16rem] truncate" title={r.message ?? r.problems.join("; ")}>
                        {r.message ?? r.problems.join("; ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {done && (
            <p className="px-4 py-3 border-t border-slate-100 text-sm text-slate-600">
              <span className="text-emerald-700 font-medium">{tokenized} tokenized</span>
              {" · "}
              <span className="text-amber-700 font-medium">{duplicates} duplicate</span>
              {" · "}
              <span className="text-red-700 font-medium">{errors} error{errors === 1 ? "" : "s"}</span>
              {invalidCount > 0 && <span className="text-slate-400"> · {invalidCount} invalid (skipped)</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RowStatus }): JSX.Element {
  const tone: Record<RowStatus, string> = {
    invalid: "bg-red-100 text-red-700",
    pending: "bg-slate-100 text-slate-500",
    working: "bg-brand-50 text-brand-700",
    tokenized: "bg-emerald-100 text-emerald-700",
    duplicate: "bg-amber-100 text-amber-700",
    error: "bg-red-100 text-red-700",
  };
  const label: Record<RowStatus, string> = {
    invalid: "invalid",
    pending: "pending",
    working: "tokenizing…",
    tokenized: "tokenized",
    duplicate: "duplicate",
    error: "error",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${tone[status]}`}>{label[status]}</span>;
}
