#!/usr/bin/env bash
# Read-only snapshot before S16 deployment. No credentials are printed.
set -euo pipefail
pve_host=${UMIAK_SETUP_SSH:-pve}
ct_host=${UMIAK_DEVCP_SSH:-umiak@100.64.10.7}
ssh -o BatchMode=yes "$pve_host" 'qm list'
ssh -o BatchMode=yes "$pve_host" 'pvesh get /cluster/resources --type vm --output-format json' |
 python3 -c 'import json,sys; rows=[r for r in json.load(sys.stdin) if 500<=int(r["vmid"])<=589 and r.get("status")=="running"]; used=sum(r.get("maxmem",0) for r in rows); print("Running sandbox RAM bytes:",used); sys.exit(0 if used<=8*1024**3 else 1)'
ssh -o BatchMode=yes "$ct_host" 'cd ~/umiak/deploy/compose && sha256sum secrets/gateway/ca.pem secrets/gateway/tunnel.pem secrets/gateway/umiak.pem && docker compose ps --format "{{.Service}} {{.Status}}"'
