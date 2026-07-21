import { useState } from "react";
import { ApiError, api } from "../api.js";
import { useRoute } from "../router.js";
import type { CompanyCategory, OrgType } from "../types.js";
import { Logo } from "./Logo.js";
import { Icon } from "./ui.js";

// Public self-registration is limited to issuing/holding org types — a verifier
// is provisioned by the platform, not self-served.
const ORG_TYPES: { value: OrgType; label: string }[] = [
  { value: "corporate", label: "Corporate" },
  { value: "bank", label: "Bank" },
  { value: "msme", label: "MSME" },
  { value: "government", label: "Government" },
];

// Legal structure of an Indian company (KYB "category").
const CATEGORIES: { value: CompanyCategory; label: string }[] = [
  { value: "private-limited", label: "Private Limited" },
  { value: "public-limited", label: "Public Limited" },
  { value: "llp", label: "LLP" },
  { value: "opc", label: "OPC" },
  { value: "section-8", label: "Section 8" },
];

const STEPS = ["Company", "Administrator", "Review"] as const;

interface Form {
  name: string;
  orgType: OrgType;
  category: CompanyCategory;
  cin: string;
  pan: string;
  gstin: string;
  state: string;
  pincode: string;
  dateOfIncorporation: string;
  companyStatus: "active" | "inactive";
  adminName: string;
  adminEmail: string;
  password: string;
}

const EMPTY: Form = {
  name: "", orgType: "corporate", category: "private-limited", cin: "", pan: "", gstin: "",
  state: "", pincode: "", dateOfIncorporation: "", companyStatus: "active",
  adminName: "", adminEmail: "", password: "",
};

