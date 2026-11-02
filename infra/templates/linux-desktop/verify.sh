#!/usr/bin/env bash
# Desktop-specific image checks. API and streamed media are checked by e2e-desktop.sh.
set -uo pipefail
if [ "${UMIAK_VERIFY_MODE:-}" = tools ]; then exit 0; fi
failed=0
check() { local id=$1; shift; if "$@"; then printf 'CHECK %s PASS\n' "$id"; else printf 'CHECK %s FAIL\n' "$id"; failed=1; fi; }
check desktop_packages dpkg-query -W xserver-xorg-core xserver-xorg-video-dummy lightdm openbox tint2 sunshine google-chrome-stable
check moonlight_binary test -x /opt/umiak-desktop/moonlight-web/current/web-server
check cua_binary test -x /opt/umiak-desktop/cua-driver/current/cua-driver
check desktop_config python3 -I -c 'import tomllib; assert tomllib.load(open("/etc/umiak-agent/agent.toml", "rb"))["desktop"]["enabled"] is True'
check desktop_readiness grep -q '"desktop"' /etc/umiak-agent/agent.toml
check lightdm_managed test "$(systemctl is-enabled lightdm.service 2>/dev/null)" = disabled
check xorg_dummy grep -q 'Driver "dummy"' /etc/X11/xorg.conf.d/10-umiak-dummy.conf
check x11_no_tcp grep -q -- '-nolisten tcp' /etc/lightdm/lightdm.conf.d/50-umiak.conf
# Do not start graphical sessions behind the agent's claim/secrets gate here.
# The real API scenario verifies readiness, input, clipboard and screenshot together.
exit "$failed"
