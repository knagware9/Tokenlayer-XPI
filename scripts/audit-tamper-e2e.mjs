// Live E2E for hash-chained audit. Two distinct DB-level attacks:
//   ATTACK 1 (partial tamper): edit one row's actorId, leave hashes alone.
//     → verifyChain recomputes and fails at the exact seq (tamper-evident).
//   ATTACK 2 (full consistent rewrite): edit seq 1 AND recompute EVERY hash
//     from genesis so the chain is internally perfect.
//     → verifyChain now PASSES, but the head no longer matches the on-ledger
//       anchor → anchorConsistent=false. Only the ledger anchor catches this.
import { execSync } from "node:child_process";

const API = "http://localhost:4000/api/v1";
async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d ? ` — ${JSON.stringify(d).slice(0, 240)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
// Run a Node program inside the api container (CommonJS via `node -`, fed on stdin).
const inContainer = (src) => execSync("docker compose exec -T api node -", { cwd: "/Users/kamleshnagware/Tokenlayer XPI", encoding: "utf8", input: src });

const carbonAdmin = await login("carbon.admin@tokenlayer.dev", "carbon123");
const carbonIssuer = await login("carbon.issuer@tokenlayer.dev", "carbon123");
if (!carbonAdmin || !carbonIssuer) { console.error("login failed"); process.exit(2); }

console.log("== 1) Generate audit activity ==");
const treasury = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const issue = await call("POST", "/assets", { useCaseKey: "carbon-credit", name: "AUDIT-VCU", chainId: "fabric", initialSupply: "100", treasuryAccount: treasury, metadata: { projectName: "Rimba", registry: "Verra", vintage: 2024 } }, carbonIssuer);
ok(issue.status === 201, "issue a carbon asset (issue/allow/mint audit entries)", issue.json);
const assetId = issue.json?.asset?.id;
await call("POST", `/assets/${assetId}/actions/freeze`, { account: treasury }, carbonAdmin);
await call("POST", `/assets/${assetId}/actions/unfreeze`, { account: treasury }, carbonAdmin);

console.log("\n== 2) Verify the clean chain ==");
let v = (await call("GET", `/assets/${assetId}/audit/verify`, null, carbonAdmin)).json;
ok(v.valid === true && v.brokenAt === null, `chain valid with ${v.count} entries`, v);
ok(v.anchorConsistent === true && v.lastAnchor === null, "no anchor yet, anchorConsistent=true");
let summary = (await call("GET", "/audit/verify", null, carbonAdmin)).json;
// SCOPED TO THIS RUN, deliberately. This used to assert `tampered.length === 0`
// across the WHOLE platform, which made the script fail on any deployment where
// an earlier run of THIS script had left damage behind — reporting a stale
// artefact as if the current run had found a broken chain. What section 2 needs
// to know is that the asset we just created reads clean before we attack it.
ok(!summary.tampered.some((t) => t.assetId === assetId),
  `summary sees this run's asset as clean (platform-wide: ${summary.verified}/${summary.assets} verified, ${summary.tampered.length} tampered)`,
  summary.tampered);

console.log("\n== 3) Anchor chain heads on-ledger ==");
const anchor = (await call("POST", "/audit/anchor", {}, carbonAdmin)).json;
ok(anchor.anchored.some((a) => a.assetId === assetId), `anchored ${anchor.anchored.length} head(s) on-ledger`);
v = (await call("GET", `/assets/${assetId}/audit/verify`, null, carbonAdmin)).json;
const anchoredSeq = v.lastAnchor?.seq;
ok(v.lastAnchor?.txHash?.startsWith("0x"), `head anchored at seq ${anchoredSeq} (tx ${v.lastAnchor?.txHash})`);
ok(v.anchorConsistent === true, "anchorConsistent=true after anchoring");

// THE ORIGINAL ACTOR, read before anything is touched. Section 6 puts it back,
// and putting back the exact byte is what makes the repair provable: the
// recomputed head must equal the anchor taken in section 3, or the restore was
// approximate and the asset is left quietly broken.
const originalActor = inContainer(`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
p.auditLog.findFirst({where:{assetId:'${assetId}',seq:1}})
 .then(r=>{console.log(r.actorId);return p.$disconnect();}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});`).trim();

console.log("\n== 4) ATTACK 1 — partial tamper (edit one row, leave hashes) ==");
const out1 = inContainer(`const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
p.auditLog.updateMany({where:{assetId:'${assetId}',seq:1},data:{actorId:'attacker'}})
 .then(r=>{console.log('rows='+r.count);return p.$disconnect();}).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});`);
ok(/rows=1/.test(out1), `tampered seq=1 in the DB (${out1.trim()})`);
v = (await call("GET", `/assets/${assetId}/audit/verify`, null, carbonAdmin)).json;
ok(v.valid === false && v.brokenAt === 1, `verify DETECTS it: INVALID at seq ${v.brokenAt} (${v.reason})`, v);
summary = (await call("GET", "/audit/verify", null, carbonAdmin)).json;
ok(summary.tampered.some((t) => t.assetId === assetId), `summary flags the tampered asset (${summary.tampered.length} tampered)`);