export function Signup(): JSX.Element {
  const { navigate } = useRoute();
  const [f, setF] = useState<Form>(EMPTY);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [cinDoc, setCinDoc] = useState<{ id: string; sha256: string; name: string } | null>(null);
  const [gstinDoc, setGstinDoc] = useState<{ id: string; sha256: string; name: string } | null>(null);
  const [docBusy, setDocBusy] = useState<"cin" | "gstin" | null>(null);

  const set = <K extends keyof Form>(k: K) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value as Form[K] }));

  // Validation for the currently-visible step. Returns an error string or null.
  function validate(s: number): string | null {
    if (s === 0) {
      if (!f.name.trim()) return "Company legal name is required";
      if (!f.cin.trim()) return "CIN is required";
      if (!f.pan.trim()) return "PAN is required";
      if (!f.state.trim()) return "State is required";
      if (!f.pincode.trim()) return "Pincode is required";
      if (!f.dateOfIncorporation) return "Date of incorporation is required";
      if (!cinDoc) return "CIN certificate is required";
    }
    if (s === 1) {
      if (!f.adminName.trim()) return "Administrator name is required";
      if (!f.adminEmail.trim()) return "Administrator email is required";
      if (f.password.length < 8) return "Password must be at least 8 characters";
    }
    return null;
  }

  // Upload a KYB certificate as soon as it is picked; registration only sends the id.
  async function pickDocument(kind: "cin" | "gstin", file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) { setError("Use a PDF, PNG, or JPG"); return; }
    if (file.size > 5 * 1024 * 1024) { setError("File too large (max 5 MB)"); return; }
    setDocBusy(kind);
    try {
      // FileReader → data URL avoids the call-stack overflow of
      // spreading a large byte array into String.fromCharCode.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("could not read file"));
        r.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const up = await api.uploadKybDocument(file.type, dataBase64);
      (kind === "cin" ? setCinDoc : setGstinDoc)({ id: up.id, sha256: up.sha256, name: file.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setDocBusy(null);
    }
  }

  function next(): void {
    const err = validate(step);
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back(): void { setError(null); setStep((s) => Math.max(s - 1, 0)); }

  async function submit(): Promise<void> {
    // Re-check every step before the final POST.
    for (let s = 0; s < STEPS.length; s++) { const err = validate(s); if (err) { setError(err); setStep(s); return; } }
    setBusy(true);
    setError(null);
    try {
      await api.registerOrg({
        company: {
          name: f.name.trim(), orgType: f.orgType, cin: f.cin.trim(), pan: f.pan.trim(),
          gstin: f.gstin.trim() || undefined, state: f.state.trim(), pincode: f.pincode.trim(),
          dateOfIncorporation: f.dateOfIncorporation, category: f.category, companyStatus: f.companyStatus,
          // cinDoc is guaranteed non-null by the validate() re-check above.
          documents: {
            cinCertificate: { id: cinDoc!.id },
            ...(f.gstin.trim() && gstinDoc ? { gstinCertificate: { id: gstinDoc.id } } : {}),
          },
        },
        admin: { name: f.adminName.trim(), email: f.adminEmail.trim(), password: f.password },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#EFF8F4] flex flex-col">
      <header className="border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <button onClick={() => navigate("/")} className="cursor-pointer">
            <Logo size={30} />
          </button>
          <button
            onClick={() => navigate("/login")}
            className="rounded-lg border border-slate-200 text-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-50 transition-colors"
          >
            Login
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          {done ? (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
              <div className="p-8 text-center">
                <div className="mx-auto w-12 h-12 rounded-full bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name="check" className="w-7 h-7" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">Registration submitted</h2>
                <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
                  A platform administrator will review your company details and statutory identifiers.
                  You can log in once your organization is approved.
                </p>
                <button
                  onClick={() => navigate("/")}
                  className="mt-6 rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-brand-700 transition-colors"
                >
                  Back to home
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-xigreen via-brand-400 to-xiblue" />
              <div className="p-8">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold tracking-tight text-slate-900">Corporate registration</h2>
                  <span className="text-xs font-medium text-slate-400">Step {step + 1} of {STEPS.length}</span>
                </div>

                {/* Stepper */}
                <div className="mt-4 flex items-center gap-2">
                  {STEPS.map((label, i) => (
                    <div key={label} className="flex-1">
                      <div className={`h-1.5 rounded-full ${i <= step ? "bg-brand-500" : "bg-slate-200"}`} />
                      <div className={`mt-1.5 text-[11px] font-medium ${i === step ? "text-brand-700" : "text-slate-400"}`}>{label}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-6">
                  {step === 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field className="sm:col-span-2" label="Company legal name">
                        <input className="input" value={f.name} onChange={set("name")} placeholder="Acme Trade Pvt Ltd" />
                      </Field>
                      <Field label="Organization type">
                        <select className="select" value={f.orgType} onChange={set("orgType")}>
                          {ORG_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Category">
                        <select className="select" value={f.category} onChange={set("category")}>
                          {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                      </Field>
                      <Field label="CIN (Corporate Identity No.)">
                        <input className="input" value={f.cin} onChange={set("cin")} placeholder="U72900MH2020PTC123456" />
                      </Field>
                      <Field label="PAN">
                        <input className="input" value={f.pan} onChange={set("pan")} placeholder="AABCU9603R" />
                      </Field>
                      <Field label={<>GSTIN <span className="text-slate-400 font-normal">(optional)</span></>}>
                        <input className="input" value={f.gstin} onChange={set("gstin")} placeholder="27AABCU9603R1Z5" />
                      </Field>
                      <Field label="Date of incorporation">
                        <input className="input" type="date" value={f.dateOfIncorporation} onChange={set("dateOfIncorporation")} />
                      </Field>
                      <Field label="State">
                        <input className="input" value={f.state} onChange={set("state")} placeholder="Maharashtra" />
                      </Field>
                      <Field label="Pincode">
                        <input className="input" value={f.pincode} onChange={set("pincode")} placeholder="400001" />
                      </Field>
                      <Field label="Company status">
                        <select className="select" value={f.companyStatus} onChange={set("companyStatus")}>
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </select>
                      </Field>

                      {/* KYB certificates — uploaded up front; the registration sends only their ids. */}
                      <p className="sm:col-span-2 text-xs font-medium text-slate-500 uppercase tracking-wide mt-1">Documents</p>
                      <Field className="sm:col-span-2" label="CIN certificate (incorporation certificate)">
                        <input
                          type="file"
                          accept="application/pdf,image/png,image/jpeg"
                          disabled={docBusy !== null}
                          onChange={(e) => void pickDocument("cin", e.target.files?.[0])}
                          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
                        />
                        {docBusy === "cin" ? (
                          <p className="mt-1.5 text-xs text-slate-500">Uploading…</p>
                        ) : cinDoc ? (
                          <p className="mt-1.5 text-xs text-brand-700">✓ {cinDoc.name} · {cinDoc.sha256.slice(0, 12)}…</p>
                        ) : null}
                      </Field>
                      {f.gstin.trim() !== "" && (
                        <Field className="sm:col-span-2" label={<>GSTIN certificate <span className="text-slate-400 font-normal">(optional)</span></>}>
                          <input
                            type="file"
                            accept="application/pdf,image/png,image/jpeg"
                            disabled={docBusy !== null}
                            onChange={(e) => void pickDocument("gstin", e.target.files?.[0])}
                            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
                          />
                          {docBusy === "gstin" ? (
                            <p className="mt-1.5 text-xs text-slate-500">Uploading…</p>
                          ) : gstinDoc ? (
                            <p className="mt-1.5 text-xs text-brand-700">✓ {gstinDoc.name} · {gstinDoc.sha256.slice(0, 12)}…</p>
                          ) : null}
                        </Field>
                      )}
                    </div>
                  )}

                  {step === 1 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <p className="sm:col-span-2 text-sm text-slate-500 -mt-1">
                        This person becomes the organization's admin — they receive a login once the company is approved.
                      </p>
                      <Field className="sm:col-span-2" label="Full name">
                        <input className="input" value={f.adminName} onChange={set("adminName")} autoComplete="name" placeholder="Jane Doe" />
                      </Field>
                      <Field label="Email">
                        <input className="input" type="email" value={f.adminEmail} onChange={set("adminEmail")} autoComplete="email" placeholder="jane@acme.com" />
                      </Field>
                      <Field label="Password">
                        <input className="input" type="password" value={f.password} onChange={set("password")} autoComplete="new-password" placeholder="At least 8 characters" />
                      </Field>
                    </div>
                  )}

                  {step === 2 && (
                    <div className="space-y-5">
                      <ReviewSection title="Company">
                        <Row label="Legal name" value={f.name} />
                        <Row label="Organization type" value={ORG_TYPES.find((t) => t.value === f.orgType)?.label ?? f.orgType} />
                        <Row label="Category" value={CATEGORIES.find((c) => c.value === f.category)?.label ?? f.category} />
                        <Row label="CIN" value={f.cin} />
                        <Row label="PAN" value={f.pan} />
                        <Row label="GSTIN" value={f.gstin || "—"} />
                        <Row label="Date of incorporation" value={f.dateOfIncorporation} />
                        <Row label="State" value={f.state} />
                        <Row label="Pincode" value={f.pincode} />
                        <Row label="Company status" value={f.companyStatus === "active" ? "Active" : "Inactive"} />
                        <Row label="CIN certificate" value={cinDoc?.name ?? "—"} />
                        {gstinDoc && <Row label="GSTIN certificate" value={gstinDoc.name} />}
                      </ReviewSection>
                      <ReviewSection title="Administrator">
                        <Row label="Full name" value={f.adminName} />
                        <Row label="Email" value={f.adminEmail} />
                      </ReviewSection>
                    </div>
                  )}
                </div>

                {error && <p className="mt-5 text-sm text-red-600">{error}</p>}

                <div className="mt-7 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={step === 0 ? () => navigate("/") : back}
                    className="text-sm font-medium text-slate-500 hover:text-slate-800"
                  >
                    {step === 0 ? "← Home" : "← Back"}
                  </button>
                  {step < STEPS.length - 1 ? (
                    <button
                      type="button"
                      onClick={next}
                      className="rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-brand-700 transition-colors"
                    >
                      Next →
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={submit}
                      disabled={busy}
                      className="rounded-lg bg-brand-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
                    >
                      {busy ? "Submitting…" : "Submit registration"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, className, children }: { label: React.ReactNode; className?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-slate-600 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200/80 overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="divide-y divide-slate-100">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 text-right">{value}</span>
    </div>
  );
}
