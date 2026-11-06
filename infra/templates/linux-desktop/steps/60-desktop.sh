#!/usr/bin/env bash
# Sigstore certificate issuer verification below protects the downloaded guest tool; it is not platform authentication.
# Desktop packages inherit the parent recipe's apt snapshot and Chrome pin.
set -euo pipefail
# shellcheck source=SCRIPTDIR/../../linux/lib.sh
. "$(dirname "$0")/../lib.sh"

apt_install xserver-xorg-core xserver-xorg-video-dummy xserver-xorg-input-libinput \
 x11-xserver-utils dbus-x11 lightdm lightdm-gtk-greeter openbox tint2 \
 xfce4-terminal pcmanfm fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 fonts-dejavu-core at-spi2-core pipewire pipewire-pulse wireplumber xdotool xclip scrot conntrack

sunshine=$(toml_get desktop.sunshine.version)
moonlight=$(toml_get desktop.moonlight_web.version)
cua=$(toml_get desktop.cua_driver.version)
cosign=$(toml_get desktop.cosign.version)
fetch_verify "https://github.com/LizardByte/Sunshine/releases/download/v${sunshine}/sunshine_${sunshine}-1%2Bubuntu26.04_amd64.deb" \
 "$(toml_get desktop.sunshine.sha256)" "$UMIAK_WORK_DIR/sunshine.deb"
apt_install "$UMIAK_WORK_DIR/sunshine.deb"

fetch_verify "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v${moonlight}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz" \
 "$(toml_get desktop.moonlight_web.sha256)" "$UMIAK_WORK_DIR/moonlight-web.tar.gz"
fetch_verify "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cua}/cua-driver-rs-${cua}-linux-x86_64-binary.tar.gz" \
 "$(toml_get desktop.cua_driver.sha256)" "$UMIAK_WORK_DIR/cua-driver.tar.gz"
fetch_verify "https://github.com/sigstore/cosign/releases/download/v${cosign}/cosign-linux-amd64" \
 "$(toml_get desktop.cosign.sha256)" "$UMIAK_WORK_DIR/cosign"
chmod 0755 "$UMIAK_WORK_DIR/cosign"
# Pin cosign's TUF cache: steps run through the guest agent without HOME, where
# cosign 3 has no ~/.sigstore. Capture copies the authenticated trust root from here.
export TUF_ROOT="$UMIAK_WORK_DIR/sigstore-tuf"
cua_identity="https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v${cua}"
cua_issuer=https://token.actions.githubusercontent.com
if [ "${UMIAK_LAYER_MODE:-}" = replay ]; then
 cp "$UMIAK_LAYER_ROOT/inputs/desktop/cua-driver.sigstore.json" "$UMIAK_WORK_DIR/cua-driver.sigstore.json"
 # The upstream bundle uses cosign's legacy format, for which --trusted-root is
 # rejected. Verify offline with the keys of the trust root that TUF
 # authenticated during capture: Fulcio roots plus one Rekor and one CT key
 # per file (cosign reads only the first key of a file). Never skip on failure.
 keys="$UMIAK_WORK_DIR/sigstore-offline"
 install -d -m 0700 "$keys"
 python3 -I - "$UMIAK_LAYER_ROOT/inputs/desktop/trusted_root.json" "$keys" <<'PY'
import json, sys, textwrap
root, out = json.load(open(sys.argv[1])), sys.argv[2]
def pem(kind, raw):
    return f"-----BEGIN {kind}-----\n" + textwrap.fill(raw, 64) + f"\n-----END {kind}-----\n"
certs = [c["rawBytes"] for ca in root["certificateAuthorities"] for c in ca["certChain"]["certificates"]]
open(f"{out}/fulcio.pem", "w").write("".join(pem("CERTIFICATE", c) for c in certs))
for name in ("tlogs", "ctlogs"):
    for i, log in enumerate(root[name]):
        open(f"{out}/{name}-{i}.pub", "w").write(pem("PUBLIC KEY", log["publicKey"]["rawBytes"]))
PY
 verified=
 for rekor_key in "$keys"/tlogs-*.pub; do
  for ct_key in "$keys"/ctlogs-*.pub; do
   if SIGSTORE_ROOT_FILE="$keys/fulcio.pem" SIGSTORE_REKOR_PUBLIC_KEY="$rekor_key" SIGSTORE_CT_LOG_PUBLIC_KEY_FILE="$ct_key" \
    "$UMIAK_WORK_DIR/cosign" verify-blob --offline --bundle "$UMIAK_WORK_DIR/cua-driver.sigstore.json" \
    --certificate-identity "$cua_identity" --certificate-oidc-issuer "$cua_issuer" "$UMIAK_WORK_DIR/cua-driver.tar.gz"; then
    verified=1
    break 2
   fi
  done
 done
 [ -n "$verified" ] || die "Cua Driver signature failed offline verification against the captured Sigstore trust root"
else
 curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 --max-time 300 "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cua}/cua-driver-rs-${cua}-linux-x86_64-binary.tar.gz.sigstore.json" -o "$UMIAK_WORK_DIR/cua-driver.sigstore.json"
 "$UMIAK_WORK_DIR/cosign" verify-blob --bundle "$UMIAK_WORK_DIR/cua-driver.sigstore.json" \
  --certificate-identity "$cua_identity" --certificate-oidc-issuer "$cua_issuer" "$UMIAK_WORK_DIR/cua-driver.tar.gz"
