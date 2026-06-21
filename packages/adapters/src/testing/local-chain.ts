import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Hardhat's deterministic dev accounts (same on every node, any port). */
export const HARDHAT_OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const HARDHAT_ACCOUNTS: [string, string, string] = [
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // #1
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // #2
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // #3
];

export interface LocalChain {
  rpcUrl: string;
  operatorKey: string;
  accounts: [string, string, string];
  stop: () => Promise<void>;
}

const CONTRACTS_DIR = fileURLToPath(new URL("../../../contracts", import.meta.url));

async function waitForRpc(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${rpcUrl} did not become ready within ${timeoutMs}ms`);
}

/**
 * Boots an isolated Hardhat node on the given port and resolves once it answers
 * JSON-RPC. Caller must invoke stop().
 */
export async function startLocalChain(port = 18545, timeoutMs = 60000): Promise<LocalChain> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  // detached:true makes the child a process-group leader so we can kill the
  // whole tree (pnpm wrapper + hardhat node) with a single negative-pid signal.
  const child: ChildProcess = spawn("pnpm", ["exec", "hardhat", "node", "--port", String(port)], {
    cwd: CONTRACTS_DIR,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const stop = async (): Promise<void> => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        // group already gone
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  };

  try {
    await waitForRpc(rpcUrl, timeoutMs);
  } catch (err) {
    await stop();
    throw err;
  }

  return { rpcUrl, operatorKey: HARDHAT_OPERATOR_KEY, accounts: HARDHAT_ACCOUNTS, stop };
}