console.log("\n== 5) ATTACK 2 — full consistent rewrite (recompute every hash) ==");
// Replays core's exact hashing so verifyChain cannot tell the chain was rewritten.
// PARAMETERISED BY THE seq-1 ACTOR, because section 6 runs this very same code
// with the ORIGINAL value. The repair being literally the attack in reverse is
// what stops it from being a second, differently-wrong rewrite.
const rewriteWith = (seq1Actor) => `const {createHash}=require('crypto');const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
function canon(v){if(v===null||typeof v!=='object')return JSON.stringify(v)??'null';if(Array.isArray(v))return '['+v.map(canon).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';}
const sha=s=>'0x'+createHash('sha256').update(s,'utf8').digest('hex');
const genesis=a=>sha('tokenlayer-audit-genesis|'+a);
const entryHash=(prev,f)=>sha(prev+'|'+canon({assetId:f.assetId,seq:f.seq,actorId:f.actorId,action:f.action,payload:f.payload,txHash:f.txHash??null,chainId:f.chainId??null,createdAt:f.createdAt}));
(async()=>{const rows=await p.auditLog.findMany({where:{assetId:'${assetId}'},orderBy:{seq:'asc'}});
 let prev=genesis('${assetId}');
 for(const r of rows){const actorId=r.seq===1?${JSON.stringify(seq1Actor)}:r.actorId;
   const f={assetId:r.assetId,seq:r.seq,actorId,action:r.action,payload:JSON.parse(r.payload),txHash:r.txHash??undefined,chainId:r.chainId??undefined,createdAt:new Date(r.createdAt).toISOString()};
   const hash=entryHash(prev,f);
   await p.auditLog.update({where:{id:r.id},data:{actorId,prevHash:prev,hash}});prev=hash;}
 console.log('rewrote='+rows.length);await p.$disconnect();process.exit(0);})().catch(e=>{console.error(e);process.exit(1)});`;
const out2 = inContainer(rewriteWith("attacker"));
ok(/rewrote=\d+/.test(out2), `recomputed the entire chain consistently (${out2.trim()})`);
v = (await call("GET", `/assets/${assetId}/audit/verify`, null, carbonAdmin)).json;
ok(v.valid === true, "verifyChain is FOOLED — chain now recomputes as valid", v);
ok(v.anchorConsistent === false, `but the LEDGER ANCHOR catches it: anchorConsistent=false (head≠anchor at seq ${anchoredSeq})`, v);
summary = (await call("GET", "/audit/verify", null, carbonAdmin)).json;
ok(summary.tampered.some((t) => t.assetId === assetId && t.reason === "anchor-mismatch"), `summary flags it as anchor-mismatch (${summary.tampered.length} tampered)`);

console.log("\n== 6) REPAIR — the run puts back exactly what it broke ==");
// THIS SCRIPT USED TO LEAVE A CORRUPTED ASSET BEHIND, FOREVER. Every run added
// one more permanently-tampered chain to the deployment, so `GET /audit/verify`
// slowly filled with damage that no operator caused and nobody could explain —
// and a later run of this same script then failed its own clean-chain
// precondition, reporting stale wreckage as a fresh finding.
//
// The repair is the ATTACK RUN BACKWARDS: the same rewrite, with the original
// seq-1 actor. That matters because a merely plausible restore would leave the
// chain internally valid but hashing to something else, which is exactly the
// state ATTACK 2 creates — silently broken, and only visible against the anchor.
//
// So the assertion is the anchor, not the absence of an error. The head must
// hash back to the value anchored on-ledger in section 3, BEFORE any tampering.
// Nothing but a byte-exact restore can produce that.
const repaired = inContainer(rewriteWith(originalActor));
ok(/rewrote=\d+/.test(repaired), `restored the original actor and recomputed (${repaired.trim()})`);
v = (await call("GET", `/assets/${assetId}/audit/verify`, null, carbonAdmin)).json;
ok(v.valid === true && v.brokenAt === null, "the chain verifies again", v);
ok(v.anchorConsistent === true,
  `and the head matches the anchor taken at seq ${anchoredSeq} — proof the restore was byte-exact, not approximate`, v);
summary = (await call("GET", "/audit/verify", null, carbonAdmin)).json;
ok(!summary.tampered.some((t) => t.assetId === assetId),
  `this run leaves NOTHING tampered behind (platform-wide now: ${summary.tampered.length})`, summary.tampered);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ HASH-CHAINED AUDIT E2E PASSED — partial tamper caught by the chain; full consistent rewrite caught by the on-ledger anchor; both repaired, anchor-verified"}`);
process.exit(fails ? 1 : 0);
