import { useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { Card, SectionHeader } from "./ui.js";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/** Self-service KYC submission — any authenticated user. Shown in My Profile
 *  when the caller's own kycStatus is "pending" (no submission yet, or a
 *  fresh one after rejection/expiry) or "rejected". */
export function KycSubmissionPanel({ onSubmitted }: { onSubmitted: () => void }): JSX.Element {
  const { token } = useAuth();
  const [legalName, setLegalName] = useState("");
  const [country, setCountry] = useState("");
  const [idType, setIdType] = useState("passport");
  const [idNumber, setIdNumber] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [occupation, setOccupation] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState("");
  const [pepDeclaration, setPepDeclaration] = useState(false);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [addressFile, setAddressFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit = legalName && country && idType && idNumber && idFile && addressFile;

  async function submit(): Promise<void> {
    if (!token || !idFile || !addressFile) return;
    setBusy(true);
    setError(null);
    try {
      const idBase64 = await fileToBase64(idFile);
      const idUpload = await api.uploadKycDocument(token, idFile.type, idBase64);
      const addressBase64 = await fileToBase64(addressFile);
      const addressUpload = await api.uploadKycDocument(token, addressFile.type, addressBase64);
      await api.submitKyc(token, {
        legalName, country, idType, idNumber,
        dateOfBirth: dateOfBirth || undefined,
        address: street && city && postalCode ? { street, city, postalCode } : undefined,
        occupation: occupation || undefined, sourceOfFunds: sourceOfFunds || undefined, pepDeclaration,
        idDocumentId: idUpload.id, addressDocumentId: addressUpload.id,
      });
      // Show our own confirmation instead of reloading — a reload would wipe
      // this component's state and re-mount the (now-empty) form, which reads
      // to the user as if nothing happened. The caller still gets notified so
      // it can refresh the session's kycStatus in the background.
      setSubmitted(true);
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit your KYC application.");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <Card>
        <SectionHeader title="Complete your KYC" description="Submit your identity details and documents for review." />
        <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
          Your KYC application has been submitted and is pending review. We'll update your status here once it's been reviewed.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionHeader title="Complete your KYC" description="Submit your identity details and documents for review." />
      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Legal name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Country" value={country} onChange={(e) => setCountry(e.target.value)} />
        <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={idType} onChange={(e) => setIdType(e.target.value)}>
          <option value="passport">Passport</option>
          <option value="national-id">National ID</option>
          <option value="drivers-license">Driver's license</option>
        </select>
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="ID number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
        <input type="date" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Date of birth" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Occupation" value={occupation} onChange={(e) => setOccupation(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Street address" value={street} onChange={(e) => setStreet(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Postal code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        <input className="rounded-lg border border-slate-300 px-3 py-2 text-sm sm:col-span-2" placeholder="Source of funds" value={sourceOfFunds} onChange={(e) => setSourceOfFunds(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
          <input type="checkbox" checked={pepDeclaration} onChange={(e) => setPepDeclaration(e.target.checked)} />
          I am a politically exposed person (PEP)
        </label>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Government-issued ID</label>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setIdFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Proof of address</label>
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setAddressFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={!canSubmit || busy}
        className="mt-4 rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit for review"}
      </button>
    </Card>
  );
}
