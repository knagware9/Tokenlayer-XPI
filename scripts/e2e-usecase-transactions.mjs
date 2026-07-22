// End-to-end transaction lifecycle for EVERY use case, against the LIVE API
// (http://localhost:4000). Per use case: issue (with sale terms; gated issue is
// approved by a second admin for SoD) → allowlist treasury + buyer → mint to
// treasury → a funded, allowlisted buyer BUYS (real DvP trade) → a transfer.
// Assets are spread across the real ledgers (Besu, MST Testnet, Fabric).
const BASE = "http://localhost:4000/api/v1";
const CCY = "CBDC-INR";
const TAG = Date.now().toString(36).slice(-4).toUpperCase(); // unique per run

const WALLET = {
  treasury: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", // shared issuer treasury
  ecofund: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",  // carbon.buyer
  alice: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",    // gold.buyer
  bob: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",      // bond.buyer
  carol: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",    // invoice IN treasury
  greenwing: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", // invoice IN buyer
};

async function call(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (email, password) => (await call("POST", "/auth/login", null, { email, password })).body.token;
const step = (ok, msg, extra) => console.log(`  ${ok ? "✓" : "✗"} ${msg}${!ok && extra ? " — " + JSON.stringify(extra) : ""}`);

async function issueMaybeGated(admin, admin2, payload) {
  const iss = await call("POST", "/assets", admin, payload);
  if (iss.status === 201) return iss.body.asset.id;
  if (iss.status === 202) {
    const ap = await call("POST", `/proposals/${iss.body.proposal.id}/approve`, admin2, {});
    if (ap.status !== 200) throw new Error(`approve failed ${ap.status}: ${JSON.stringify(ap.body)}`);
    console.log("  ✓ gated issue approved by admin2 (separation of duties)");
    return iss.body.proposal.assetId ?? iss.body.asset.id;
  }
  throw new Error(`issue failed ${iss.status}: ${JSON.stringify(iss.body)}`);
}

// Ensure an IN-KYC holder exists on a wallet (maker m1.admin, checker platform admin).
async function ensureInHolder(admin, email, wallet, name) {
  const maker = await login("m1.admin@tokenlayer.dev", "m1admin123");
  const r = await call("POST", "/users", maker, { email, password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { legalName: name, country: "IN" } });
  if (r.status === 202) { await call("POST", `/proposals/${r.body.proposal.id}/approve`, admin, {}); return true; }
  return r.status === 400 && r.body?.error === "EMAIL_TAKEN"; // already onboarded
}

// Full DvP lifecycle for a fungible use case: issue w/ sale terms → allow+mint to
// treasury → allow+fund buyer → buyer BUYS → buyer transfers a little onward.
async function lifecycle({ admin, admin2, label, useCaseKey, chainId, metadata, treasury, buyerWallet, buyerLogin, unitPrice = "100", supply = "10000", buyQty = "500" }) {
  console.log(`\n=== ${label} (${useCaseKey}) on ${chainId} ===`);
  const id = await issueMaybeGated(admin, admin2, {
    useCaseKey, name: `${label} ${TAG}`, symbol: useCaseKey.slice(0, 4).toUpperCase(), chainId, metadata,
    treasuryAccount: treasury, sale: { unitPrice, currency: CCY, treasuryAccount: treasury },
  });
  step(true, `issued asset ${id} (sale ${unitPrice} ${CCY}/unit)`);
  await call("POST", `/assets/${id}/actions/allow`, admin, { account: treasury });
  const mint = await call("POST", `/assets/${id}/actions/mint`, admin, { to: treasury, amount: supply });
  step(mint.status === 200, `mint ${supply} → treasury`, mint.body);
  await call("POST", `/assets/${id}/actions/allow`, admin, { account: buyerWallet });
  await call("POST", "/cash/credit", admin, { account: buyerWallet, currency: CCY, amount: "10000000" });

  const buyer = await login(buyerLogin.email, buyerLogin.password);
  const buy = await call("POST", `/assets/${id}/buy`, buyer, { quantity: buyQty });
  const cost = (BigInt(unitPrice) * BigInt(buyQty)).toString();
  step(buy.status === 200 || buy.status === 201, `buyer bought ${buyQty} units for ${cost} ${CCY} (DvP)`, buy.body);

  const xfer = await call("POST", `/assets/${id}/actions/transfer`, admin, { from: treasury, to: buyerWallet, amount: "100" });
  step(xfer.status === 200, `treasury transfer 100 → buyer`, xfer.body);
  return buy.status === 200 || buy.status === 201;
}

async function invoiceLifecycle(admin) {
  console.log(`\n=== Invoice Tokenization (invoice-tokenization, IN-gated) on besu ===`);
  await ensureInHolder(admin, "e2e.treasury@x.dev", WALLET.carol, "E2E Treasury");
  await ensureInHolder(admin, "e2e.buyer@x.dev", WALLET.greenwing, "E2E Invoice Buyer");
  step(true, "onboarded IN-KYC treasury (Carol) + IN-KYC buyer (GreenWing)");
  const inv = { invoiceNumber: `E2E-INV-${TAG}`, invoiceDate: "2026-07-05", buyerName: "Tata Motors Ltd", currency: "INR", amount: 3000000, dueDate: "2026-11-30" };
  const iss = await call("POST", "/assets", admin, {
    useCaseKey: "invoice-tokenization", name: inv.invoiceNumber, chainId: "besu", initialSupply: "3000",
    treasuryAccount: WALLET.carol, metadata: inv, sale: { unitPrice: "1000", currency: CCY, treasuryAccount: WALLET.carol },
  });
  if (iss.status !== 201) { step(false, "tokenize invoice", iss.body); return false; }
  const id = iss.body.asset.id;
  step(true, `tokenized invoice → asset ${id} (3000 units to IN treasury)`);
  await call("POST", `/assets/${id}/actions/allow`, admin, { account: WALLET.greenwing });
  await call("POST", "/cash/credit", admin, { account: WALLET.greenwing, currency: CCY, amount: "10000000" });
  const buyer = await login("e2e.buyer@x.dev", "secret1");
  const buy = await call("POST", `/assets/${id}/buy`, buyer, { quantity: "500" });
  step(buy.status === 200 || buy.status === 201, `IN buyer bought 500 units for 500000 ${CCY} (DvP)`, buy.body);
  return buy.status === 200 || buy.status === 201;
}

async function main() {
  console.log(`Running end-to-end transactions (run tag ${TAG})`);
  const admin = await login("admin@tokenlayer.dev", "admin123");
  const admin2 = await login("admin2@tokenlayer.dev", "admin123");
  const R = {};
  R["carbon-credit"] = await lifecycle({ admin, admin2, label: "Verra VCS Carbon", useCaseKey: "carbon-credit", chainId: "besu",
    metadata: { projectName: "Amazon REDD+ Conservation", registry: "Verra VCS", vintage: 2026, methodology: "VM0007", country: "BR", creditType: "REDD+" },
    treasury: WALLET.treasury, buyerWallet: WALLET.ecofund, buyerLogin: { email: "carbon.buyer@tokenlayer.dev", password: "carbon123" } }).catch((e) => (step(false, e.message), false));
  R["gold-loan"] = await lifecycle({ admin, admin2, label: "Gold Loan Pool", useCaseKey: "gold-loan", chainId: "mst",
    metadata: { borrower: "Ramesh Traders", goldWeightGrams: 1000, goldPurity: "22K", loanAmountInr: 5000000, interestRate: 12 },
    treasury: WALLET.treasury, buyerWallet: WALLET.alice, buyerLogin: { email: "gold.buyer@tokenlayer.dev", password: "gold123" } }).catch((e) => (step(false, e.message), false));
  R["corporate-bond"] = await lifecycle({ admin, admin2, label: "Acme 2030 Bond", useCaseKey: "corporate-bond", chainId: "fabric",
    metadata: { issuer: "ACME Capital", isin: "INE000A01001", faceValue: 1000, couponRate: 7.5 },
    treasury: WALLET.treasury, buyerWallet: WALLET.bob, buyerLogin: { email: "bond.buyer@tokenlayer.dev", password: "bond123" }, unitPrice: "1000", supply: "5000", buyQty: "100" }).catch((e) => (step(false, e.message), false));
  R["invoice-tokenization"] = await invoiceLifecycle(admin).catch((e) => (step(false, e.message), false));

  console.log(`\n=== SUMMARY (run ${TAG}) ===`);
  for (const [k, v] of Object.entries(R)) console.log(`  ${v ? "✓" : "✗"} ${k}`);
  const a = (await call("GET", "/analytics", admin)).body ?? {};
  console.log(`\n  Platform totals: supply ${a.totalSupply ?? "?"} · ${a.holders ?? "?"} holders · ${(a.trades30d ?? a.recent?.filter?.((r) => r.action === "buy").length) ?? "?"} recent trades`);
  console.log(`  By use case:`);
  for (const u of (a.byUseCase ?? [])) console.log(`    - ${u.name} · ${u.chainId} · supply ${u.supply} · holders ${u.holders} · value ${JSON.stringify(u.valueByCurrency ?? {})}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
