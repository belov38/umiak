#!/usr/bin/env bash
# Real desktop acceptance, never a fake or a template build. Run only when pve is free.
# Needs a logged-in sbx CLI on PATH, deployed branch, promoted desktop template and TURN.
# The Windows variant is added after S9/S10 Windows integration.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
source "$HERE/names.sh"
export SBX_API_URL="$API_URL"
export NODE_EXTRA_CA_CERTS="$CA_DIR/ca.pem"
export SBX_E2E_OUTPUT="${SBX_E2E_OUTPUT:-$(mktemp -d)}"
# Refuse to overlap other tracks, including a build template outside 500-589.
ssh -o BatchMode=yes -o HostKeyAlias=pve.tail0000.ts.net root@100.64.10.2 \
 'qm list | awk "NR>1 && \$1>=500 && \$1<=599 && \$3==\"running\" && \$1!=590 {bad=1; print >\"/dev/stderr\"} END {exit bad}"'
cd "$REPO"
exec mise exec -- node "$HERE/e2e-desktop.ts"
