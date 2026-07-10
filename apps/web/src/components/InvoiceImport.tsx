import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, UseCase } from "../types.js";

// ============================================================================
// Invoice Import — browser-side counterpart of scripts/erp-import.mjs.
// Accepts the ERP invoice template (XLSX/CSV/JSON) with columns:
//   Invoice No · Invoice Date · Buyer Name · Currency · Amount · Due Date · Status
// Previews the batch with local validation (only 'Available' invoices are
// eligible), then tokenizes each valid row through the public API as a single
// fungible issue: the invoice's face value is split into
// `supply = round(face / par)` ERC-20 units minted to a holder. The server
// derives the canonical invoice fingerprint and rejects an already-tokenized
// invoice with a 409 (DUPLICATE_ASSET) — the cross-channel double-tokenization
// guard.
// ============================================================================

const INVOICE_FIELDS = ["invoiceNumber", "invoiceDate", "buyerName", "currency", "amount", "dueDate"] as const;
const OPTIONAL_FIELDS = ["status", "invoiceDocUrl"] as const;

/** Template headers (the ERP export sheet) in display order. */
const TEMPLATE_HEADERS = ["Invoice No", "Invoice Date", "Buyer Name", "Currency", "Amount", "Due Date", "Status"] as const;

/** header (normalized: lowercase, alphanumerics only) → canonical field. */
const HEADER_MAP: Record<string, string> = {
  invoiceno: "invoiceNumber", invoicenumber: "invoiceNumber",
  invoicedate: "invoiceDate",
  buyername: "buyerName", buyer: "buyerName",
  currency: "currency",
  amount: "amount", amountinr: "amount",
  duedate: "dueDate",
  status: "status",
  invoicedocurl: "invoiceDocUrl",
};
const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A representative ERP export (the template scheme) for one-click demos. */
const ERP_SAMPLE_CSV = `${TEMPLATE_HEADERS.join(",")}
RAMCO-INV-020101-2026,2026-06-01,JSW Steel Limited,INR,371400,2026-08-15,Available
RAMCO-INV-020102-2026,2026-06-04,ITC Limited,INR,103500,2026-08-18,Available
RAMCO-INV-020103-2026,2026-06-06,Bajaj Auto Limited,INR,355000,2026-08-20,Available
RAMCO-INV-020102-2026,2026-06-04,ITC Limited,INR,103500,2026-08-18,Available
RAMCO-INV-020104-2026,2026-06-08,Vedanta Limited,INR,428900,2026-08-23,Paid`;

type RowStatus = "invalid" | "pending" | "working" | "tokenized" | "duplicate" | "error";

interface ImportRow {
  invoiceNumber: string;
  invoiceDate: string;
  buyerName: string;
  currency: string;
  amount: string;
  dueDate: string;
  erpStatus: string;
  invoiceDocUrl: string;
  problems: string[];
  status: RowStatus;
  message?: string;
}

