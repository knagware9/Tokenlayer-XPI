#!/usr/bin/env bash
# ============================================================================
# TokenLayer XPI — deployment smoke test (runs against the live API)
#
#   ./scripts/verify.sh            # issue + buy on the simulated "fabric" chain
#   ./scripts/verify.sh --besu     # issue + buy on the real "besu" chain and
#                                   # assert the contract is a real 0x address
#
# Exercises the real flow end-to-end: login → issue (auto-mint to treasury) →
# allow buyer → buy → assert on-chain balances moved.
# ============================================================================
set -euo pipefail
API="http://localhost:${API_PORT:-4000}/api/v1"
EXPECT_ONCHAIN="no"; CHAIN="fabric"
[[ "${1:-}" == "--besu" ]] && { EXPECT_ONCHAIN="yes"; CHAIN="besu"; }

python3 - "$API" "$EXPECT_ONCHAIN" "$CHAIN" <<'PY'
import json, sys, urllib.request, time
API, EXPECT, CHAIN = sys.argv[1], sys.argv[2], sys.argv[3]
def call(method, path, token=None, body=None):
    req = urllib.request.Request(API+path,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type":"application/json", **({"Authorization":"Bearer "+token} if token else {})},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

fails = 0
def check(name, ok, extra=""):
    global fails
    print(f"  {'✓' if ok else '✗'} {name}{(' — '+extra) if extra else ''}")
    if not ok: fails += 1

TRE="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"
BUY="0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
stamp=str(int(time.time()))[-6:]

s,a = call("POST","/auth/login",body={"email":"carbon.admin@tokenlayer.dev","password":"carbon123"})
check("admin login", s==200); admin=a.get("token")

s,iss = call("POST","/assets",admin,{"useCaseKey":"carbon-credit","chainId":CHAIN,
    "name":f"Smoke {stamp}","symbol":f"SMK{stamp}","metadata":{"projectName":"Smoke","registry":"Verra","vintage":2025},
    "treasuryAccount":TRE,"initialSupply":"100","sale":{"unitPrice":"5","currency":"CBDC-INR","treasuryAccount":TRE}})
check(f"issue on {CHAIN} with auto-mint (201)", s==201, iss.get("asset",{}).get("contractRef",""))
aid=iss["asset"]["id"]; ref=iss["asset"]["contractRef"]

if EXPECT=="yes":
    is_addr = ref.startswith("0x") and len(ref)==42
    check("contractRef is a real on-chain address", is_addr, ref)

s,full = call("GET",f"/assets/{aid}",admin)
check("on-chain totalSupply == 100", str(full.get("totalSupply"))=="100", str(full.get("totalSupply")))

s,_ = call("POST",f"/assets/{aid}/actions/allow",admin,{"account":BUY})
check("allowlist buyer (200)", s==200)

s,b = call("POST","/auth/login",body={"email":"carbon.buyer@tokenlayer.dev","password":"carbon123"})
check("buyer login", s==200); buyer=b.get("token")

s,buy = call("POST",f"/assets/{aid}/buy",buyer,{"quantity":"10"})
check("buy 10 tokens (200)", s==200, f"paid {buy.get('paid')}")

s,acc = call("GET",f"/assets/{aid}/accounts",admin)
bal={x["address"]:x["balance"] for x in acc}
check("treasury balance 90 after sale", bal.get(TRE)=="90", bal.get(TRE))
check("buyer balance 10 after sale", bal.get(BUY)=="10", bal.get(BUY))

print()
if fails: print(f"❌ SMOKE TEST FAILED ({fails} check(s))"); sys.exit(1)
print("✅ SMOKE TEST PASSED")
PY
