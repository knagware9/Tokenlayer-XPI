#!/usr/bin/env bash
# ============================================================================
# DEPLOY THE IDENTITY PRODUCT — issuer console, verifier console, wallet.
#
#   bash deploy/identity.sh              # identity alone
#   bash deploy/identity.sh --besu       # …with the real Besu chain for
#                                        #   on-chain DID + VC anchoring
#
# Identity NEVER calls tokenization — the dependency runs one way only, which
# is why this stack is genuinely standalone. Without --besu the DID and VC
# registries are absent rather than mocked, so credentials still issue but
# nothing is anchored and a verifier sees them as unanchored.
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

C="\033[1;36m"; G="\033[1;32m"; N="\033[0m"
say() { echo -e "${C}[identity]${N} $*"; }

bash deploy/shared.sh "$@"
say "handing off to scripts/stack-up.sh…"
# DELEGATED, NOT REIMPLEMENTED. stack-up.sh owns the peer-key lifecycle and the
# volume-age check that decides whether a stored key is still valid. A second
# copy of that logic here is the drift this repo keeps paying for.
bash scripts/stack-up.sh identity

echo
echo -e "${G}✅ IDENTITY IS UP${N}"
echo "  Issuer Console    http://localhost:${IDENTITY_ISSUER_WEB_PORT:-8090}   (api :${IDENTITY_ISSUER_API_PORT:-4110})"
echo "  Verifier Console  http://localhost:${IDENTITY_VERIFIER_WEB_PORT:-8091}   (api :${IDENTITY_VERIFIER_API_PORT:-4111})"
echo "  Wallet            http://localhost:${IDENTITY_HOLDER_WEB_PORT:-8092}   (api :${IDENTITY_HOLDER_API_PORT:-4112})"
echo "  Logins            docs/demo-credentials.md"