/** Canonical fingerprint — MUST match core invoiceFingerprint + scripts/erp-import.mjs. */
export async function computeFingerprint(inv: {
  invoiceNumber: string; buyerName: string; currency: string; amount: string; dueDate: string;
}): Promise<string> {
  const canonical = [
    String(inv.invoiceNumber).trim(),
    String(inv.buyerName).trim().toUpperCase(),
    String(inv.currency).trim().toUpperCase(),
    String(parseInt(String(inv.amount), 10)),
    String(inv.dueDate).trim(),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Token supply for an invoice = round(face value / par value), at least 1. */
function supplyFor(amount: string | number, parValue: string | number): number {
  return Math.max(1, Math.round(Number(amount) / Math.max(1, Number(parValue) || 1)));
}

/** Excel serial date (days since 1899-12-30) → YYYY-MM-DD. */
function excelSerialToISO(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);
}

/** Map raw {header: value} objects to canonical-field records via HEADER_MAP,
 * converting Excel date serials on the date fields. */
function canonicalize(raws: Record<string, string>[]): Record<string, string>[] {
  return raws.map((raw) => {
    const rec: Record<string, string> = {};
    for (const [header, value] of Object.entries(raw)) {
      const field = HEADER_MAP[normalizeHeader(header)] ?? header;
      let v = (value ?? "").trim();
      // XLSX stores dates as day serials — convert plausible serials on date fields.
      if ((field === "invoiceDate" || field === "dueDate") && /^\d{4,6}(\.0+)?$/.test(v)) {
        const n = Number(v);
        if (n > 20000 && n < 80000) v = excelSerialToISO(n);
      }
      rec[field] = v;
    }
    return rec;
  });
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

// --- minimal dependency-free XLSX reader ------------------------------------
// An .xlsx is a zip of XML parts. We read the central directory, inflate
// xl/sharedStrings.xml + the first worksheet with DecompressionStream, and
// resolve shared-string cells. Enough for flat ERP export sheets.

async function inflateEntry(buf: ArrayBuffer, offset: number, compressedSize: number, method: number): Promise<Uint8Array> {
  const view = new DataView(buf);
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error("bad zip local header");
  const nameLen = view.getUint16(offset + 26, true);
  const extraLen = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLen + extraLen;
  const bytes = new Uint8Array(buf, start, compressedSize);
  if (method === 0) return bytes.slice();
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipParts(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buf);
  // Find End Of Central Directory (scan backwards for its signature).
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .xlsx (no zip directory)");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // central directory offset
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    if (want(name)) out.set(name, await inflateEntry(buf, localOffset, compressedSize, method));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function parseXlsx(buf: ArrayBuffer): Promise<Record<string, string>[]> {
  const parts = await unzipParts(buf, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const dec = new TextDecoder();
  const xml = (bytes: Uint8Array) => new DOMParser().parseFromString(dec.decode(bytes), "application/xml");
  const shared: string[] = [];
  const ss = parts.get("xl/sharedStrings.xml");
  if (ss) for (const si of Array.from(xml(ss).getElementsByTagName("si"))) {
    shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
  }
  const sheetName = [...parts.keys()].filter((n) => n.startsWith("xl/worksheets/")).sort()[0];
  if (!sheetName) throw new Error("no worksheet found in the .xlsx");
  const sheet = xml(parts.get(sheetName)!);
  const grid: string[][] = [];
  for (const row of Array.from(sheet.getElementsByTagName("row"))) {
    const cells: string[] = [];
    for (const c of Array.from(row.getElementsByTagName("c"))) {
      // Column index from the cell ref (e.g. "C7" → 2) so blanks don't shift columns.
      const col = (c.getAttribute("r") ?? "").replace(/\d+/g, "").split("").reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
      const t = c.getAttribute("t");
      let v = "";
      if (t === "inlineStr") v = Array.from(c.getElementsByTagName("t")).map((x) => x.textContent ?? "").join("");
      else {
        v = c.getElementsByTagName("v")[0]?.textContent ?? "";
        if (t === "s" && v !== "") v = shared[Number(v)] ?? "";
      }
      cells[col >= 0 ? col : cells.length] = v;
    }
    grid.push(cells);
  }
  const headers = (grid[0] ?? []).map((h) => (h ?? "").trim());
  if (headers.filter(Boolean).length === 0) throw new Error("the sheet has no header row");
  return grid.slice(1)
    .filter((r) => r.some((v) => (v ?? "").trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]).filter(([h]) => h !== "")));
}

/** Local validation: required fields, schema patterns, positive amount, ERP status gate. */
function validate(rec: Record<string, string>, useCase: UseCase): string[] {
  const problems: string[] = [];
  for (const field of INVOICE_FIELDS) {
    const value = (rec[field] ?? "").trim();
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
  const amount = Number(rec.amount);
  if (rec.amount && (!Number.isFinite(amount) || amount <= 0)) problems.push("amount must be a positive number");
  // Only ERP-'Available' invoices are eligible — financed/paid ones must not re-tokenize.
  const erpStatus = (rec.status ?? "").trim();
  if (erpStatus && erpStatus.toLowerCase() !== "available") problems.push(`status '${erpStatus}' — only Available invoices tokenize`);
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
  const [holder, setHolder] = useState("");
  const [parValue, setParValue] = useState("1");
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

  /** Turn raw {header: value} rows into previewed, locally-validated ImportRows. Shared by file upload + ERP sample. */
  async function ingest(raws: Record<string, string>[], sourceName: string): Promise<void> {
    setFileName(sourceName);
    setParseError(null);
    setRows([]);
    setDone(false);
    try {
      if (raws.length === 0) throw new Error("No invoice rows found");
      const parsedRows = canonicalize(raws).map((rec): ImportRow => {
        const problems = validate(rec, useCase);
        return {
          invoiceNumber: (rec.invoiceNumber ?? "").trim(),
          invoiceDate: (rec.invoiceDate ?? "").trim(),
          buyerName: (rec.buyerName ?? "").trim(),
          currency: (rec.currency ?? "").trim().toUpperCase(),
          amount: (rec.amount ?? "").trim(),
          dueDate: (rec.dueDate ?? "").trim(),
          erpStatus: (rec.status ?? "").trim(),
          invoiceDocUrl: (rec.invoiceDocUrl ?? "").trim(),
          problems,
          status: problems.length === 0 ? "pending" : "invalid",
        };
      });
      setRows(parsedRows);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Could not parse the invoices");
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      let raws: Record<string, string>[];
      if (/\.xlsx$/i.test(file.name)) {
        raws = await parseXlsx(await file.arrayBuffer());
      } else if (/\.json$/i.test(file.name)) {
        const parsed: unknown = JSON.parse(await file.text());
        if (!Array.isArray(parsed)) throw new Error("JSON must be an array of invoice objects");
        raws = parsed.map((o) => {
          const rec: Record<string, string> = {};
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) rec[k] = v == null ? "" : String(v).trim();
          return rec;
        });
      } else {
        raws = parseCsv(await file.text());
      }
      await ingest(raws, file.name);
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
    if (!token || !holder || !chainId) return;
    setBusy(true);
    setDone(false);
    let anyMinted = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.status === "invalid" || row.status === "tokenized" || row.status === "duplicate") continue;
      patchRow(i, { status: "working", message: undefined });
      // Fractionalize the face value into ERC-20 units minted to the holder.
      const supply = supplyFor(row.amount, parValue);
      const metadata: Record<string, unknown> = {
        invoiceNumber: row.invoiceNumber,
        invoiceDate: row.invoiceDate,
        buyerName: row.buyerName,
        currency: row.currency,
        amount: Number(row.amount),
        dueDate: row.dueDate,
        ...(row.erpStatus ? { status: row.erpStatus } : {}),
        ...(row.invoiceDocUrl ? { invoiceDocUrl: row.invoiceDocUrl } : {}),
        // invoiceHash intentionally omitted — the server derives it.
      };
      try {
        await api.issue(token, {
          useCaseKey: useCase.key,
          name: `${row.invoiceNumber} · ${row.buyerName}`,
          chainId,
          initialSupply: String(supply),
          treasuryAccount: holder,
          metadata,
        });
        patchRow(i, { status: "tokenized", message: undefined });
        anyMinted = true;
      } catch (err) {
        if (err instanceof ApiError && err.code === "DUPLICATE_ASSET") {
          patchRow(i, { status: "duplicate", message: "already tokenized" });
        } else {
          patchRow(i, { status: "error", message: err instanceof ApiError ? err.message : "request failed" });
        }
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
    () => "data:text/csv;charset=utf-8," + encodeURIComponent(ERP_SAMPLE_CSV + "\n"),
    [],
  );

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
        <div>
          <h2 className="font-semibold text-slate-900">Import invoices — ERP export or file upload</h2>
          <p className="text-xs text-slate-500 mt-1">
            Upload the ERP invoice template (<span className="font-medium text-slate-700">.xlsx</span>, CSV, or JSON) or load
            the built-in sample. Only <span className="font-medium text-slate-700">Available</span> invoices are eligible; each
            is tokenized into <span className="font-medium text-slate-700">round(amount ÷ par)</span> fungible units minted to
            the holder. The server derives each invoice's canonical fingerprint and rejects an already-tokenized invoice —
            even if it arrived through another channel.
          </p>
          <button
            type="button"
            onClick={() => void ingest(parseCsv(ERP_SAMPLE_CSV), "ERP export (sample)")}
            disabled={busy}
            className="mt-2 rounded-lg border border-brand-600 text-brand-700 px-3 py-1.5 text-xs font-medium hover:bg-brand-50 disabled:opacity-50"
          >
            Load ERP sample export
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Or upload invoice file</span>
            <input
              type="file"
              accept=".xlsx,.csv,.json"
              onChange={(e) => void handleFile(e)}
              disabled={busy}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:text-white file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-brand-700 file:cursor-pointer"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Holder (issue to)</span>
            <select className="select" value={holder} onChange={(e) => setHolder(e.target.value)} disabled={busy}>
              <option value="">Select account…</option>
              {accounts.map((a) => (
                <option key={a.address} value={a.address}>{a.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Par value per token (₹)</span>
            <input
              className="input"
              type="number"
              min="1"
              step="1"
              value={parValue}
              onChange={(e) => setParValue(e.target.value)}
              disabled={busy}
            />
            <span className="block text-[11px] text-slate-400 mt-1">supply per invoice = round(amount ÷ par)</span>
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
          Template columns: <span className="font-mono">{TEMPLATE_HEADERS.join(" · ")}</span>{" "}
          <a href={sampleCsvHref} download="invoices-template.csv" className="text-brand-600 hover:underline">
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
              disabled={busy || pending === 0 || !holder || !chainId}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Tokenizing…" : `Tokenize ${pending} invoice${pending === 1 ? "" : "s"}`}
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Invoice</th>
                <th className="text-left font-medium px-4 py-2.5">Buyer</th>
                <th className="text-right font-medium px-4 py-2.5">Amount</th>
                <th className="text-right font-medium px-4 py-2.5">Tokens</th>
                <th className="text-left font-medium px-4 py-2.5">Due date</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => (
                <tr key={`${r.invoiceNumber}-${i}`} className={r.status === "invalid" ? "bg-red-50/40" : undefined}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">
                    {r.invoiceNumber || <span className="text-slate-300">—</span>}
                    {r.invoiceDate && <div className="text-[11px] font-normal text-slate-400">{r.invoiceDate}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{r.buyerName || "?"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">{r.amount ? `${Number(r.amount).toLocaleString("en-IN")} ${r.currency}` : "—"}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                    {r.status === "invalid" || !r.amount ? "—" : supplyFor(r.amount, parValue).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{r.dueDate || "—"}</td>
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
