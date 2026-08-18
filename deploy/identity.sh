#!/usr/bin/env bash
# ============================================================================
# DEPLOY THE IDENTITY PRODUCT — issuer console, verifier console, wallet.
#
#   bash deploy/identity.sh                 # no anchoring (credentials unanchored)
#   bash deploy/identity.sh --chain=besu    # anchor DIDs + VCs on local Besu
#   bash deploy/identity.sh --chain=mst     # anchor on the MST public testnet
#
# IDENTITY ANCHORS ON EVM, NEVER ON FABRIC. The DID and VC registries are
# Solidity contracts and `CredentialAnchor` exists only on the EVM adapter, so
# `--chain=fabric` alone is refused here rather than accepted and quietly
# ignored — a deployment that reports success while anchoring nothing is the
# failure this whole codebase keeps guarding against.
#
# Identity NEVER calls tokenization; the dependency runs one way, which is why
# this stack is genuinely standalone.
# ============================================================================
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

C="\033[1;36m"; G="\033[1;32m"; Y="\033[1;33m"; N="\033[0m"
say() { echo -e "${C}[identity]${N} $*"; }

# SOURCED, not run: a subprocess cannot export BESU_RPC_URL back to us, and
# without it the stack boots with the chain absent.
. deploy/shared.sh "$@"

# The registries live on exactly ONE chain (REGISTRY_CHAIN_ID, default "besu").
# Pick the first EVM chain the caller selected, so --chain=mst just works.
REGISTRY=""
for c in ${SHARED_CHAINS:-}; do
  case "$c" in besu|mst) [ -z "$REGISTRY" ] && REGISTRY="$c" ;; esac
done
if [ -n "$REGISTRY" ]; then
  export REGISTRY_CHAIN_ID="$REGISTRY"
  say "DID + VC registries will anchor on '$REGISTRY'"
elif echo " ${SHARED_CHAINS:-} " | grep -q ' fabric '; then
  echo "[identity] ERROR: fabric cannot host the DID/VC registries — they are Solidity" >&2
  echo "  contracts and CredentialAnchor exists only on the EVM adapter." >&2
  echo "  Add an EVM chain:  bash deploy/identity.sh --chain=besu,fabric" >&2
  exit 1
else
  say "no EVM chain selected — credentials will issue but stay UNANCHORED"
fi

say "handing off to scripts/stack-up.sh…"
# DELEGATED, NOT REIMPLEMENTED. stack-up.sh owns the peer-key lifecycle and the
# volume-age check deciding whether a stored key is still valid.
bash scripts/stack-up.sh identity

echo
echo -e "${G}✅ IDENTITY IS UP${N}"
echo "  Issuer Console    http://localhost:${IDENTITY_ISSUER_WEB_PORT:-8090}   (api :${IDENTITY_ISSUER_API_PORT:-4110})"
echo "  Verifier Console  http://localhost:${IDENTITY_VERIFIER_WEB_PORT:-8091}   (api :${IDENTITY_VERIFIER_API_PORT:-4111})"
echo "  Wallet            http://localhost:${IDENTITY_HOLDER_WEB_PORT:-8092}   (api :${IDENTITY_HOLDER_API_PORT:-4112})"
[ -n "$REGISTRY" ] \
  && echo "  Anchoring         on-chain via '$REGISTRY'" \
  || echo -e "  ${Y}Anchoring         NONE — credentials verify by signature only${N}"
echo "  Logins            docs/demo-credentials.md"
