// Drive real transaction flows across every demo use case against the LIVE API
// (http://localhost:4000), so the platform dashboard shows use cases with assets
// and recent activity. Admin-driven action flow: issue → allow → mint → transfer,
// spread across the real ledgers (Besu, MST Testnet, Fabric).
const BASE = "http://localhost:4000/api/v1";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CAROL = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // IN-KYC treasury for invoices

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (email, password) => (await call("POST", "/auth/login", null, { email, password })).body.token;

// Issue an asset; if the use case gates issuance (202 proposal), approve it with
// the second platform admin (separation of duties: proposer ≠ approver).
async function issueMaybeGated(admin, admin2, payload) {
  const iss = await call("POST", "/assets", admin, payload);
  if (iss.status === 201) return { id: iss.body.asset.id, txHash: iss.body.txHash };
  if (iss.status === 202) {
    const ap = await call("POST", `/proposals/${iss.body.proposal.id}/approve`, admin2, {});
    if (ap.status !== 200) throw new Error(`approve failed ${ap.status}: ${JSON.stringify(ap.body)}`);
    console.log(`  ✓ issue proposal approved by admin2 (SoD)`);
    return { id: iss.body.asset.id, txHash: ap.body?.txHash };
  }
  throw new Error(`issue failed ${iss.status}: ${JSON.stringify(iss.body)}`);
}

async function erc20Flow(admin, admin2, label, useCaseKey, symbol, chainId, metadata) {
  console.log(`\n=== ${label} (${useCaseKey}) on ${chainId} ===`);
  const { id } = await issueMaybeGated(admin, admin2, { useCaseKey, name: label, symbol, chainId, metadata });
  console.log(`  ✓ issued asset ${id}`);
  for (const acct of [ALICE, BOB]) await call("POST", `/assets/${id}/actions/allow`, admin, { account: acct });
  const mint = await call("POST", `/assets/${id}/actions/mint`, admin, { to: ALICE, amount: "1000" });
  console.log(`  ${mint.status === 200 ? "✓" : "✗"} mint 1000 → Alice (${mint.status}${mint.status !== 200 ? " " + JSON.stringify(mint.body) : ""})`);
  const xfer = await call("POST", `/assets/${id}/actions/transfer`, admin, { from: ALICE, to: BOB, amount: "300" });
  console.log(`  ${xfer.status === 200 ? "✓" : "✗"} transfer 300 Alice→Bob (${xfer.status})`);
  return true;
}

async function erc3643Flow(admin, admin2, chainId) {
  console.log(`\n=== Corporate Bond (corporate-bond, ERC-3643) on ${chainId} ===`);
  const { id } = await issueMaybeGated(admin, admin2, { useCaseKey: "corporate-bond", name: "Acme 2030 Bond", symbol: "ACMEB", chainId, metadata: { issuer: "ACME Capital", isin: "INE000A01001", faceValue: 1000, couponRate: 7.5 } });
  console.log(`  ✓ issued asset ${id}`);
  await call("POST", `/assets/${id}/actions/allow`, admin, { account: ALICE }); // registers identity
  const mint = await call("POST", `/assets/${id}/actions/mint`, admin, { to: ALICE, amount: "500" });
  console.log(`  ${mint.status === 200 ? "✓" : "✗"} mint 500 → Alice after identity registration (${mint.status}${mint.status !== 200 ? " " + JSON.stringify(mint.body) : ""})`);
  return true;
}

async function invoiceFlow(admin) {
  console.log(`\n=== Invoice Tokenization (invoice-tokenization, IN-gated) on besu ===`);
  // Onboard an IN-KYC holder (Carol) as the treasury — maker m1.admin, checker platform admin.
  const maker = await login("m1.admin@tokenlayer.dev", "m1admin123");
  const prop = await call("POST", "/users", maker, { email: "flow.holder@x.dev", password: "secret1", role: "Buyer", walletAddress: CAROL, kyc: { legalName: "Flow Holder", country: "IN" } });
  if (prop.status === 202) {
    await call("POST", `/proposals/${prop.body.proposal.id}/approve`, admin, {});
    console.log(`  ✓ onboarded IN-KYC treasury holder (Carol)`);
  } else if (prop.status === 400 && prop.body?.error === "EMAIL_TAKEN") {
    console.log(`  · IN holder already onboarded`);
  } else { console.log(`  · onboard status ${prop.status}: ${JSON.stringify(prop.body)}`); }

  const inv = { invoiceNumber: "FLOW-INV-002", invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 2400000, dueDate: "2026-12-31" };
  const iss = await call("POST", "/assets", admin, { useCaseKey: "invoice-tokenization", name: inv.invoiceNumber, chainId: "besu", initialSupply: "2400", treasuryAccount: CAROL, metadata: inv });
  if (iss.status !== 201) { console.log(`  ✗ tokenize failed ${iss.status}: ${JSON.stringify(iss.body)}`); return false; }
  console.log(`  ✓ tokenized invoice → asset ${iss.body.asset.id} (2400 units to IN treasury)`);
  return true;
}

async function main() {
  const admin = await login("admin@tokenlayer.dev", "admin123");
  const admin2 = await login("admin2@tokenlayer.dev", "admin123");
  const results = {};
  results["carbon-credit"] = await erc20Flow(admin, admin2, "Verra VCS Carbon 2026", "carbon-credit", "CARB", "besu", { projectName: "Amazon REDD+ Conservation", registry: "Verra VCS", vintage: 2026, methodology: "VM0007", country: "BR", creditType: "REDD+" }).catch((e) => { console.log("  ✗", e.message); return false; });
  results["gold-loan"] = await erc20Flow(admin, admin2, "Gold Loan Pool A", "gold-loan", "GOLD", "mst", { borrower: "Ramesh Traders", goldWeightGrams: 1000, goldPurity: "22K", loanAmountInr: 5000000, interestRate: 12 }).catch((e) => { console.log("  ✗", e.message); return false; });
  results["corporate-bond"] = await erc3643Flow(admin, admin2, "fabric").catch((e) => { console.log("  ✗", e.message); return false; });
  results["invoice-tokenization"] = await invoiceFlow(admin).catch((e) => { console.log("  ✗", e.message); return false; });

  console.log(`\n=== SUMMARY ===`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "✓" : "✗"} ${k}`);
  const analytics = await call("GET", "/analytics", admin);
  const byUC = analytics.body?.byUseCase ?? [];
  console.log(`\n  Dashboard 'by use case' now has ${byUC.length} entr${byUC.length === 1 ? "y" : "ies"}:`);
  for (const u of byUC) console.log(`    - ${u.useCaseKey}: ${u.name} · ${u.symbol} · ${u.chainId} · supply ${u.supply} · holders ${u.holders}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
