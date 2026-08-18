#!/usr/bin/env bash
# ============================================================================
# DEPLOY THE TOKENIZATION PRODUCT — issuer desk, marketplace, platform admin.
#
#   bash deploy/tokenization.sh                       # STANDALONE, all simulated
#   bash deploy/tokenization.sh --chain=besu           # mint on local Besu
#   bash deploy/tokenization.sh --chain=mst            # mint on the MST testnet
#   bash deploy/tokenization.sh --chain=besu,mst,fabric # several at once
#   bash deploy/tokenization.sh --chain=besu --with-identity
#
# UNLIKE IDENTITY, TOKENIZATION TAKES ANY LEDGER — a use case names the chain it
# deploys to, so besu, mst and fabric are all valid targets and several can be
# live at once. Only `fabric` carries a caveat: containerised it is simulated
# (see deploy/shared.sh).
#
# THE LINK IS OPTIONAL AND ONE-WAY. Tokenization asks identity a single
# question — does this DID hold a valid KycCredential — and only a DID crosses
# the wire, never a wallet. Standalone, a use case with
# `requireVerifiedIdentity` cannot be satisfied, so leave that flag off or pass
# --with-identity; the two are not interchangeable and the failure surfaces at
# the first gated transfer, not at boot.
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

C="\033[1;36m"; G="\033[1;32m"; Y="\033[1;33m"; N="\033[0m"
say() { echo -e "${C}[tokenization]${N} $*"; }

WITH_IDENTITY=0; PASS=()
for a in "$@"; do
  case "$a" in
    --with-identity) WITH_IDENTITY=1 ;;
    *) PASS+=("$a") ;;
  esac
done

# SOURCED, not run: a subprocess cannot export BESU_RPC_URL back to us, and
# without it the stack boots with the chain absent.
. deploy/shared.sh ${PASS[@]+"${PASS[@]}"}
say "handing off to scripts/stack-up.sh…"
if [ "$WITH_IDENTITY" = 1 ]; then
  # Naming BOTH stacks is what mints the identity:assert peer key and wires the
  # seam. Starting them separately leaves tokenization standalone.
  bash scripts/stack-up.sh identity tokenization ${SHARED_CHAINS:+--chain=$(echo "$SHARED_CHAINS" | tr " " ",")}
else
  bash scripts/stack-up.sh tokenization ${SHARED_CHAINS:+--chain=$(echo "$SHARED_CHAINS" | tr " " ",")}
fi

echo
echo -e "${G}✅ TOKENIZATION IS UP${N}"
echo "  Issuer Desk       http://localhost:${TOKENIZATION_ISSUER_WEB_PORT:-8100}   (api :${TOKENIZATION_ISSUER_API_PORT:-4120})"
echo "  Marketplace       http://localhost:${TOKENIZATION_MARKETPLACE_WEB_PORT:-8101}   (api :${TOKENIZATION_MARKETPLACE_API_PORT:-4121})"
echo "  Platform Admin    http://localhost:${TOKENIZATION_ADMIN_WEB_PORT:-8102}   (api :${TOKENIZATION_ADMIN_API_PORT:-4122})"
[ "$WITH_IDENTITY" = 1 ] \
  && echo "  Identity seam     linked — credential gates are enforceable" \
  || echo -e "  ${Y}Identity seam     NOT linked — 'requireVerifiedIdentity' use cases will refuse${N}"
echo "  Ledgers           ${SHARED_CHAINS:-none — all simulated}"
echo "  Logins            docs/demo-credentials.md"
