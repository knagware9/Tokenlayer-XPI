import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { ChainInfo, InvoiceRowResult, StagedInvoice, TokenizeResult, UseCase } from "../../types.js";
import { Card, EmptyState, Pill, SectionHeader } from "../shared/ui.js";
import { parseCsv } from "../../lib/shared/csv.js";
import { isInvoiceUseCase } from "./AssetManagement.js";

// ============================================================================
// Asset Register — the server-side staging table for ANY use case. Rows arrive
// from three sources (file upload, an ERP pull, or a manual add), land as
// `staged` rows, and are selectively tokenized. The client parses uploaded
// files into field-mapped rows; the SERVER re-validates, fingerprints and
// dedupes, so the parsers here only map headers → canonical fields.
//
// The canonical invoice use case is a special case throughout this file
// (`isInvoiceUC`): "Pull from ERP" is meaningful only for it (the bundled
// export is invoice-shaped), and it fractionalizes its own `amount` field
// into round(amount ÷ par) units per row on tokenize — every other use case
// mints a caller-stated `initialSupply` per row (default 1).
// ============================================================================

const INVOICE_FIELDS = ["invoiceNumber", "invoiceDate", "buyerName", "currency", "amount", "dueDate"] as const;

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

/** Excel serial date (days since 1899-12-30) → YYYY-MM-DD. */
function excelSerialToISO(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000).toISOString().slice(0, 10);
}

/** Map raw {header: value} objects to canonical-field records via HEADER_MAP —
 * the invoice-specific header aliases — falling back to a case/punctuation-
 * insensitive match against the target use case's OWN metadata field names
 * (so "Project Name" in a CSV lands on a carbon-credit asset's `projectName`),
 * and finally the raw header verbatim when neither matches. Converts Excel
 * date serials on the two invoice date fields. */
