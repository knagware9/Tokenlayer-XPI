/**
 * Populates the running platform with a portfolio of 10 real-world carbon
 * projects, tokenized as Carbon Credit (ERC-20) assets, and KYC-approves a
 * roster of buyers who may then hold/trade the credits.
 *
 * Run against a live API:  API=http://localhost:4000 tsx src/seed-carbon-projects.ts
 * Optionally set CHAIN=local-evm to tokenize on the live EVM (default: besu).
 */
const API = process.env.API ?? "http://localhost:4000";
const BASE = `${API}/api/v1`;
const CHAIN = process.env.CHAIN ?? "besu";

interface Project {
  name: string;
  symbol: string;
  supply: number; // tonnes CO2e issued
  registry: string;
  projectId: string;
  vintage: number;
  methodology: string;
  country: string;
  creditType: "avoidance" | "removal";
}

// A representative spread of registries, geographies, methodologies and credit types.
const PROJECTS: Project[] = [
  { name: "Rimba Raya Biodiversity Reserve", symbol: "RIMBA24", supply: 130000, registry: "Verra", projectId: "VCS-674", vintage: 2024, methodology: "VM0007", country: "Indonesia", creditType: "avoidance" },
  { name: "Katingan Mentaya Peatland", symbol: "KATING23", supply: 400000, registry: "Verra", projectId: "VCS-1477", vintage: 2023, methodology: "VM0007", country: "Indonesia", creditType: "avoidance" },
  { name: "Kariba REDD+", symbol: "KARIBA22", supply: 250000, registry: "Verra", projectId: "VCS-902", vintage: 2022, methodology: "VM0009", country: "Zimbabwe", creditType: "avoidance" },
  { name: "Kenya Efficient Cookstoves", symbol: "KENCOOK24", supply: 60000, registry: "Gold Standard", projectId: "GS-7008", vintage: 2024, methodology: "TPDDTEC", country: "Kenya", creditType: "avoidance" },
  { name: "Alto Mayo Conservation", symbol: "ALTO23", supply: 90000, registry: "Verra", projectId: "VCS-944", vintage: 2023, methodology: "VM0015", country: "Peru", creditType: "avoidance" },
  { name: "Madre de Dios Amazon REDD", symbol: "MADRE22", supply: 110000, registry: "Verra", projectId: "VCS-1067", vintage: 2022, methodology: "VM0007", country: "Peru", creditType: "avoidance" },
  { name: "DelAgua Rwanda Cookstoves", symbol: "DELAGUA24", supply: 75000, registry: "Gold Standard", projectId: "GS-9220", vintage: 2024, methodology: "TPDDTEC", country: "Rwanda", creditType: "avoidance" },
  { name: "Northern Kenya Soil Carbon", symbol: "NKENYA23", supply: 40000, registry: "Verra", projectId: "VCS-1468", vintage: 2023, methodology: "VM0032", country: "Kenya", creditType: "removal" },
  { name: "Manoa REDD+ Brazil", symbol: "MANOA24", supply: 180000, registry: "Verra", projectId: "VCS-1572", vintage: 2024, methodology: "VM0015", country: "Brazil", creditType: "avoidance" },
  { name: "BURN Improved Cookstoves Nigeria", symbol: "BURNNG24", supply: 55000, registry: "Gold Standard", projectId: "GS-11401", vintage: 2024, methodology: "TPDDTEC", country: "Nigeria", creditType: "avoidance" },
];

// Buyers who get KYC-approved (must match the seeded account labels). Carol is
// deliberately excluded — she stays un-KYC'd to demonstrate a blocked purchase.
const BUYER_LABELS = ["EcoFund Capital", "GreenWing Airlines", "Helios Energy Corp", "Nordic Pension Fund", "TerraNova Trading", "Summit Tech Net-Zero"];
const SELLER_LABEL = "Treasury"; // the project issuance pool that initially holds all credits

async function login(): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@tokenlayer.dev", password: "admin123" }) });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  return ((await r.json()) as any).token as string;
}
async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  const token = await login();
  const accounts = (await api(token, "GET", "/accounts")).body as { address: string; label: string }[];
  const addrOf = (label: string): string => {
    const a = accounts.find((x) => x.label === label);
    if (!a) throw new Error(`account '${label}' not seeded — restart the API to pick up the buyer roster`);
    return a.address;
  };
  const seller = addrOf(SELLER_LABEL);
  const buyers = BUYER_LABELS.map((l) => ({ label: l, address: addrOf(l) }));

  console.log(`Tokenizing ${PROJECTS.length} carbon projects on '${CHAIN}', KYC-approving ${buyers.length} buyers…\n`);
  const summary: { name: string; symbol: string; supply: number; sold: number; id: string; ref: string }[] = [];

  for (let i = 0; i < PROJECTS.length; i++) {
    const p = PROJECTS[i]!;
    // 1. Tokenize the project.
    const issue = await api(token, "POST", "/assets", {
      useCaseKey: "carbon-credit",
      name: p.name,
      symbol: p.symbol,
      chainId: CHAIN,
      metadata: { projectName: p.name, registry: p.registry, projectId: p.projectId, vintage: p.vintage, methodology: p.methodology, country: p.country, creditType: p.creditType },
    });
    if (issue.status !== 201) {
      console.log(`✗ ${p.name}: issue failed (${issue.status}) ${JSON.stringify(issue.body)}`);
      continue;
    }
    const id = issue.body.asset.id as string;
    const ref = issue.body.asset.contractRef as string;

    // 2. KYC-approve the issuance pool + all buyers (allowlist).
    await api(token, "POST", `/assets/${id}/actions/allow`, { account: seller });
    for (const b of buyers) await api(token, "POST", `/assets/${id}/actions/allow`, { account: b.address });

    // 3. Issue (mint) the full vintage to the issuance pool.
    await api(token, "POST", `/assets/${id}/actions/mint`, { to: seller, amount: String(p.supply) });

    // 4. Sample primary-market sales: distribute ~30% across two rotating buyers.
    const b1 = buyers[i % buyers.length]!;
    const b2 = buyers[(i + 1) % buyers.length]!;
    const lot1 = Math.round(p.supply * 0.2);
    const lot2 = Math.round(p.supply * 0.1);
    await api(token, "POST", `/assets/${id}/actions/transfer`, { from: seller, to: b1.address, amount: String(lot1) });
    await api(token, "POST", `/assets/${id}/actions/transfer`, { from: seller, to: b2.address, amount: String(lot2) });

    summary.push({ name: p.name, symbol: p.symbol, supply: p.supply, sold: lot1 + lot2, id, ref });
    console.log(`✓ ${p.symbol.padEnd(10)} ${p.name}`);
  }

  console.log(`\n${"━".repeat(72)}\nPORTFOLIO (${summary.length} tokenized projects)\n${"━".repeat(72)}`);
  for (const s of summary) {
    console.log(`  ${s.symbol.padEnd(10)} supply ${String(s.supply).padStart(7)} t  | sold ${String(s.sold).padStart(6)} t  | ${s.ref ? s.ref.slice(0, 12) + "…" : "(simulated)"}  ${s.name}`);
  }
  console.log(`\nKYC-approved buyers (${buyers.length}): ${buyers.map((b) => b.label).join(", ")}`);
  console.log(`Not KYC-approved (cannot buy): Carol`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
