#!/usr/bin/env bash
# Guest side of the pve stand (apps/bench `s3`): runs as root in a VM cloned
# from the template, through QGA.
#
#   stand-setup.sh install    install /it/pkg/v1.tar, the S5 pieces the tests
#                             need, start sbx-identity and sbx-agent with the
#                             debug socket; identity from the real smbios
#   stand-setup.sh it-mode    switch to a fake smbios on tmpfs (the layout of
#                             test/linux/run.sh) for the container suite
#   stand-setup.sh real-mode  back to the real smbios
#
# The bundle (/it: pkg/ and integration.test, from run.sh BUILD_ONLY) must be
# unpacked before `install`.
set -euo pipefail

log() { echo "stand-setup: $*" >&2; }

real_config=/var/lib/sbx-stand/agent-real.toml
it_dir=/var/lib/sbx-it

wait_agent() {
	for _ in $(seq 1 90); do
		if [ "$(systemctl is-active sbx-agent.service || true)" = active ] && [ -S /run/sbx-agent/debug.sock ]; then
			return 0
		fi
		sleep 1
	done
	log "the agent did not come up"
	systemctl status sbx-agent --no-pager >&2 || true
	journalctl -u sbx-agent -u sbx-identity --no-pager -n 80 >&2 || true
	return 1
}

restart_identity() {
	# The boot order of a fork: sbx-identity before ssh and the agent.
	rm -f /run/sbx-agent/debug.sock
	systemctl restart sbx-identity.service ssh.service sbx-agent.service
	wait_agent
}

install() {
	# User `user` (spec 20). The template's uid 1000 may be taken.
	if ! id user >/dev/null 2>&1; then
		if getent passwd 1000 >/dev/null; then
			useradd -m -s /bin/bash -G sudo user
		else
			useradd -m -u 1000 -s /bin/bash -G sudo user
		fi
	fi
	echo 'user ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-sbx-user
	chmod 0440 /etc/sudoers.d/90-sbx-user
	mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user
	# Ubuntu's skeleton .bash_logout runs clear_console (S5 contract).
	rm -f /etc/skel/.bash_logout /home/user/.bash_logout /root/.bash_logout

	# sshd per spec 20: loopback only, no passwords, the sbx user CA; plain
	# ssh.service instead of Ubuntu's socket activation (as in the container).
	mkdir -p /etc/sbx /etc/sbx-agent
	: >/etc/sbx/env
	: >/etc/sbx-agent/ssh-user-ca.pub
	: >/etc/ssh/sbx_user_ca.pub
	printf '%s\n' \
		'ListenAddress 127.0.0.1' \
		'ListenAddress ::1' \
		'PasswordAuthentication no' \
		'KbdInteractiveAuthentication no' \
		'TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub' \
		>/etc/ssh/sshd_config.d/50-sbx.conf
	grep -q 'envfile=/etc/sbx/env' /etc/pam.d/sshd ||
		echo 'session required pam_env.so readenv=1 envfile=/etc/sbx/env' >>/etc/pam.d/sshd
	grep -q 'envfile=/run/sbx/secrets/env' /etc/pam.d/sshd ||
		echo 'session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env' >>/etc/pam.d/sshd
	if systemctl list-unit-files ssh.socket >/dev/null 2>&1; then
		systemctl disable --now ssh.socket >/dev/null 2>&1 || true
		rm -f /etc/systemd/system/ssh.service.d/00-socket.conf /etc/systemd/system/ssh.socket.d/addresses.conf
	fi
	systemctl daemon-reload
	systemctl enable ssh.service >/dev/null 2>&1

	# Spec S3 section 20: the agent owns the identity, so cloud-init must not
	# set the hostname or regenerate the host keys on a fork (a new
	# instance for cloud-init). The template 599 keeps cloud-init enabled for
	# the network; S5 disables it.
	if [ -d /etc/cloud/cloud.cfg.d ]; then
		cat >/etc/cloud/cloud.cfg.d/99-sbx-identity.cfg <<'CFG'
preserve_hostname: true
ssh_deletekeys: false
ssh_genkeytypes: []
CFG
	fi

	# agent.toml before the install: --write-config keeps an existing one.
	# A tunnel URL that points nowhere (READY=1 comes before the tunnel),
	# the real smbios (no [identity] section).
	docker=false
	[ -S /run/docker.sock ] && docker=true
	mkdir -p /var/lib/sbx-stand
	cat >"$real_config" <<TOML
[tunnel]
url = "wss://127.0.0.1:9/v1/connect"

[user]
default = "user"

[readiness]
required = ["identity", "claim", "secrets"]

[docker]
enabled = $docker
TOML
	cp "$real_config" /etc/sbx-agent/agent.toml
	mkdir -p "$it_dir"
	cp "$real_config" "$it_dir/agent.toml"

	# The first install runs the binary of the package itself (as S5 does).
	tar -xOf /it/pkg/v1.tar sbx-agent >/tmp/sbx-agent-installer
	chmod 0755 /tmp/sbx-agent-installer
	/tmp/sbx-agent-installer install-package --write-config /it/pkg/v1.tar
	rm -f /tmp/sbx-agent-installer

	mkdir -p /etc/systemd/system/sbx-agent.service.d
	cat >/etc/systemd/system/sbx-agent.service.d/50-debug.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent run --debug-listen unix:/run/sbx-agent/debug.sock --debug-confirm
UNIT
	systemctl daemon-reload
	systemctl enable --now sbx-identity.service sbx-agent.service
	# sbx-identity may have regenerated the host keys.
	systemctl restart ssh.service
	wait_agent
	log "installed"
}

it_mode() {
	# Fake smbios on tmpfs (spec 7.1 format), like run.sh; its BS is random
	# and never reaches the disk.
	mkdir -p "$it_dir/dmi"
	mountpoint -q "$it_dir/dmi" || mount -t tmpfs -o size=1M,mode=0755 tmpfs "$it_dir/dmi"
	python3 - <<'PY'
import base64, os, uuid
mid = str(uuid.uuid4())
bs = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
open("/var/lib/sbx-it/dmi/product_serial", "w").write("sbx1:%s:%s\n" % (mid, bs))
open("/var/lib/sbx-it/dmi/product_uuid", "w").write(mid + "\n")
PY
	{
		cat "$real_config"
		printf '\n[identity]\nsysfs_dir = "%s"\n' "$it_dir/dmi"
	} >"$it_dir/agent.toml"
	cp "$it_dir/agent.toml" /etc/sbx-agent/agent.toml
	restart_identity
}

real_mode() {
	cp "$real_config" /etc/sbx-agent/agent.toml
	cp "$real_config" "$it_dir/agent.toml"
	restart_identity
	if mountpoint -q "$it_dir/dmi"; then umount "$it_dir/dmi"; fi
}

case "${1:-}" in
install) install ;;
it-mode) it_mode ;;
real-mode) real_mode ;;
*)
	echo "usage: stand-setup.sh install|it-mode|real-mode" >&2
	exit 2
	;;
esac