function canonicalize(raws: Record<string, string>[], schemaFields: readonly string[] = []): Record<string, string>[] {
  const bySchema = new Map(schemaFields.map((f) => [normalizeHeader(f), f]));
  return raws.map((raw) => {
    const rec: Record<string, string> = {};
    for (const [header, value] of Object.entries(raw)) {
      const norm = normalizeHeader(header);
      const field = HEADER_MAP[norm] ?? bySchema.get(norm) ?? header;
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

/** Canonical fingerprint — MUST match core invoiceFingerprint + scripts/erp-import.mjs.
 * Kept here (rather than in the deleted InvoiceImport) so IssuePanel can live-preview it. */
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

const SOURCE_TONE: Record<StagedInvoice["source"], "info" | "muted" | "ok"> = {
  upload: "info", erp: "muted", manual: "ok",
};

const btn = "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50";
const btnPrimary = `${btn} bg-brand-600 text-white hover:bg-brand-700`;
const btnGhost = `${btn} border border-slate-200 text-slate-700 hover:bg-slate-50`;

interface Props {
  useCase: UseCase;
  chains: ChainInfo[];
}

export function InvoiceRegister({ useCase, chains }: Props): JSX.Element {
  const { token } = useAuth();
  const key = useCase.key;
  const isInvoiceUC = isInvoiceUseCase(useCase);
  const schemaFields = useMemo(() => Object.keys(useCase.metadataSchema.properties ?? {}), [useCase]);
  // field name -> its JSON-schema `type`, so the add-row form coerces (and renders
  // a number input for) any numeric field the use case declares, not only "amount".
  const fieldTypes = useMemo(() => {
    const props = useCase.metadataSchema.properties ?? {};
    return Object.fromEntries(Object.entries(props).map(([f, p]) => [f, p.type]));
  }, [useCase]);
  const [rows, setRows] = useState<StagedInvoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<InvoiceRowResult[] | null>(null);
  const [tokenizeResults, setTokenizeResults] = useState<TokenizeResult[] | null>(null);
  const [showTokenize, setShowTokenize] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Chains the use case has DEPLOYED a contract on; fall back to allowed chains
  // when nothing is deployed yet so the tokenize form still has options.
  const chainIds = useMemo(() => {
    const deployed = Object.keys(useCase.contracts ?? {});
    return deployed.length > 0 ? deployed : useCase.allowedChainIds;
  }, [useCase]);
  const chainLabel = (id: string): string => chains.find((c) => c.id === id)?.label ?? id;

  // Add-row form fields: the use case's required fields (minus any the server
  // derives, e.g. invoiceHash) — else the invoice fields for the invoice use
  // case specifically, else every field the schema declares.
  const addFields = useMemo(() => {
    const required = useCase.metadataSchema.required;
    const derived = useCase.derivedFields ?? {};
    const base = required && required.length > 0 ? required : isInvoiceUC ? [...INVOICE_FIELDS] : schemaFields;
    return base.filter((f) => !(f in derived));
  }, [useCase, isInvoiceUC, schemaFields]);
  // The register table's generic columns — capped at 3 so the table doesn't
  // sprawl sideways for a use case with a large metadata schema.
  const previewFields = useMemo(() => addFields.slice(0, 3), [addFields]);

  const reload = async (): Promise<void> => {
    if (!token) return;
    try {
      const list = await api.invoices(token, key);
      setRows(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the invoice register");
    }
  };

  useEffect(() => {
    void reload();
    setSelected(new Set());
    setShowTokenize(false);
    setShowAdd(false);
    setNotice(null);
    setImportResults(null);
    setTokenizeResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);

  const stagedIds = useMemo(() => rows.filter((r) => r.status === "staged").map((r) => r.id), [rows]);
  const allStagedSelected = stagedIds.length > 0 && stagedIds.every((id) => selected.has(id));

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll(): void {
    setSelected(allStagedSelected ? new Set() : new Set(stagedIds));
  }

  async function pullErp(): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNotice(null); setTokenizeResults(null);
    try {
      const res = await api.pullErpInvoices(token, key);
      setImportResults(res.results);
      setNotice(`${res.staged} invoice(s) staged from ERP`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ERP pull failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file || !token) { e.target.value = ""; return; }
    setBusy(true); setError(null); setNotice(null); setTokenizeResults(null);
    try {
      let rawRows: Record<string, string>[];
      if (/\.xlsx$/i.test(file.name)) {
        rawRows = canonicalize(await parseXlsx(await file.arrayBuffer()), schemaFields);
      } else if (/\.json$/i.test(file.name)) {
        const parsed: unknown = JSON.parse(await file.text());
        if (!Array.isArray(parsed)) throw new Error("JSON must be an array of row objects");
        const raws = parsed.map((o) => {
          const rec: Record<string, string> = {};
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) rec[k] = v == null ? "" : String(v).trim();
          return rec;
        });
        rawRows = canonicalize(raws, schemaFields);
      } else {
        rawRows = canonicalize(parseCsv(await file.text()), schemaFields);
      }
      if (rawRows.length === 0) throw new Error("No rows found in the file");
      const res = await api.importInvoices(token, key, rawRows);
      setImportResults(res.results);
      setNotice(`${res.staged} row(s) staged from ${file.name}`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not import the file");
    } finally {
      setBusy(false);
      e.target.value = ""; // allow re-selecting the same file
    }
  }

  async function deleteInvoice(id: string): Promise<void> {
    if (!token) return;
    setError(null);
    try {
      await api.deleteInvoice(token, key, id);
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the invoice");
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={isInvoiceUC ? "Invoice register" : "Asset register"}
        description={`Stage ${isInvoiceUC ? "invoices" : "asset data"} from a file upload${isInvoiceUC ? ", an ERP pull," : ""} or a manual entry — then select and tokenize them. The server fingerprints and de-duplicates every row.`}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {isInvoiceUC && (
          <button type="button" className={btnGhost} disabled={busy} onClick={() => void pullErp()}>
            {busy ? "Working…" : "Pull from ERP"}
          </button>
        )}
        <button type="button" className={btnGhost} disabled={busy} onClick={() => fileRef.current?.click()}>
          Upload CSV/XLSX
        </button>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.json" className="hidden" onChange={(e) => void handleFile(e)} />
        <button type="button" className={btnGhost} disabled={busy} onClick={() => { setShowAdd((v) => !v); setShowTokenize(false); }}>
          {isInvoiceUC ? "Add invoice" : "Add row"}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || selected.size === 0}
          onClick={() => { setShowTokenize((v) => !v); setShowAdd(false); }}
        >
          Tokenize selected ({selected.size})
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      {importResults && importResults.some((r) => r.status !== "staged") && (
        <div className="text-xs text-slate-500 space-y-0.5">
          {importResults.filter((r) => r.status !== "staged").map((r) => (
            <div key={r.index}>
              Row {r.index + 1}: <span className={r.status === "duplicate" ? "text-amber-700" : "text-red-600"}>{r.status}</span>
              {r.error ? ` — ${r.error}` : ""}
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddInvoiceForm fields={addFields} fieldTypes={fieldTypes} isInvoiceUC={isInvoiceUC} onClose={() => setShowAdd(false)} onAdded={(msg) => { setShowAdd(false); setNotice(msg); void reload(); }} useCaseKey={key} />}

      {showTokenize && (
        <TokenizeForm
          count={selected.size}
          isInvoiceUC={isInvoiceUC}
          chainIds={chainIds}
          chainLabel={chainLabel}
          defaultChainId={useCase.defaultChainId}
          saleDefault={useCase.saleTermsDefault}
          onClose={() => setShowTokenize(false)}
          onSubmit={async (body) => {
            if (!token) return;
            setBusy(true); setError(null); setNotice(null); setImportResults(null);
            try {
              const res = await api.tokenizeInvoices(token, key, { ids: [...selected], ...body });
              setTokenizeResults(res.results);
              const ok = res.results.filter((r) => r.status === "tokenized").length;
              const pending = res.results.filter((r) => r.status === "pending_approval").length;
              setNotice(
                `${ok} of ${res.results.length} row(s) tokenized` +
                  (pending > 0 ? `, ${pending} awaiting a second approval before minting` : ""),
              );
              setSelected(new Set());
              setShowTokenize(false);
              await reload();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Tokenization failed");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {tokenizeResults && (
        <div className="text-xs text-slate-500 space-y-0.5">
          {tokenizeResults.map((r) => (
            <div key={r.id}>
              <span className="font-mono text-slate-400">{r.id.slice(0, 8)}…</span>{" "}
              <span className={r.status === "tokenized" ? "text-emerald-700" : r.status === "pending_approval" || r.status === "skipped" ? "text-amber-700" : "text-red-600"}>{r.status}</span>
              {r.assetId ? ` → ${r.assetId}` : ""}{r.error ? ` — ${r.error}` : ""}
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            icon="doc"
            title={isInvoiceUC ? "No invoices staged" : "No rows staged"}
            hint={`${isInvoiceUC ? "Pull from ERP, upload" : "Upload"} a CSV/XLSX, or add a${isInvoiceUC ? "n invoice" : " row"} manually to get started.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2.5 w-8">
                    <input type="checkbox" checked={allStagedSelected} disabled={stagedIds.length === 0} onChange={toggleAll} aria-label="Select all staged" />
                  </th>
                  {isInvoiceUC ? (
                    <>
                      <th className="text-left font-medium px-4 py-2.5">Invoice</th>
                      <th className="text-left font-medium px-4 py-2.5">Buyer</th>
                      <th className="text-right font-medium px-4 py-2.5">Amount</th>
                      <th className="text-left font-medium px-4 py-2.5">Due date</th>
                    </>
                  ) : (
                    previewFields.map((f) => <th key={f} className="text-left font-medium px-4 py-2.5">{f}</th>)
                  )}
                  <th className="text-left font-medium px-4 py-2.5">Source</th>
                  <th className="text-left font-medium px-4 py-2.5">Hash</th>
                  <th className="text-left font-medium px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const m = r.metadata;
                  const amount = m.amount != null && m.amount !== "" ? Number(m.amount) : null;
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5">
                        {r.status === "staged" && (
                          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${String(m.invoiceNumber ?? r.id)}`} />
                        )}
                      </td>
                      {isInvoiceUC ? (
                        <>
                          <td className="px-4 py-2.5 font-medium text-slate-800">
                            {String(m.invoiceNumber ?? "—")}
                            {m.invoiceDate ? <div className="text-[11px] font-normal text-slate-400">{String(m.invoiceDate)}</div> : null}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-600">{String(m.buyerName ?? "—")}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                            {amount != null && Number.isFinite(amount) ? `${amount.toLocaleString("en-IN")} ${String(m.currency ?? "")}`.trim() : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-600">{m.dueDate ? String(m.dueDate) : "—"}</td>
                        </>
                      ) : (
                        previewFields.map((f) => <td key={f} className="px-4 py-2.5 text-xs text-slate-700">{m[f] != null && m[f] !== "" ? String(m[f]) : "—"}</td>)
                      )}
                      <td className="px-4 py-2.5"><Pill tone={SOURCE_TONE[r.source]}>{r.source}</Pill></td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400" title={r.invoiceHash}>{r.invoiceHash.slice(0, 10)}…</td>
                      <td className="px-4 py-2.5">
                        <Pill tone={r.status === "tokenized" ? "ok" : "warn"}>{r.status}</Pill>
                        {r.status === "tokenized" && r.assetId ? (
                          <div className="text-[11px] font-mono text-slate-400 mt-0.5 max-w-[12rem] truncate" title={r.assetId}>{r.assetId}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {r.status === "staged" && (
                          <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => void deleteInvoice(r.id)}>Delete</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AddInvoiceForm({ fields, fieldTypes, isInvoiceUC, useCaseKey, onClose, onAdded }: {
  fields: string[];
  fieldTypes: Record<string, string>;
  isInvoiceUC: boolean;
  useCaseKey: string;
  onClose: () => void;
  onAdded: (msg: string) => void;
}): JSX.Element {
  const { token } = useAuth();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNumberField = (f: string): boolean => (isInvoiceUC && f === "amount") || fieldTypes[f] === "number";

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token) return;
    setBusy(true); setError(null);
    const metadata: Record<string, unknown> = {};
    for (const f of fields) {
      const v = (values[f] ?? "").trim();
      metadata[f] = isNumberField(f) ? Number(v) : fieldTypes[f] === "boolean" ? v === "true" : v;
    }
    try {
      const inv = await api.addInvoice(token, useCaseKey, metadata);
      onAdded(isInvoiceUC ? `Invoice ${String(inv.metadata.invoiceNumber ?? inv.id)} staged` : `Row ${inv.id.slice(-6)} staged`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the row");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={isInvoiceUC ? "Add an invoice" : "Add a row"} actions={<button type="button" className="text-xs text-slate-500 hover:underline" onClick={onClose}>Cancel</button>}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {fields.map((f) => (
            <label key={f} className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">{f}</span>
              <input
                className="input"
                type={isNumberField(f) ? "number" : "text"}
                value={values[f] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f]: e.target.value }))}
                disabled={busy}
              />
            </label>
          ))}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className={btnPrimary} disabled={busy}>{busy ? "Adding…" : isInvoiceUC ? "Add invoice" : "Add row"}</button>
      </form>
    </Card>
  );
}

function TokenizeForm({ count, isInvoiceUC, chainIds, chainLabel, defaultChainId, saleDefault, onClose, onSubmit }: {
  count: number;
  isInvoiceUC: boolean;
  chainIds: string[];
  chainLabel: (id: string) => string;
  defaultChainId: string;
  saleDefault?: { unitPrice?: string; currency?: string };
  onClose: () => void;
  onSubmit: (body: { chainId: string; parValue?: number; initialSupply?: string; sale?: { unitPrice: string; currency: string } }) => Promise<void>;
}): JSX.Element {
  const { token } = useAuth();
  const [chainId, setChainId] = useState(chainIds.includes(defaultChainId) ? defaultChainId : chainIds[0] ?? "");
  const [parValue, setParValue] = useState("1000");
  const [initialSupply, setInitialSupply] = useState("1");
  const [listForSale, setListForSale] = useState(false);
  const [unitPrice, setUnitPrice] = useState(saleDefault?.unitPrice ?? "");
  const [currency, setCurrency] = useState(saleDefault?.currency ?? "");
  const [availCurrencies, setAvailCurrencies] = useState<{ code: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const noun = isInvoiceUC ? "invoice" : "row";

  useEffect(() => {
    if (!token) return;
    void api.currencies(token).then(setAvailCurrencies).catch(() => {});
  }, [token]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!chainId) return;
    setBusy(true);
    const par = Number(parValue);
    await onSubmit({
      chainId,
      ...(isInvoiceUC
        ? (Number.isFinite(par) && par > 0 ? { parValue: par } : {})
        : (initialSupply.trim() ? { initialSupply: initialSupply.trim() } : {})),
      ...(listForSale && unitPrice.trim() && currency.trim() ? { sale: { unitPrice: unitPrice.trim(), currency: currency.trim() } } : {}),
    });
    setBusy(false);
  }

  return (
    <Card title={`Tokenize ${count} ${noun}${count === 1 ? "" : "s"}`} actions={<button type="button" className="text-xs text-slate-500 hover:underline" onClick={onClose}>Cancel</button>}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Chain / DLT</span>
            <select className="select" value={chainId} onChange={(e) => setChainId(e.target.value)} disabled={busy}>
              {chainIds.length === 0 && <option value="">No deployed chain</option>}
              {chainIds.map((id) => <option key={id} value={id}>{chainLabel(id)}</option>)}
            </select>
          </label>
          {isInvoiceUC ? (
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Par value per token</span>
              <input className="input" type="number" min="1" step="1" value={parValue} onChange={(e) => setParValue(e.target.value)} disabled={busy} />
              <span className="block text-[11px] text-slate-400 mt-1">supply per invoice = round(amount ÷ par)</span>
            </label>
          ) : (
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Supply per row</span>
              <input className="input" type="number" min="1" step="1" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} disabled={busy} />
              <span className="block text-[11px] text-slate-400 mt-1">minted to the use case's treasury, same amount for every selected row</span>
            </label>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={listForSale} onChange={(e) => setListForSale(e.target.checked)} disabled={busy} />
          List for primary sale
        </label>
        {listForSale && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Unit price</span>
              <input className="input" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} disabled={busy} />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Currency</span>
              <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy}>
                <option value="">Currency…</option>
                {availCurrencies.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </label>
          </div>
        )}
        <button type="submit" className={btnPrimary} disabled={busy || !chainId}>
          {busy ? "Tokenizing…" : `Tokenize ${count} ${noun}${count === 1 ? "" : "s"}`}
        </button>
      </form>
    </Card>
  );
}
