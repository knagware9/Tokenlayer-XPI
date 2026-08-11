import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import { withoutStalePlacements } from "../lib/certificate-layout.js";
import type { CertificateFieldPlacement, CredentialUseCase } from "../types.js";
import { CertificateDesigner } from "./CertificateDesigner.js";
import { Card, SectionHeader } from "./ui.js";

export interface CertificateDesignPanelProps {
  useCase: CredentialUseCase;
  credentialTypeName: string;
  onSaved: () => void;
  onClose: () => void;
}

/**
 * The org-facing certificate designer: artwork + placements on ONE credential
 * type of a use case the caller's organization owns.
 *
 * Distinct from `CredentialUseCaseBuilder`, which hosts the same designer
 * inside a PlatformAdmin-only create wizard whose save writes the whole
 * definition. This one edits a SAVED use case through the narrow route, so an
 * OrgAdmin can change their artwork without being able to change their issuer
 * binding.
 */
export function CertificateDesignPanel(props: CertificateDesignPanelProps): JSX.Element {
  const { token } = useAuth();
  const { useCase, credentialTypeName } = props;
  const type = useCase.credentialTypes.find((t) => t.name === credentialTypeName);
  const cert = type?.certificate;

  const [placements, setPlacements] = useState<CertificateFieldPlacement[]>(cert?.placements ?? []);
  const [background, setBackground] = useState<{ documentId: string; sha256: string } | null>(
    cert?.background?.documentId && cert.background.sha256
      ? { documentId: cert.background.documentId, sha256: cert.background.sha256 }
      : null,
  );
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * Did the user actually CHANGE the artwork in this session? Set by an upload
   * and by "Remove artwork", and by nothing else — see `save()` for the failure
   * this exists to prevent.
   */
  const [artworkTouched, setArtworkTouched] = useState(false);

  const claimKeys = Object.keys(type?.claimSchema?.properties ?? {});

  // What is STORED, as opposed to what this session has staged. A design
  // authored before artwork was pinned has a documentId and no digest; the
  // artwork GET needs no pin, so those bytes still render on the canvas.
  const storedDocumentId = cert?.background?.documentId ?? null;
  const storedUnpinned = storedDocumentId !== null && !cert?.background?.sha256;
  // Artwork the user can actually SEE, which is what the controls must reflect:
  // the staged state once touched, the stored record until then.
  const hasArtwork = artworkTouched ? background !== null : storedDocumentId !== null;

  /**
   * Every object URL pins its blob until revoked, and this panel can outlive
   * several uploads. The ref mirrors the current URL so the UNMOUNT cleanup
   * revokes the latest one — an effect depending on the state would instead
   * revoke each URL the moment the next upload replaced it, while the canvas was
   * still displaying it. (Same reasoning as `CredentialUseCaseBuilder`.)
   */
  const artworkUrlRef = useRef<string | null>(null);
  artworkUrlRef.current = artworkUrl;
  useEffect(() => () => { if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current); }, []);

  // Reopening a SAVED design: the bytes come from the scoped artwork route,
  // because `GET /documents/:id` is closed to an OrgAdmin. A just-uploaded file
  // never goes through here — the browser still holds it.
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!token || !cert?.background?.documentId) return;
    if (fetchedFor.current === cert.background.documentId) return;
    fetchedFor.current = cert.background.documentId;
    void api
      .certificateArtwork(token, useCase.key, credentialTypeName)
      .then((b) => setArtworkUrl(URL.createObjectURL(b)))
      // Retryable: a dangling reference renders the empty canvas rather than an
      // error, and clearing the mark lets a later render try again.
      .catch(() => { fetchedFor.current = null; });
  }, [token, useCase.key, credentialTypeName, cert?.background?.documentId]);

  async function uploadArtwork(file: File): Promise<void> {
    if (!token) return;
    setError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
    try {
      const r = await api.uploadCertificateArtwork(token, useCase.key, file.type, btoa(bin));
      setBackground({ documentId: r.documentId, sha256: r.sha256 });
      setArtworkTouched(true);
      // Shown from the local File: no round trip, and it is the same bytes.
      if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
      setArtworkUrl(URL.createObjectURL(file));
      setSaved(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "artwork upload failed");
    }
  }

  async function preview(): Promise<void> {
    if (!token || !type) return;
    setError(null);
    // The preview must show what SAVE would store, including a change staged
    // but not yet saved. Spreading the stored `cert` alone would reprint the
    // artwork a user had just removed; the stored background is otherwise kept
    // exactly as it is, unpinned legacy record included (this door takes no pin).
    const nextCert = {
      ...(cert ?? { enabled: true }),
      ...(artworkTouched && background ? { background } : {}),
      placements: withoutStalePlacements(placements, claimKeys),
    };
    if (artworkTouched && !background) delete (nextCert as { background?: unknown }).background;
    try {
      const blob = await api.previewCertificate(token, {
        credentialType: { ...type, certificate: nextCert },
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      // Revoking immediately would race the new tab's own load of the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "preview failed");
    }
  }

  async function save(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateCertificateDesign(token, useCase.key, {
        credentialType: credentialTypeName,
        // OMIT means unchanged, `null` means clear — the route's own contract,
        // and the reason this is a conditional spread rather than a value.
        // Sending the state unconditionally deleted artwork nobody touched: a
        // design authored before pinning stores a documentId with NO sha256, so
        // `background` initialises to null while the canvas happily displays the
        // bytes (the artwork GET takes no pin). Nudging one placement and saving
        // then cleared artwork the panel cannot re-pin — it never uploaded those
        // bytes, and the PATCH door refuses a background without a digest.
        ...(artworkTouched ? { background } : {}),
        // Only when this type has NO certificate yet. The server refuses to
        // create one implicitly, because enabling a certificate publishes a
        // PUBLIC, unauthenticated PDF of every already-issued credential's
        // claims — so the confirmation is explicit on the wire, and the notice
        // above the Save button says what the click actually does.
        ...(cert ? {} : { enabled: true }),
        // A placement whose claim was renamed or deleted after it was placed
        // would make the server refuse the whole design; it could not print
        // anything either way. The designer warns about these, so dropping them
        // here is never the first the author hears of it.
        placements: withoutStalePlacements(placements, claimKeys),
      });
      setSaved(true);
      props.onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!type) {
    return (
      <Card>
        <p className="text-xs text-slate-500">This use case has no credential type named “{credentialTypeName}”.</p>
      </Card>
    );
  }

  return (
    <div>
      <SectionHeader
        title={`Certificate design — ${type.title || type.name}`}
        description={`Artwork and field placement for ${useCase.name}. The certificate PDF a holder downloads is your design; only the fields you place are printed on it.`}
        actions={
          <button
            onClick={props.onClose}
            className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
          >
            ← Back to list
          </button>
        }
      />
      <Card>
        <CertificateDesigner
          backgroundDocumentId={artworkTouched ? (background?.documentId ?? null) : storedDocumentId}
          artworkObjectUrl={artworkUrl}
          placements={placements}
          claimKeys={claimKeys}
          onChange={setPlacements}
          onUploadArtwork={(file) => { void uploadArtwork(file); }}
          onPreview={() => { void preview(); }}
        />
        {/* This type has no certificate yet, so saving TURNS ONE ON — and the
            render route is public and unauthenticated, so that publishes a PDF
            of every already-issued credential's claims. Say so before the click,
            not in the 400 that would otherwise follow it. */}
        {!cert && (
          <p className="mt-4 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
            This credential type has no certificate yet. Saving turns one on — and certificate PDFs are downloadable
            from a <strong>public link</strong> by anyone holding the credential&rsquo;s id, including for credentials
            already issued under this type.
          </p>
        )}
        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => { void save(); }}
            className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : cert ? "Save design" : "Turn on certificates & save"}
          </button>
          {/* Gated on what is VISIBLE, not on the pinned state: a legacy record
              shows its artwork on the canvas while `background` is null, and
              hiding the control there told the user there was nothing to remove
              while they were looking straight at it. */}
          {hasArtwork && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setBackground(null); setArtworkUrl(null); fetchedFor.current = null; setArtworkTouched(true); setSaved(false); }}
              className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
            >
              Remove artwork
            </button>
          )}
          {saved && <span className="text-[11px] text-emerald-600">Saved.</span>}
          {error && <span className="text-[11px] text-rose-600">{error}</span>}
        </div>
        {storedUnpinned && !artworkTouched && (
          <p className="mt-2 text-[11px] text-amber-700">
            This artwork predates digest pinning, so it can be kept or removed here but not edited in place. To change
            it, upload the file again.
          </p>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Removing the artwork reverts this credential type to the built-in certificate layout. Your placements are
          kept and simply stop printing until artwork is uploaded again.
        </p>
      </Card>
    </div>
  );
}
