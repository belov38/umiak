#!/usr/bin/env bash
# Guest side of the pve stand (apps/bench `s3`): runs as root in a VM cloned
# from the template, through QGA.
#
#   stand-setup.sh install    install /it/pkg/v1.tar, the S5 pieces the tests
#                             need, start umiak-identity and umiak-agent with the
#                             debug socket; identity from the real smbios
#   stand-setup.sh it-mode    switch to a fake smbios on tmpfs (the layout of
#                             test/linux/run.sh) for the container suite
#   stand-setup.sh real-mode  back to the real smbios
#
# The bundle (/it: pkg/ and integration.test, from run.sh BUILD_ONLY) must be
# unpacked before `install`.
set -euo pipefail

log() { echo "stand-setup: $*" >&2; }

real_config=/var/lib/umiak-stand/agent-real.toml
it_dir=/var/lib/umiak-it

wait_agent() {
	for _ in $(seq 1 90); do
		if [ "$(systemctl is-active umiak-agent.service || true)" = active ] && [ -S /run/umiak-agent/debug.sock ]; then
			return 0
		fi
		sleep 1
	done
	log "the agent did not come up"
	systemctl status umiak-agent --no-pager >&2 || true
	journalctl -u umiak-agent -u umiak-identity --no-pager -n 80 >&2 || true
	return 1
}

restart_identity() {
	# The boot order of a fork: umiak-identity before ssh and the agent.
	rm -f /run/umiak-agent/debug.sock
	systemctl restart umiak-identity.service ssh.service umiak-agent.service
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
	echo 'user ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-umiak-user
	chmod 0440 /etc/sudoers.d/90-umiak-user
	mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user
	# Ubuntu's skeleton .bash_logout runs clear_console (S5 contract).
	rm -f /etc/skel/.bash_logout /home/user/.bash_logout /root/.bash_logout

	# sshd per spec 20: loopback only, no passwords, the umiak user CA; plain
	# ssh.service instead of Ubuntu's socket activation (as in the container).
	mkdir -p /etc/umiak /etc/umiak-agent
	: >/etc/umiak/env
	: >/etc/umiak-agent/ssh-user-ca.pub
	: >/etc/ssh/umiak_user_ca.pub
	printf '%s\n' \
		'ListenAddress 127.0.0.1' \
		'ListenAddress ::1' \
		'PasswordAuthentication no' \
		'KbdInteractiveAuthentication no' \
		'TrustedUserCAKeys /etc/ssh/umiak_user_ca.pub' \
		>/etc/ssh/sshd_config.d/50-umiak.conf
	grep -q 'envfile=/etc/umiak/env' /etc/pam.d/sshd ||
		echo 'session required pam_env.so readenv=1 envfile=/etc/umiak/env' >>/etc/pam.d/sshd
	grep -q 'envfile=/run/umiak/secrets/env' /etc/pam.d/sshd ||
		echo 'session required pam_env.so readenv=1 envfile=/run/umiak/secrets/env' >>/etc/pam.d/sshd
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
		cat >/etc/cloud/cloud.cfg.d/99-umiak-identity.cfg <<'CFG'
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
	mkdir -p /var/lib/umiak-stand
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
	cp "$real_config" /etc/umiak-agent/agent.toml
	mkdir -p "$it_dir"
	cp "$real_config" "$it_dir/agent.toml"

	# The first install runs the binary of the package itself (as S5 does).
	tar -xOf /it/pkg/v1.tar umiak-agent >/tmp/umiak-agent-installer
	chmod 0755 /tmp/umiak-agent-installer
	/tmp/umiak-agent-installer install-package --write-config /it/pkg/v1.tar
	rm -f /tmp/umiak-agent-installer

	mkdir -p /etc/systemd/system/umiak-agent.service.d
	cat >/etc/systemd/system/umiak-agent.service.d/50-debug.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/lib/umiak-agent/current/umiak-agent run --debug-listen unix:/run/umiak-agent/debug.sock --debug-confirm
UNIT
	systemctl daemon-reload
	systemctl enable --now umiak-identity.service umiak-agent.service
	# umiak-identity may have regenerated the host keys.
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
open("/var/lib/umiak-it/dmi/product_serial", "w").write("umiak1:%s:%s\n" % (mid, bs))
open("/var/lib/umiak-it/dmi/product_uuid", "w").write(mid + "\n")
PY
	{
		cat "$real_config"
		printf '\n[identity]\nsysfs_dir = "%s"\n' "$it_dir/dmi"
	} >"$it_dir/agent.toml"
	cp "$it_dir/agent.toml" /etc/umiak-agent/agent.toml
	restart_identity
}

real_mode() {
	cp "$real_config" /etc/umiak-agent/agent.toml
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
