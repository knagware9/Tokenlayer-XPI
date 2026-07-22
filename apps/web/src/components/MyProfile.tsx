import { useState } from "react";
import { useAuth } from "../auth.js";
import { Card, SectionHeader } from "./ui.js";

/** A read-only snapshot of the signed-in user's account and identity. */
export function MyProfile({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const did = user?.did ?? null;
  const didShort = did ? `${did.slice(0, 18)}…${did.slice(-6)}` : "—";
  const copyDid = (): void => {
    if (!did) return;
    void navigator.clipboard.writeText(did).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Email", value: user?.email ?? "—" },
    { label: "Role", value: user?.role ?? "—" },
    { label: "Use case", value: user?.useCaseKey ?? "—" },
    { label: "Organization", value: user?.orgId ?? "—", mono: true },
    { label: "Wallet", value: user?.walletAddress ?? "—", mono: true },
  ];

  return (
    <div>
      <SectionHeader title="My profile" description="Your account and identity at a glance." />
      <Card>
        <dl className="divide-y divide-slate-100">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{r.label}</dt>
              <dd className={`text-sm text-slate-900 truncate text-right ${r.mono ? "font-mono text-xs" : ""}`}>{r.value}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">DID</dt>
            <dd className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-mono text-slate-900 truncate">{didShort}</span>
              {did && (
                <button
                  onClick={copyDid}
                  className="shrink-0 text-[11px] font-medium text-brand-600 hover:text-brand-700"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-5 pt-4 border-t border-slate-100">
          <button
            onClick={() => onSelect("credentials")}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            View my credentials →
          </button>
        </div>
      </Card>
    </div>
  );
}
