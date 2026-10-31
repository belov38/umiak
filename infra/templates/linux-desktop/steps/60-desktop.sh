#!/usr/bin/env bash
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
 "$(toml_get desktop.sunshine.sha256)" "$SBX_WORK_DIR/sunshine.deb"
apt_install "$SBX_WORK_DIR/sunshine.deb"

fetch_verify "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v${moonlight}/moonlight-web-x86_64-unknown-linux-gnu.tar.gz" \
 "$(toml_get desktop.moonlight_web.sha256)" "$SBX_WORK_DIR/moonlight-web.tar.gz"
fetch_verify "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cua}/cua-driver-rs-${cua}-linux-x86_64-binary.tar.gz" \
 "$(toml_get desktop.cua_driver.sha256)" "$SBX_WORK_DIR/cua-driver.tar.gz"
fetch_verify "https://github.com/sigstore/cosign/releases/download/v${cosign}/cosign-linux-amd64" \
 "$(toml_get desktop.cosign.sha256)" "$SBX_WORK_DIR/cosign"
chmod 0755 "$SBX_WORK_DIR/cosign"
curl -fsSL --retry 5 "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cua}/cua-driver-rs-${cua}-linux-x86_64-binary.tar.gz.sigstore.json" -o "$SBX_WORK_DIR/cua-driver.sigstore.json"
"$SBX_WORK_DIR/cosign" verify-blob --bundle "$SBX_WORK_DIR/cua-driver.sigstore.json" \
 --certificate-identity "https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v${cua}" \
 --certificate-oidc-issuer https://token.actions.githubusercontent.com "$SBX_WORK_DIR/cua-driver.tar.gz"

install -d -m 0755 "/opt/sbx-desktop/moonlight-web/$moonlight" "/opt/sbx-desktop/cua-driver/$cua"
tar -xzf "$SBX_WORK_DIR/moonlight-web.tar.gz" -C "/opt/sbx-desktop/moonlight-web/$moonlight" --strip-components=1 --no-same-owner
tar -xzf "$SBX_WORK_DIR/cua-driver.tar.gz" -C "/opt/sbx-desktop/cua-driver/$cua" --no-same-owner
ln -sfn "$moonlight" /opt/sbx-desktop/moonlight-web/current
ln -sfn "$cua" /opt/sbx-desktop/cua-driver/current
# Upstream archive layout is checked explicitly, never guessed at runtime.
[ -x /opt/sbx-desktop/moonlight-web/current/web-server ] || die "moonlight-web executable missing"
[ -x /opt/sbx-desktop/cua-driver/current/cua-driver ] || die "cua-driver executable missing"
id sbxstream >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/sbx-stream --shell /usr/sbin/nologin sbxstream
install -d -m 0755 /etc/sbx-desktop
# Keep upstream required defaults; the adapter creates private per-identity state later.
/opt/sbx-desktop/moonlight-web/current/web-server --config-path /etc/sbx-desktop/moonlight.json config generate
python3 -I - <<'PY'
import json
from pathlib import Path
p = Path('/etc/sbx-desktop/moonlight.json')
c = json.loads(p.read_text())
c['web_server'].update(bind_address='127.0.0.1:47800', first_login_create_admin=True,
 first_login_assign_global_hosts=False, forwarded_header={'username_header': 'X-Sbx-Desktop-User', 'auto_create_missing_user': False})
c['webrtc'].update(ice_servers=[], ice_server_script='/usr/local/lib/sbx-desktop/ice-servers')
p.write_text(json.dumps(c, indent=2) + '\n')
PY
for path in etc/X11/xorg.conf.d/10-sbx-dummy.conf etc/lightdm/lightdm.conf.d/50-sbx.conf \
 etc/systemd/system/lightdm.service.d/10-sbx.conf etc/systemd/user/cua-driver.service \
 etc/opt/chrome/policies/managed/sbx.json usr/share/xsessions/sbx.desktop etc/xdg/openbox/autostart \
 etc/sbx-desktop/sunshine.conf etc/systemd/system/sbx-moonlight-web.service \
 etc/systemd/system/sbx-sunshine.service etc/systemd/user/sbx-session.service; do
 install_file "$path"
done
install_file usr/local/lib/sbx-desktop/session 0755
install_file usr/local/lib/sbx-desktop/ice-servers 0755
for line in 'session required pam_env.so readenv=1 envfile=/etc/sbx/env' \
 'session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env'; do
 grep -qxF "$line" /etc/pam.d/lightdm-autologin || printf '%s\n' "$line" >>/etc/pam.d/lightdm-autologin
done
printf 'uinput\n' >/etc/modules-load.d/sbx-uinput.conf
systemctl disable --now lightdm.service
systemctl --global disable app-dev.lizardbyte.app.Sunshine.service
systemctl daemon-reload
as_user xdg-settings set default-web-browser google-chrome.desktop
update-alternatives --set x-www-browser /usr/bin/google-chrome-stable
log "desktop installed; session startup and streaming stay under agent control"