fi
if [ "${UMIAK_LAYER_MODE:-}" = capture ]; then
 mkdir -p "$UMIAK_CAPTURE_DIR/inputs/desktop"
 cp "$UMIAK_WORK_DIR/cua-driver.sigstore.json" "$UMIAK_CAPTURE_DIR/inputs/desktop/"
 # This trust root was just authenticated by cosign's TUF client, not downloaded unauthenticated.
 trusted_root="$TUF_ROOT/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"
 [ -s "$trusted_root" ] || die "cosign TUF trust root missing at $trusted_root"
 cp "$trusted_root" "$UMIAK_CAPTURE_DIR/inputs/desktop/"
fi

install -d -o user -g user -m 0700 /home/user/.local/state
install -d -m 0755 "/opt/umiak-desktop/moonlight-web/$moonlight" "/opt/umiak-desktop/cua-driver/$cua"
tar -xzf "$UMIAK_WORK_DIR/moonlight-web.tar.gz" -C "/opt/umiak-desktop/moonlight-web/$moonlight" --strip-components=1 --no-same-owner
tar -xzf "$UMIAK_WORK_DIR/cua-driver.tar.gz" -C "/opt/umiak-desktop/cua-driver/$cua" --no-same-owner
ln -sfn "$moonlight" /opt/umiak-desktop/moonlight-web/current
ln -sfn "$cua" /opt/umiak-desktop/cua-driver/current
# Upstream v3.0.1 ships web-server as 0644; normalize verified binaries.
chmod 0755 /opt/umiak-desktop/moonlight-web/current/web-server /opt/umiak-desktop/cua-driver/current/cua-driver
# Upstream archive layout is checked explicitly, never guessed at runtime.
[ -x /opt/umiak-desktop/moonlight-web/current/web-server ] || die "moonlight-web executable missing"
[ -x /opt/umiak-desktop/cua-driver/current/cua-driver ] || die "cua-driver executable missing"
id umiakstream >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/umiak-stream --shell /usr/sbin/nologin umiakstream
install -d -m 0755 /etc/umiak-desktop
# Keep upstream required defaults; the adapter creates private per-identity state later.
/opt/umiak-desktop/moonlight-web/current/web-server --config-path /etc/umiak-desktop/moonlight.json config generate
python3 -I - <<'PY'
import json
from pathlib import Path
p = Path('/etc/umiak-desktop/moonlight.json')
c = json.loads(p.read_text())
c['web_server'].update(bind_address='127.0.0.1:47800', first_login_create_admin=True,
 first_login_assign_global_hosts=False, forwarded_header={'username_header': 'X-Umiak-Desktop-User', 'auto_create_missing_user': False})
c['webrtc'].update(ice_servers=[], ice_server_script='/usr/local/lib/umiak-desktop/ice-servers')
p.write_text(json.dumps(c, indent=2) + '\n')
PY
for path in etc/X11/xorg.conf.d/10-umiak-dummy.conf etc/lightdm/lightdm.conf.d/50-umiak.conf \
 etc/systemd/system/lightdm.service.d/10-umiak.conf etc/systemd/user/cua-driver.service \
 etc/opt/chrome/policies/managed/umiak.json usr/share/xsessions/umiak.desktop etc/xdg/openbox/autostart \
 etc/umiak-desktop/sunshine.conf etc/systemd/system/umiak-moonlight-web.service \
 etc/systemd/system/umiak-sunshine.service etc/systemd/user/umiak-session.service; do
 install_file "$path"
done
install_file usr/local/lib/umiak-desktop/session 0755
install_file usr/local/lib/umiak-desktop/ice-servers 0755
for line in 'session required pam_env.so readenv=1 envfile=/etc/umiak/env' \
 'session required pam_env.so readenv=1 envfile=/run/umiak/secrets/env'; do
 grep -qxF "$line" /etc/pam.d/lightdm-autologin || printf '%s\n' "$line" >>/etc/pam.d/lightdm-autologin
done
printf 'uinput\n' >/etc/modules-load.d/umiak-uinput.conf
systemctl disable --now lightdm.service
systemctl --global disable app-dev.lizardbyte.app.Sunshine.service
systemctl daemon-reload
if [ "${UMIAK_GENERIC_IMAGE:-}" = 1 ]; then
 install -D -m 0644 "$UMIAK_FILES_DIR/etc/opt/chrome/policies/managed/umiak.json" /etc/chromium/policies/managed/umiak.json
 as_user xdg-settings set default-web-browser chromium.desktop
 update-alternatives --set x-www-browser /usr/bin/chromium
else
 as_user xdg-settings set default-web-browser google-chrome.desktop
 update-alternatives --set x-www-browser /usr/bin/google-chrome-stable
fi
install -d -m 0755 /usr/share/doc/umiak-desktop
install -m 0644 /usr/share/common-licenses/GPL-3 /usr/share/doc/umiak-desktop/GPL-3.0.txt
cat >/usr/share/doc/umiak-desktop/SOURCES.txt <<SOURCES
Sunshine v${sunshine}: https://github.com/LizardByte/Sunshine/tree/v${sunshine}
Complete source: https://github.com/LizardByte/Sunshine/archive/refs/tags/v${sunshine}.tar.gz
moonlight-web-stream v${moonlight}: https://github.com/MrCreativ3001/moonlight-web-stream/tree/v${moonlight}
Complete source: https://github.com/MrCreativ3001/moonlight-web-stream/archive/refs/tags/v${moonlight}.tar.gz
Both programs are distributed under GPLv3; retain their license and copyright notices.
The signed layer inventory records the exact versions, notices and corresponding source locations.
SOURCES
log "desktop installed; session startup and streaming stay under agent control"
