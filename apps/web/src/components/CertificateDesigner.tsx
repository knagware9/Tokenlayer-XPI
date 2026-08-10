import { useRef, useState } from "react";
import {
  addPlacement, clampFontSize, fieldLabel, movePlacement, paletteFields, removePlacement, stalePlacementFields,
} from "../lib/certificate-layout.js";
import {
  MAX_CERTIFICATE_PLACEMENTS,
  type CertificateAlign,
  type CertificateFieldPlacement,
  type CertificateFont,
} from "../types.js";

export interface CertificateDesignerProps {
  backgroundDocumentId: string | null;
  placements: CertificateFieldPlacement[];
  /** Claim keys of the credential type being edited. */
  claimKeys: string[];
  onChange: (next: CertificateFieldPlacement[]) => void;
  onUploadArtwork: (file: File) => void;
  onPreview: () => void;
  /** Authenticated artwork URL; the document route needs a bearer token, so the
   *  builder passes an object URL it fetched rather than a bare src. */
  artworkObjectUrl: string | null;
}

/**
 * EN-F: place credential fields on uploaded artwork by dragging them.
 *
 * This component holds selection and drag state and renders; every calculation
 * comes from `lib/certificate-layout.ts`, which is where the rules the server
 * enforces are mirrored and unit-tested (apps/web has no DOM test environment,
 * so the rendering itself is verified in the browser).
 */
export function CertificateDesigner(props: CertificateDesignerProps): JSX.Element {
  const { placements, claimKeys, onChange } = props;
  const [selected, setSelected] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  const patch = (i: number, next: Partial<CertificateFieldPlacement>): void =>
    onChange(placements.map((p, n) => (n === i ? { ...p, ...next } : p)));

  const onPointerMove = (e: React.PointerEvent): void => {
    const i = dragRef.current;
    const box = canvasRef.current?.getBoundingClientRect();
    if (i === null || !box) return;
    onChange(movePlacement(placements, i, { clientX: e.clientX, clientY: e.clientY }, box));
  };

  const sel = selected !== null ? placements[selected] : undefined;
  const atCap = placements.length >= MAX_CERTIFICATE_PLACEMENTS;
  const stale = stalePlacementFields(placements, claimKeys);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-[11px] text-slate-600">
          Artwork:
          <input type="file" accept="image/png,image/jpeg,image/webp" className="ml-2 text-[11px]"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) props.onUploadArtwork(f); }} />
        </label>
        {props.backgroundDocumentId && <span className="text-[11px] text-emerald-600">✓ uploaded</span>}
        <button type="button" onClick={props.onPreview}
          className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] font-medium hover:bg-slate-50">
          Preview PDF
        </button>
      </div>

      <p className="text-[11px] text-slate-500">
        This canvas is an approximation — the browser lays text out differently from the PDF renderer.
        Use <strong>Preview PDF</strong> to see exactly what prints.
      </p>

      {/* A claim can be renamed or deleted after it has been placed, which leaves
          the placement pointing at nothing. Saving drops these rather than
          letting the server refuse the whole use case, so say so here. */}
      {stale.length > 0 && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          {stale.length === 1 ? "A placed field references" : "Placed fields reference"} a claim this credential
          type no longer defines ({stale.join(", ")}). {stale.length === 1 ? "It" : "They"} will not be saved —
          remove {stale.length === 1 ? "it" : "them"} below, or restore the claim.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {paletteFields(claimKeys, placements).map((f) => (
          <button type="button" key={f} disabled={atCap}
            onClick={() => { onChange(addPlacement(placements, f)); setSelected(placements.length); }}
            className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40">
            {fieldLabel(f)}
          </button>
        ))}
      </div>
      {atCap && (
        <p className="text-[11px] text-slate-500">
          {MAX_CERTIFICATE_PLACEMENTS} placements is the maximum — remove one to place another.
        </p>
      )}

      <div ref={canvasRef} data-testid="certificate-canvas"
        onPointerMove={onPointerMove}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerLeave={() => { dragRef.current = null; }}
        className="relative w-full select-none overflow-hidden rounded border border-slate-300 bg-slate-100"
        style={{ minHeight: 240 }}>
        {props.artworkObjectUrl
          ? <img src={props.artworkObjectUrl} alt="" className="block w-full" />
          : <div className="flex h-60 items-center justify-center text-xs text-slate-400">Upload artwork to place fields on it</div>}
        {placements.map((p, i) => (
          <div key={`${p.field}-${i}`} data-testid={`placement-${i}`}
            onPointerDown={(e) => { e.preventDefault(); dragRef.current = i; setSelected(i); }}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, color: p.color ?? "#0f172a", fontSize: `${p.fontSize ?? 11}px` }}
            className={`absolute cursor-move whitespace-nowrap rounded bg-white/70 px-1 ${selected === i ? "ring-2 ring-brand-500" : "ring-1 ring-slate-300"}`}>
            {fieldLabel(p.field)}
          </div>
        ))}
      </div>

      {sel && selected !== null && (
        <div className="grid grid-cols-2 gap-2 rounded border border-slate-200 p-2 text-[11px] sm:grid-cols-3">
          <label>Size
            {/* min/max are advisory here — the value is clamped in
                clampFontSize, because a number input reports out-of-range
                typing to onChange regardless of them. */}
            <input type="number" min={4} max={96} value={sel.fontSize ?? ""} placeholder="11"
              onChange={(e) => patch(selected, { fontSize: clampFontSize(e.target.value) })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]" />
          </label>
          <label>Font
            <select value={sel.font ?? "sans"} onChange={(e) => patch(selected, { font: e.target.value as CertificateFont })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]">
              <option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option>
            </select>
          </label>
          <label>Align
            <select value={sel.align ?? "left"} onChange={(e) => patch(selected, { align: e.target.value as CertificateAlign })}
              className="mt-0.5 w-full rounded border-slate-300 text-[11px]">
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
            </select>
          </label>
          <label>Colour
            <input type="color" value={sel.color ?? "#0f172a"} onChange={(e) => patch(selected, { color: e.target.value })}
              className="mt-0.5 block h-6 w-full" />
          </label>
          <label className="flex items-end gap-1">
            <input type="checkbox" checked={sel.bold ?? false} onChange={(e) => patch(selected, { bold: e.target.checked })} />
            Bold
          </label>
          <button type="button"
            onClick={() => { onChange(removePlacement(placements, selected)); setSelected(null); }}
            className="self-end rounded border border-rose-300 px-2 py-1 text-rose-700 hover:bg-rose-50">
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
