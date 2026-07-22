// Full invoice-tokenization (TReDS) lifecycle against the LIVE API:
//   DID/VC onboarding → invoice upload (register: import + ERP pull) →
//   selective tokenization issuance → financing (financier buys, DvP) →
//   secondary sale (list → another investor takes) → redeem (settle the
//   redemption cashflow at maturity). All holders are IN-KYC (jurisdiction-gated).
const BASE = "http://localhost:4000/api/v1";
const UC = "invoice-tokenization";
const CCY = "CBDC-INR";
const TAG = Date.now().toString(36).slice(-4).toUpperCase();
const W = {
  supplier: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",  // Carol — MSME supplier / treasury
  financier: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", // GreenWing — bank / financier
  investor: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",  // Helios — secondary investor
};

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (email, password) => (await call("POST", "/auth/login", null, { email, password })).body.token;
const ok = (s) => s === 200 || s === 201;
const log = (good, msg, extra) => console.log(`  ${good ? "✓" : "✗"} ${msg}${!good && extra ? " — " + JSON.stringify(extra) : ""}`);

async function main() {
  const admin = await login("admin@tokenlayer.dev", "admin123");
  const admin2 = await login("admin2@tokenlayer.dev", "admin123");
  const desk = await login("m1.admin@tokenlayer.dev", "m1admin123"); // invoice UseCaseAdmin (maker + issuer)

  // ── 1. DID / VC — onboard IN-KYC participants (maker desk → checker platform admin) ──
  console.log(`\n=== 1. DID / VC onboarding (IN-KYC, DID issued at onboard) ===`);
  async function onboard(email, wallet, name) {
    const r = await call("POST", "/users", desk, { email, password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { legalName: name, country: "IN" } });
    if (r.status === 202) await call("POST", `/proposals/${r.body.proposal.id}/approve`, admin, {});
    else if (!(r.status === 400 && r.body?.error === "EMAIL_TAKEN")) return log(false, `onboard ${name}`, r.body);
    // The DID + KYC VC are issued at onboard; read them from the user's own session.
    const sess = (await call("POST", "/auth/login", null, { email, password: "secret1" })).body;
    const did = sess?.user?.did;
    const creds = (await call("GET", "/me/credentials", sess?.token)).body ?? [];
    const kyc = (Array.isArray(creds) ? creds : []).some((c) => (c.type || []).includes("KycCredential"));
    log(!!did && kyc, `${name}: ${email} — DID ${did ? did.slice(0, 22) + "…" : "MISSING"} · KycCredential ${kyc ? "issued" : "MISSING"}`);
    return sess?.user;
  }
  await onboard(`sup.${TAG}@x.dev`, W.supplier, "MSME Supplier");
  await onboard(`fin.${TAG}@x.dev`, W.financier, "Anchor Bank (Financier)");
  await onboard(`inv.${TAG}@x.dev`, W.investor, "Secondary Investor");

  // ── 2. Invoice upload — stage into the register (file import + ERP pull) ──
  console.log(`\n=== 2. Invoice upload → register (import + ERP pull) ===`);
  const rows = [
    { invoiceNumber: `LC-${TAG}-01`, invoiceDate: "2026-06-01", buyerName: "Tata Motors Ltd", currency: "INR", amount: 2500000, dueDate: "2026-07-10" },
    { invoiceNumber: `LC-${TAG}-02`, invoiceDate: "2026-06-03", buyerName: "Reliance Industries", currency: "INR", amount: 1800000, dueDate: "2026-08-15" },
  ];
  const imp = await call("POST", `/use-cases/${UC}/invoices/import`, desk, { rows });
  log(ok(imp.status), `uploaded ${imp.body?.staged ?? 0} invoices via file import`, imp.body);
  const erp = await call("POST", `/use-cases/${UC}/invoices/pull-erp`, desk, {});
  log(ok(erp.status), `pulled ${erp.body?.staged ?? 0} invoices from ERP`);
  const staged = (await call("GET", `/use-cases/${UC}/invoices?status=staged`, desk)).body ?? [];
  log(staged.length > 0, `register now holds ${staged.length} staged invoice(s)`);

  // ── 3. Tokenization issuance — selectively tokenize one staged invoice to the supplier ──
  console.log(`\n=== 3. Selective tokenization issuance (to supplier treasury, with sale terms) ===`);
  const target = staged.find((s) => s.metadata?.invoiceNumber === `LC-${TAG}-01`) ?? staged[0];
  const tok = await call("POST", `/use-cases/${UC}/invoices/tokenize`, desk, {
    ids: [target.id], chainId: "besu", treasuryAccount: W.supplier, parValue: 1000,
    sale: { unitPrice: "1000", currency: CCY },
  });
  const res0 = tok.body?.results?.[0];
  const assetId = res0?.assetId;
  log(ok(tok.status) && res0?.status === "tokenized", `tokenized ${target.metadata.invoiceNumber} → asset ${assetId} (supply = amount/par)`, tok.body);
  if (!assetId) return;

  // ── 4. Financing — the financier buys the tokenized invoice (DvP, early liquidity) ──
  console.log(`\n=== 4. Financing — financier buys the invoice tokens (DvP) ===`);
  await call("POST", `/assets/${assetId}/actions/allow`, admin, { account: W.financier });
  await call("POST", "/cash/credit", admin, { account: W.financier, currency: CCY, amount: "50000000" });
  const fin = await login(`fin.${TAG}@x.dev`, "secret1");
  const buy = await call("POST", `/assets/${assetId}/buy`, fin, { quantity: "1500" });
  log(ok(buy.status), `financier financed 1,500 units for 1,500,000 ${CCY} (supplier gets early liquidity)`, buy.body);

  // ── 5. Secondary sale — financier lists, a secondary investor takes ──
  console.log(`\n=== 5. Secondary sale — financier lists → investor takes ===`);
  const list = await call("POST", `/assets/${assetId}/listings`, fin, { quantity: "600", unitPrice: "1050", currency: CCY });
  log(ok(list.status), `financier listed 600 units @ 1,050 ${CCY} (escrowed)`, list.body);
  const listingId = list.body?.id ?? list.body?.listing?.id;
  await call("POST", `/assets/${assetId}/actions/allow`, admin, { account: W.investor });
  await call("POST", "/cash/credit", admin, { account: W.investor, currency: CCY, amount: "50000000" });
  const inv = await login(`inv.${TAG}@x.dev`, "secret1");
  const take = listingId ? await call("POST", `/listings/${listingId}/take`, inv, { quantity: "600" }) : { status: 0, body: "no listing id" };
  log(ok(take.status), `investor bought 600 units off the secondary market for 630,000 ${CCY}`, take.body);

  // ── 6. Redeem — settle the redemption cashflow at maturity (gated → admin2 approves) ──
  console.log(`\n=== 6. Redeem — execute the redemption cashflow at maturity ===`);
  const cfs = (await call("GET", `/assets/${assetId}/cashflows`, admin)).body ?? [];
  const redemption = (cfs.cashflows ?? []).find((c) => c.kind === "redemption");
  log(!!redemption, `redemption cashflow present: ${redemption ? `${redemption.amount} ${redemption.currency} due ${redemption.dueDate}` : "MISSING"}`);
  if (redemption) {
    // Fund the treasury/payer so the redemption can pay holders, then propose→approve.
    await call("POST", "/cash/credit", admin, { account: W.supplier, currency: CCY, amount: "50000000" });
    const exec = await call("POST", `/assets/${assetId}/cashflows/${redemption.id}/execute`, admin, {});
    if (exec.status === 202) {
      const ap = await call("POST", `/proposals/${exec.body.proposal.id}/approve`, admin2, {});
      log(ok(ap.status), `redemption settled at maturity (proposed by admin, approved by admin2)`, ap.body);
    } else {
      log(ok(exec.status), `redemption executed (status ${exec.status})`, exec.body);
    }
  }

  // ── Summary ──
  console.log(`\n=== SUMMARY — invoice ${target.metadata.invoiceNumber} full lifecycle (run ${TAG}) ===`);
  const asset = (await call("GET", `/assets/${assetId}`, admin)).body;
  console.log(`  asset ${assetId} · chain ${asset?.chainId} · status ${asset?.status} · totalSupply ${asset?.totalSupply}`);
  const cfs2 = (await call("GET", `/assets/${assetId}/cashflows`, admin)).body ?? [];
  const red2 = (cfs2.cashflows ?? []).find((c) => c.kind === "redemption");
  console.log(`  redemption cashflow status: ${red2?.status ?? "?"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
