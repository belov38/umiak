#!/usr/bin/env bash
# Runs in the fresh guest from its authenticated, read-only offline media.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
layer=/mnt/layer
backup=/var/lib/umiak-offline-sources
[ -s "$layer/apt/offline.sources" ] || { echo 'offline apt sources missing' >&2; exit 1; }
# Refuse accidental network sources even when the guest NIC is disconnected.
python3 -I - "$layer/apt/offline.sources" <<'PY'
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
uris = [line.split(':', 1)[1].strip().split() for line in text.splitlines() if line.startswith('URIs:')]
if not uris or any(not values or any(not url.startswith('file:///mnt/layer/apt/') for url in values) for values in uris):
    sys.exit('offline replay requires file-only apt repositories')
if 'trusted=' in text.lower() or 'trusted:' in text.lower() or 'allow-insecure' in text.lower():
    sys.exit('offline replay must retain upstream apt authentication')
PY
if [ ! -d "$backup" ]; then
 mkdir -m 0700 "$backup"
 python3 -I - "$backup" <<'PY'
import sys
from pathlib import Path
backup = Path(sys.argv[1])
for p in [Path('/etc/apt/sources.list'), *Path('/etc/apt/sources.list.d').glob('*.list'), *Path('/etc/apt/sources.list.d').glob('*.sources')]:
    if p.is_file(): p.rename(backup / p.name)
PY
fi
install -m 0644 "$layer/apt/offline.sources" /etc/apt/sources.list.d/umiak-offline.sources
cat >/etc/apt/apt.conf.d/99umiak-offline <<'CONF'
Acquire::Languages "none";
Acquire::By-Hash "false";
Acquire::Retries "0";
CONF
# Apply captured repository priorities before even the QGA dependency transaction.
# The PPA is allowed to supply only the three Chromium packages.
python3 -I - <<'PYPREF'
from pathlib import Path
import shutil
for p in Path('/mnt/layer/build/apt-after').glob('*.pref'):
    shutil.copyfile(p,Path('/etc/apt/preferences.d')/p.name.removesuffix('.pref'))
PYPREF
touch /etc/umiak-offline-replay
apt-get -q -y update --error-on=any
apt-get -q -y --no-install-recommends install qemu-guest-agent
# This runs from cloud-init bootcmd (init-local). qemu-guest-agent is ordered
# after early boot, which waits for this very script: a synchronous start
# deadlocks. Queue the start; the host waits for QGA to answer.
systemctl start --no-block qemu-guest-agent
if [ -s "$layer/licenses/inventory.json" ]; then
 install -d -m 0755 /usr/share/doc/umiak-template
 cp -a "$layer/licenses/." /usr/share/doc/umiak-template/
fi
