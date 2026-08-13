/**
 * ASK THE API WHICH CHAINS EXIST BEFORE ASSUMING ONE DOES.
 *
 * EVM chains on this platform are REAL-OR-ABSENT: an operator who has not set
 * `<CHAIN>_RPC_URL` + `<CHAIN>_OPERATOR_KEY` gets no adapter at all, rather than a
 * mock that quietly pretends. That is the right product behaviour, and it makes a
 * harness that hardcodes `http://localhost:8545` wrong in a specific, expensive way:
 * it dies deep inside ethers or `fetch` with `ECONNREFUSED ::1:8545`, an error about
 * neither the missing configuration nor the thing the script was proving.
 *
 * Everything here exists to make the failure name itself. Three rules:
 *
 *   1. ASK FIRST. `GET /chains` is the authority on what this deployment has;
 *      guessing from an env var is how a script "verifies" a chain nobody configured.
 *   2. NOTHING TO PROVE IS NOT A PASS. A script whose on-chain assertions cannot
 *      run has verified nothing, and exiting 0 reports a green run over an empty
 *      one. `skip()` exits 2 — distinct from 1 (a real failed check), so CI can
 *      tell "this machine lacks Besu" from "the product broke".
 *   3. SAY HOW TO FIX IT. Every skip prints the exact env vars to set.
 */

/** RPC endpoints for chains a script may want to read INDEPENDENTLY of our API.
 *  `GET /chains` deliberately exposes only `rpcHost`, never the full URL (a hosted
 *  RPC URL can carry an API key in its path), so the map lives here and env wins. */
const RPC_URLS = {
  besu: () => process.env.BESU_RPC_URL ?? "http://localhost:8545",
  mst: () => process.env.MST_RPC_URL ?? "https://testnetrpc.mstblockchain.com",
};

/** The chains this deployment actually has, as the API reports them. */
export async function fetchChains(api, token) {
  const res = await fetch(`${api}/chains`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) skip(`GET /chains returned ${res.status} — cannot tell which chains exist`, [
    "Is the API up on this port, and is the token a valid human session?",
  ]);
  return (await res.json()) ?? [];
}

/** Ids of chains that are configured AND connected — the ones you can transact on. */
export function availableIds(chains) {
  return new Set(chains.filter((c) => c.available).map((c) => c.id));
}

/**
 * The first candidate this machine can actually use, or null.
 *
 * Candidates are a PREFERENCE ORDER, not a requirement: a script that says
 * `pickChain(available, ["besu", "mst"])` runs on Besu when it is there and on MST
 * when it is not, instead of insisting on the one the author happened to have up.
 */
export function pickChain(available, candidates) {
  return candidates.find((c) => available.has(c)) ?? null;
}

/** Only chains we hold an RPC URL for can be verified independently of the API. */
export function rpcUrlFor(chainId) {
  return RPC_URLS[chainId]?.() ?? null;
}

/** A JSON-RPC caller bound to one chain, for proofs that must bypass our API. */
export function rpcFor(chainId) {
  const url = rpcUrlFor(chainId);
  if (!url) skip(`no RPC URL is known for chain '${chainId}'`, [
    `Add it to RPC_URLS in scripts/lib/chain-preflight.mjs, or set ${chainId.toUpperCase()}_RPC_URL.`,
  ]);
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()).result;
  };
}

/**
 * Stop, explain, and exit 2 — the script had nothing to verify.
 *
 * NOT exit 0. The whole point: a run that could not execute its assertions must
 * not be indistinguishable from one where they all passed.
 */
export function skip(reason, hints = []) {
  console.log(`\n⊘ SKIPPED — ${reason}`);
  for (const h of hints) console.log(`  ${h}`);
  console.log("  Nothing was verified, so this is not a pass (exit 2).");
  process.exit(2);
}

/** The env vars an operator must set to bring an EVM chain into a deployment. */
export function envHintFor(chainId) {
  const C = chainId.toUpperCase();
  return `Set ${C}_RPC_URL + ${C}_OPERATOR_KEY and restart the API to include '${chainId}'.`;
}

/**
 * The chain a given use case can be exercised on here.
 *
 * THREE facts have to line up, and a check that tests fewer answers a question
 * nobody asked:
 *
 *   · AVAILABLE — the chain exists on this deployment at all.
 *   · ALLOWED — it is in the use case's `allowedChainIds`; the engine refuses any
 *     other, and a seeded use case pinned to Besu is not rescued by MST being up.
 *   · DEPLOYED — the use case has a CONTRACT on it. A chain can satisfy the first
 *     two and still fail issuance with `USE_CASE_NOT_DEPLOYED_ON_CHAIN`, because a
 *     deploy that failed at boot is left pending and never retried. That refusal
 *     arrives mid-run, dressed as a product failure; here it is a named skip.
 *
 * Holding an RPC URL is deliberately NOT a requirement — it belongs to scripts that
 * verify a chain independently of our API, and folding it in would skip a run that
 * Fabric could have carried. Chains we can read directly are merely preferred, so a
 * machine with Besu up keeps choosing Besu and these runs look as they always did.
 */
export async function chainForUseCase(api, token, useCaseKey, available) {
  const res = await fetch(`${api}/use-cases/${useCaseKey}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { chainId: null, allowed: [], reason: `GET /use-cases/${useCaseKey} → ${res.status}` };
  const uc = await res.json();
  const allowed = uc?.allowedChainIds ?? [];
  const deployed = Object.keys(uc?.contracts ?? {});
  const usable = allowed.filter((c) => available.has(c) && deployed.includes(c));
  const preferred = usable.find((c) => rpcUrlFor(c) !== null) ?? usable[0] ?? null;
  return {
    chainId: preferred,
    allowed,
    reason: preferred
      ? null
      : `use case '${useCaseKey}' allows [${allowed.join(", ") || "none"}] and is deployed on [${deployed.join(", ") || "none"}]; none of those is available here`,
  };
}
