// Full multi-DLT E2E on REAL ledgers. One use case is configured across Besu +
// MST (+ Fabric), which deploys a real contract on each; then for each real EVM
// chain we issue+mint supply, transfer on-chain, and VERIFY INDEPENDENTLY against
// the chain's own RPC — real bytecode (eth_getCode), ERC-20 totalSupply/balanceOf,
// and mined tx receipts — plus block-explorer links for MST.
import { ethers } from "/Users/kamleshnagware/Tokenlayer XPI/packages/adapters/node_modules/ethers/lib.commonjs/index.js";

const API = "http://localhost:4000/api/v1";
const RPC = { besu: "http://localhost:8545", mst: "https://testnetrpc.mstblockchain.com" };
const EXPLORER = { mst: "https://testnet.mstscan.com" };
const ERC20 = ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

async function call(m, p, b, t) {
  const r = await fetch(API + p, { method: m, headers: { ...(b != null ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b != null ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, j };
}
let fails = 0;
const ok = (c, m, d) => { console.log(`  ${c ? "✓" : "✗"} ${m}${!c && d !== undefined ? ` — ${JSON.stringify(d).slice(0, 240)}` : ""}`); if (!c) fails++; };
const addrOf = (ref) => (ref?.startsWith("0x") ? ref : String(ref).split(":").pop());
// MST's public RPC can lag a beat behind a mined tx — retry reads briefly.
async function retry(fn, n = 6) { for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { if (i === n - 1) throw e; await new Promise((r) => setTimeout(r, 1500)); } } }

const admin = (await call("POST", "/auth/login", { email: "admin@tokenlayer.dev", password: "admin123" })).j.token;

const key = "multi-dlt-e2e-" + String(Date.now()).slice(-6);
console.log(`== Configure '${key}' across besu + mst + fabric → deploy real contracts ==`);
const created = await call("POST", "/use-cases", {
  key, name: "Multi-DLT E2E", description: "Real cross-ledger issuance demo.", tokenStandard: "ERC-20", symbol: "MDE",
  allowedChainIds: ["besu", "mst", "fabric"], defaultChainId: "besu",
  metadataSchema: { type: "object", properties: { issuer: { type: "string", description: "Issuer" } }, required: ["issuer"] },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
}, admin);
ok(created.status === 201, "use case created + deployed", created.j?.error ?? created.status);
const contracts = created.j?.contracts ?? {};

for (const chain of ["besu", "mst"]) {
  console.log(`\n== ${chain.toUpperCase()} — real on-chain issue → mint → transfer → verify ==`);
  const contract = addrOf(contracts[chain]?.contractRef);
  const provider = new ethers.JsonRpcProvider(RPC[chain]);
  const net = await provider.getNetwork();
  const token = new ethers.Contract(contract, ERC20, provider);

  const code = await provider.getCode(contract);
  ok(code && code !== "0x" && code.length > 100, `contract ${contract} has REAL bytecode on-chain (chainId ${net.chainId}, ${code.length} chars)`);

  const issue = await call("POST", "/assets", { useCaseKey: key, name: `MDE ${chain}`, chainId: chain, initialSupply: "1000", treasuryAccount: ALICE, metadata: { issuer: "ACME" } }, admin);
  ok(issue.status === 201, `issue + mint 1000 to treasury → tx ${String(issue.j?.txHash).slice(0, 18)}…`, issue.j?.error ?? issue.j);
  const assetId = issue.j?.asset?.id;

  const supply = await retry(() => token.totalSupply());
  ok(supply === 1000n, `on-chain totalSupply() = ${supply} (expected 1000)`);
  ok((await retry(() => token.balanceOf(ALICE))) === 1000n, "on-chain balanceOf(treasury) = 1000");

  const xfer = await call("POST", `/assets/${assetId}/actions/transfer`, { from: ALICE, to: BOB, amount: "250" }, admin);
  ok(xfer.status === 200, `transfer 250 treasury→Bob → tx ${String(xfer.j?.receipt?.txHash).slice(0, 18)}…`, xfer.j?.error ?? xfer.j);
  ok((await retry(() => token.balanceOf(ALICE))) === 750n, "on-chain balanceOf(treasury) = 750 after transfer");
  ok((await retry(() => token.balanceOf(BOB))) === 250n, "on-chain balanceOf(Bob) = 250 after transfer");

  const rcpt = await retry(() => provider.getTransactionReceipt(xfer.j?.receipt?.txHash));
  ok(rcpt?.status === 1, `transfer tx mined with status 1 (block ${rcpt?.blockNumber})`);
  if (EXPLORER[chain]) console.log(`    explorer: ${EXPLORER[chain]}/address/${contract}  ·  ${EXPLORER[chain]}/tx/${xfer.j?.receipt?.txHash}`);
  else console.log(`    (besu is a private QBFT network — no public explorer; verified directly via RPC ${RPC[chain]})`);
}

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ MULTI-DLT E2E PASSED — one use case, real contracts + mint + transfer independently verified on-chain on Besu AND MST"}`);
process.exit(fails ? 1 : 0);
