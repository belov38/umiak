#!/usr/bin/env bash
# Native Ubuntu stable-release Chromium; never install the Ubuntu snap transition package.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
readarray -t pins < <(python3 -I - "$UMIAK_BUILD_DIR/layer-inputs.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))['chromium']
print(c['version']); print(c['keyFingerprint'])
PY
)
v=${pins[0]}
fpr=${pins[1]}
if [ "${UMIAK_LAYER_MODE:-}" = replay ]; then
 install -D -m 0644 "$UMIAK_LAYER_ROOT/apt/xtradeb-resolute/archive.asc" /etc/apt/keyrings/xtradeb-apps.asc
else
 install -D -m 0644 "$UMIAK_BUILD_DIR/xtradeb-apps.asc" /etc/apt/keyrings/xtradeb-apps.asc
 [ "$(gpg_primary_fprs /etc/apt/keyrings/xtradeb-apps.asc)" = "$fpr" ] || die 'xtradeb key fingerprint mismatch'
 cat >/etc/apt/sources.list.d/xtradeb.sources <<'SOURCE'
Types: deb
URIs: https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/
Suites: resolute
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/xtradeb-apps.asc
SOURCE
 # Do not let the PPA replace any unrelated Ubuntu package.
 cat >/etc/apt/preferences.d/umiak-chromium <<'PREF'
Package: *
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 1

Package: chromium chromium-common chromium-sandbox
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 1001
PREF
 apt_update
fi
python3 -I - "$UMIAK_BUILD_DIR/layer-inputs.json" <<'PYCHECK'
import json,subprocess,sys
c=json.load(open(sys.argv[1]))['chromium']
for name, sha in c['packages'].items():
    text=subprocess.check_output(['apt-cache','show',f"{name}={c['version']}"],text=True)
    hashes=[l.split(':',1)[1].strip() for l in text.splitlines() if l.startswith('SHA256:')]
    if not hashes or set(hashes) != {sha}: sys.exit(f'{name}: apt package differs from the pinned stable build')
PYCHECK
apt_install "chromium=$v" "chromium-common=$v" "chromium-sandbox=$v"
# Preserve executable discovery for existing CDP clients, with Chromium underneath.
ln -sfn /usr/bin/chromium /usr/local/bin/google-chrome
ln -sfn /usr/bin/chromium /usr/local/bin/google-chrome-stable
[ -s /usr/share/doc/chromium/copyright ] || die 'Chromium redistribution notices missing'
! dpkg-query -W -f '${db:Status-Status}' snapd 2>/dev/null | grep -qx installed || die 'snapd was unexpectedly installed'
