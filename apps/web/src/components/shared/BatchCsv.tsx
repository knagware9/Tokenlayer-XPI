import { useMemo, useState } from "react";
import { ApiError } from "../../api.js";
import { parseCsv } from "../../lib/csv.js";

// ============================================================================
// BatchCsv — a generic "upload a CSV, review it, submit as one batch
// proposal" surface shared by CSV-driven onboarding (UserManagement) and
// batch credential issuance (IssueUsecaseCredential). The caller supplies the
// expected headers, an optional row coercer/validator, and the submit call;
// this component owns parsing, the template download, the review table, and
// rendering both client-side row errors and the server's BATCH_INVALID
// per-row problems.
// ============================================================================

const PREVIEW_LIMIT = 50;

export function BatchCsv(props: {
  title: string;
  requiredHeaders: string[];
  optionalHeaders?: string[];
  /** Suggested filename for the downloadable CSV template, e.g. "holders-template.csv". */
  templateName: string;
  /** Maps one parsed CSV row (string cells) to the shape `onSubmit` expects. Identity when omitted. */
  coerceRow?: (row: Record<string, string>) => Record<string, unknown>;
  /** Client-side row check, run after coercion. A non-null return flags the row and blocks submit. */
  validateRow?: (row: Record<string, unknown>) => string | null;
  onSubmit: (rows: Record<string, unknown>[]) => Promise<{ proposalId: string }>;
}): JSX.Element {
  const { title, requiredHeaders, optionalHeaders = [], templateName, coerceRow, validateRow, onSubmit } = props;

  const allHeaders = useMemo(() => [...requiredHeaders, ...optionalHeaders], [requiredHeaders, optionalHeaders]);
  const headerLineDisplay = useMemo(
    () => [...requiredHeaders, ...optionalHeaders.map((h) => `${h} (optional)`)].join(", "),
    [requiredHeaders, optionalHeaders],
  );
  const templateHref = useMemo(
    () => "data:text/csv;charset=utf-8," + encodeURIComponent(allHeaders.join(",") + "\n"),
    [allHeaders],
  );

  const [fileName, setFileName] = useState<string | null>(null);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [rowErrors, setRowErrors] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rowProblems, setRowProblems] = useState<{ index: number; error: string }[] | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  function reset(): void {
    setHeaderError(null);
    setRawRows([]);
    setRows([]);
    setRowErrors([]);
    setSubmitError(null);
    setRowProblems(null);
    setSuccessNote(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file after a fix
    reset();
    if (!file) { setFileName(null); return; }
    setFileName(file.name);
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const headers = lines[0] ? lines[0].split(",").map((h) => h.trim()) : [];
    const missing = requiredHeaders.filter((h) => !headers.includes(h));
    if (missing.length > 0) {
      setHeaderError(`Missing required column(s): ${missing.join(", ")}. Expected: ${headerLineDisplay}`);
      return;
    }
    const parsed = parseCsv(text);
    if (parsed.length === 0) {
      setHeaderError("No data rows found in the file.");
      return;
    }
    setRawRows(parsed);
    const coerced = parsed.map((r) => (coerceRow ? coerceRow(r) : (r as Record<string, unknown>)));
    setRows(coerced);
    setRowErrors(coerced.map((r) => (validateRow ? validateRow(r) : null)));
  }

  const invalidCount = rowErrors.filter((e) => e !== null).length;
  const invalidBeyondPreview = rowErrors.slice(PREVIEW_LIMIT).filter((e) => e !== null).length;
  const hasClientInvalid = invalidCount > 0;
  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]!) : [];
  const preview = rows.slice(0, PREVIEW_LIMIT);

  async function submit(): Promise<void> {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    setSubmitError(null);
    setRowProblems(null);
    setSuccessNote(null);
    try {
      const r = await onSubmit(rows);
      setSuccessNote(`Submitted — pending approval (proposal ${r.proposalId.slice(0, 8)}…)`);
      setFileName(null);
      setRawRows([]);
      setRows([]);
      setRowErrors([]);
    } catch (err) {
      if (err instanceof ApiError && err.code === "BATCH_INVALID" && err.rowProblems) {
        setRowProblems(err.rowProblems);
        setSubmitError(err.message);
      } else {
        setSubmitError(err instanceof ApiError ? err.message : "Submit failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
      <h2 className="font-semibold text-slate-900">{title}</h2>

      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 space-y-1.5">
        <div>
          Expected columns: <span className="font-mono text-slate-800">{headerLineDisplay}</span>
        </div>
        <a
          href={templateHref}
          download={templateName}
          className="inline-block text-brand-600 hover:text-brand-700 font-medium"
        >
          Download CSV template
        </a>
      </div>

      <div>
        <input type="file" accept=".csv" onChange={(e) => void onFile(e)} className="text-sm" />
        {fileName && <span className="ml-2 text-xs text-slate-500">{fileName}</span>}
      </div>

      {headerError && <p className="text-sm text-red-600">{headerError}</p>}

      {rows.length > 0 && (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="text-[11px] text-slate-500 bg-slate-50 uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-2">#</th>
                  {columns.map((c) => <th key={c} className="text-left font-medium px-3 py-2">{c}</th>)}
                  <th className="text-left font-medium px-3 py-2">Issue</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((_, i) => {
                  const err = rowErrors[i];
                  return (
                    <tr key={i} className={`border-t border-slate-100 ${err ? "bg-red-50" : ""}`}>
                      <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                      {columns.map((c) => <td key={c} className="px-3 py-1.5 text-slate-700">{rawRows[i]?.[c] ?? ""}</td>)}
                      <td className="px-3 py-1.5 text-red-600">{err ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">
            {rows.length} rows total{rows.length > PREVIEW_LIMIT ? ` (showing first ${PREVIEW_LIMIT})` : ""}
            {invalidCount > 0 && (
              <span className="text-red-600">
                {" — "}{invalidCount} invalid row{invalidCount === 1 ? "" : "s"}
                {invalidBeyondPreview > 0 ? ` (${invalidBeyondPreview} beyond the preview)` : ""}
              </span>
            )}
          </p>
        </div>
      )}

      {submitError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <div className="font-medium">{submitError}</div>
          {rowProblems && rowProblems.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-xs">
              {rowProblems.map((p) => <li key={p.index}>row #{p.index + 1}: {p.error}</li>)}
            </ul>
          )}
        </div>
      )}
      {successNote && <p className="text-sm text-emerald-600">{successNote}</p>}

      <button
        onClick={() => void submit()}
        disabled={rows.length === 0 || hasClientInvalid || busy}
        className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
      >
        {busy ? "Submitting…" : `Submit ${rows.length} rows`}
      </button>
    </div>
  );
}
