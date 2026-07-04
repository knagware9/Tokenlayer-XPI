// Emits the runtime artifacts the FabricGatewayAdapter needs from a test-network:
//   - a filesystem wallet holding one X.509 identity (default label "appUser")
//   - a copy of the Org1 connection profile
//
// It writes fabric-network's on-disk wallet format directly (a "<label>.id" JSON),
// so it needs no SDK import and runs with plain `node`. Reads the Org1 admin cert +
// private key straight from the test-network crypto material — no CA enrollment.
//
// Usage:
//   node infra/fabric/scripts/fabric-wallet.mjs [--samples <dir>] [--out <dir>] [--identity <label>]
// Defaults: samples=~/fabric-samples, out=<this repo>/infra/fabric/.runtime, identity=appUser

import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const samples = arg("samples", join(homedir(), "fabric-samples"));
const outDir = arg("out", join(repoRoot, "infra", "fabric", ".runtime"));
const identity = arg("identity", "appUser");
const mspId = arg("msp", "Org1MSP");

const org1 = join(samples, "test-network", "organizations", "peerOrganizations", "org1.example.com");
const adminMsp = join(org1, "users", "Admin@org1.example.com", "msp");
const connectionProfile = join(org1, "connection-org1.json");

function die(msg) {
  console.error(`[fabric-wallet] ERROR: ${msg}`);
  process.exit(1);
}

// --- read the admin cert + key from the crypto material --------------------
let certPem;
try {
  certPem = readFileSync(join(adminMsp, "signcerts", "Admin@org1.example.com-cert.pem"), "utf8");
} catch {
  // signcerts filename can vary — fall back to the single file in the dir.
  const dir = join(adminMsp, "signcerts");
  const f = readdirSync(dir).find((n) => n.endsWith(".pem"));
  if (!f) die(`no signcert found under ${dir} — is the network up? (make fabric-up)`);
  certPem = readFileSync(join(dir, f), "utf8");
}

let keyPem;
try {
  const dir = join(adminMsp, "keystore");
  const f = readdirSync(dir).find((n) => n.endsWith("_sk") || n.endsWith(".pem"));
  if (!f) die(`no private key found under ${dir}`);
  keyPem = readFileSync(join(dir, f), "utf8");
} catch (e) {
  die(`cannot read admin keystore: ${e.message}`);
}

// --- write the wallet identity + copy the connection profile ---------------
const walletDir = join(outDir, "wallet");
mkdirSync(walletDir, { recursive: true });
const idFile = join(walletDir, `${identity}.id`);
writeFileSync(
  idFile,
  JSON.stringify({ credentials: { certificate: certPem, privateKey: keyPem }, mspId, type: "X.509", version: 1 }, null, 2),
);

const ccpOut = join(outDir, "connection-org1.json");
copyFileSync(connectionProfile, ccpOut);

console.log(`[fabric-wallet] wrote identity '${identity}' (${mspId}) -> ${idFile}`);
console.log(`[fabric-wallet] copied connection profile -> ${ccpOut}`);
console.log("");
console.log("Set these to run the API against real Fabric:");
console.log(`  export FABRIC_CONNECTION_PROFILE="${ccpOut}"`);
console.log(`  export FABRIC_WALLET="${walletDir}"`);
console.log(`  export FABRIC_IDENTITY="${identity}"`);
console.log('  export FABRIC_CHANNEL="mychannel"');
console.log('  export FABRIC_CHAINCODE="tokenlayer"');
