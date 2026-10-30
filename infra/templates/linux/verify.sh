#!/usr/bin/env bash
# shellcheck disable=SC2319 # `report <id> $?` takes the status of the test right above it
# Guest checks of a template build (spec S5 section 10). Runs as root with
# `bash -s`; stdin is `export MACHINE_ID=<uuid>; export EXPECT_SUBNET=<cidr>`
# followed by this file. Output:
#   CHECK <id> <PASS|FAIL|INFO> <evidence>   one line per check
#   TOOLS <json>                             {"<tool>": {"direct": ..., "login": ...}}
# A tool value is the first line of its version output, the resolved path for
# the command -v tools, "missing" when the command is not found, or
# "error: rc=<n> <first line>" when it fails.
# SBX_VERIFY_MODE=tools prints only the TOOLS line (the build manifest).
#
# Check ids (spec 10 item): os kernel systemd (1); cmdline machine_id (2);
# swap (3); listen_tcp listen_udp (4); sshd_config ssh_host_keys (5); pam (6);
# cloudinit netplan ipv4 (7); user sudo linger no_other_users
# passwords_locked no_authorized_keys (8); dns https wait_online (12);
# system_running failed_units jobs masked_units purged_absent (13);
# leftovers (14); sysctl userns (15); disk_size fstrim (17); kvm (19, INFO);
# bash_logout no_tailscale no_unattended no_ci_drive hostname.
set -uo pipefail

STD_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH=$STD_PATH LC_ALL=C.UTF-8

# Same lists as lib.sh (this script runs on its own, without the seed).
PURGED=(snapd 'apport*' unattended-upgrades 'ubuntu-pro-client*' update-notifier-common landscape-common pollinate fwupd modemmanager multipath-tools open-iscsi udisks2 lxd-installer ufw open-vm-tools rsyslog sysstat avahi-daemon 'cups*' 'tailscale*' systemd-zram-generator)
MASKED=(apt-daily.timer apt-daily-upgrade.timer motd-news.timer man-db.timer e2scrub_all.timer systemd-oomd.service systemd-oomd.socket)

# report <id> <0|1|INFO> <evidence...>: 0 is PASS, anything else FAIL.
report() {
	local id=$1 st=$2 ev
	shift 2
	case $st in
	0) st=PASS ;;
	INFO) ;;
	*) st=FAIL ;;
	esac
	ev=$(printf '%s' "$*" | tr '\n\t\r' '   ' | tr -s ' ')
	printf 'CHECK %s %s %s\n' "$id" "$st" "${ev:0:600}"
}

installed_packages() {
	local status pkg pat
	dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 2>/dev/null |
		while read -r status pkg; do
			[ "${status:1:1}" = n ] && continue
			for pat in "$@"; do
				# shellcheck disable=SC2254 # $pat is a glob on purpose
				case $pkg in $pat)
					echo "$pkg"
					break
					;;
				esac
			done
		done
}

# ip_in_cidr <a.b.c.d> <net/len>
ip_in_cidr() {
	local ip=$1 net=${2%/*} len=${2#*/} a b c d n1 n2 mask
	IFS=. read -r a b c d <<<"$ip"
	n1=$(((a << 24) | (b << 16) | (c << 8) | d))
	IFS=. read -r a b c d <<<"$net"
	n2=$(((a << 24) | (b << 16) | (c << 8) | d))
	mask=$(((0xffffffff << (32 - len)) & 0xffffffff))
	[ $((n1 & mask)) -eq $((n2 & mask)) ]
}

check_system() {
	local v k n rc
	v=$(. /etc/os-release && echo "$VERSION_ID")
	[ "$v" = 26.04 ]
	report os $? "VERSION_ID=$v"

	k=$(compgen -G '/boot/vmlinuz-*' | tr '\n' ' ')
	n=$(compgen -G '/boot/vmlinuz-*' | wc -l)
	[ "$n" -eq 1 ] && [[ $(uname -r) == *-generic ]] && [[ $k == *"/vmlinuz-$(uname -r) "* ]]
	report kernel $? "running $(uname -r); /boot: $k"

	v=$(systemctl --version | awk 'NR == 1 { print $2 }')
	[ "${v%%.*}" -ge 257 ] 2>/dev/null
	report systemd $? "systemd $v"

	grep -qw 'systemd.machine_id=firmware' /proc/cmdline
	report cmdline $? "$(cat /proc/cmdline)"

	local mid uuid want
	mid=$(cat /etc/machine-id 2>/dev/null)
	uuid=$(tr -d '-' </sys/class/dmi/id/product_uuid 2>/dev/null | tr 'A-F' 'a-f')
	want=$(printf '%s' "${MACHINE_ID:-}" | tr -d '-' | tr 'A-F' 'a-f')
	[ -n "$mid" ] && [ "$mid" = "$uuid" ] && [ "$mid" = "$want" ]
	report machine_id $? "machine-id=$mid product_uuid=$uuid MACHINE_ID=$want"

	local sw fst zram
	sw=$(swapon --show --noheadings 2>&1)
	fst=$(awk '$1 !~ /^#/ && $3 == "swap"' /etc/fstab)
	zram=$(compgen -G '/sys/block/zram*' | tr '\n' ' ')
	[ -z "$sw$fst$zram" ]
	report swap $? "swapon=[$sw] fstab=[$fst] zram=[$zram]"

	rc=0
	[ "$(timeout 120 systemctl is-system-running --wait 2>/dev/null)" = running ] || rc=1
	report system_running $rc "$(systemctl is-system-running 2>&1)"

	local failed jobs
	failed=$(systemctl list-units --failed --plain --no-legend 2>&1)
	[ -z "$failed" ]
	report failed_units $? "${failed:-none}"
	jobs=$(systemctl list-jobs --plain --no-legend 2>&1)
	[ -z "$jobs" ]
	report jobs $? "${jobs:-none}"

	local u st bad=() ev=()
	for u in "${MASKED[@]}"; do
		st=$(systemctl is-enabled "$u" 2>/dev/null)
		[ -z "$st" ] && st=not-found
		ev+=("$u=$st")
		case $st in masked | not-found) ;; *) bad+=("$u") ;; esac
		systemctl -q is-active "$u" && bad+=("$u active")
	done
	[ "${#bad[@]}" -eq 0 ]
	report masked_units $? "${ev[*]}${bad:+; bad: ${bad[*]}}"

	local left
	left=$(installed_packages "${PURGED[@]}" | tr '\n' ' ')
	[ -z "$left" ]
	report purged_absent $? "${left:-none installed}"

	local unatt
	unatt="$(installed_packages unattended-upgrades) apt-daily.timer=$(systemctl is-enabled apt-daily.timer 2>&1) apt-daily-upgrade.timer=$(systemctl is-enabled apt-daily-upgrade.timer 2>&1)"
	[ -z "$(installed_packages unattended-upgrades)" ] &&
		[ "$(systemctl is-enabled apt-daily.timer 2>/dev/null)" = masked ] &&
		[ "$(systemctl is-enabled apt-daily-upgrade.timer 2>/dev/null)" = masked ]
	report no_unattended $? "$unatt"

	local ts
	ts="pkg=[$(installed_packages 'tailscale*' | tr '\n' ' ')] units=[$(systemctl list-unit-files --no-legend 'tailscale*' 2>/dev/null | tr '\n' ' ')] bin=[$(command -v tailscale tailscaled 2>/dev/null | tr '\n' ' ')]"
	[ "$ts" = "pkg=[] units=[] bin=[]" ]
	report no_tailscale $? "$ts"

	local sys
	sys=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns fs.inotify.max_user_watches fs.inotify.max_user_instances 2>&1 | tr '\n' ' ')
	[ "$sys" = "0 524288 1024 " ]
	report sysctl $? "apparmor_restrict_unprivileged_userns, max_user_watches, max_user_instances = $sys"

	local size
	size=$(df -B1 --output=size / | tail -n1 | tr -d ' ')
	[ "$size" -ge $((60 * 1024 ** 3)) ] && [ "$size" -le $((64 * 1024 ** 3)) ]
	report disk_size $? "root fs $size bytes ($((size / 1024 ** 3)) GiB)"
	local trim
	trim=$(fstrim -v / 2>&1)
	report fstrim $? "$trim"

	if grep -qwE 'vmx|svm' /proc/cpuinfo; then
		if [ ! -e /dev/kvm ]; then
			report kvm INFO "unavailable: vmx/svm present, no /dev/kvm"
		elif sudo -n -u user sh -c 'exec 3<>/dev/kvm' 2>/dev/null; then
			report kvm INFO "available"
		else
			report kvm INFO "unavailable: user cannot open /dev/kvm rw ($(stat -c '%U:%G %a' /dev/kvm))"
		fi
	else
		report kvm INFO "unavailable: no vmx/svm in /proc/cpuinfo"
	fi
}

check_network() {
	local tcp udp bad=() line addr proc
	tcp=$(ss -H -tlnp 2>&1)
	while read -r _ _ _ addr _ proc; do
		[ -z "$addr" ] && continue
		addr=${addr/\%lo:/:}
		case "$addr|$proc" in
		127.0.0.1:22\|*'"systemd"'* | 127.0.0.1:22\|*'"sshd'* | '[::1]:22|'*'"systemd"'* | '[::1]:22|'*'"sshd'*) ;;
		127.0.0.53:53\|*systemd-resolve* | 127.0.0.54:53\|*systemd-resolve*) ;;
		*) bad+=("$addr $proc") ;;
		esac
	done <<<"$tcp"
	grep -q ' 127.0.0.1:22 ' <<<"$tcp" && grep -q ' \[::1\]:22 ' <<<"$tcp"
	local both=$?
	[ "${#bad[@]}" -eq 0 ] && [ "$both" -eq 0 ]
	report listen_tcp $? "$(awk '{ print $4, $6 }' <<<"$tcp" | tr '\n' ';')${bad:+ unexpected: ${bad[*]}}"

	bad=()
	udp=$(ss -H -ulnp 2>&1)
	while read -r _ _ _ addr _ proc; do
		[ -z "$addr" ] && continue
		addr=${addr/\%lo:/:}
		case "$addr|$proc" in
		127.0.0.53:53\|*systemd-resolve* | 127.0.0.54:53\|*systemd-resolve*) ;;
		127.0.0.1:323\|*chronyd* | '[::1]:323|'*chronyd*) ;;
		*%en*:68\|*systemd-network*) ;;
		*) bad+=("$addr $proc") ;;
		esac
	done <<<"$udp"
	[ "${#bad[@]}" -eq 0 ]
	report listen_udp $? "$(awk '{ print $4, $6 }' <<<"$udp" | tr '\n' ';')${bad:+ unexpected: ${bad[*]}}"

	local sshd_t ok=0 eff
	# sshd -T needs the privilege separation directory, which the socket
	# activated sshd creates only per connection.
	install -d -m 0755 /run/sshd
	sshd_t=$(sshd -T 2>&1)
	for line in 'passwordauthentication no' 'trustedusercakeys /etc/ssh/sbx_user_ca.pub' 'listenaddress 127.0.0.1:22' 'listenaddress [::1]:22'; do
		grep -qxF "$line" <<<"$sshd_t" || ok=1
	done
	eff=$(grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|trustedusercakeys|listenaddress) ' <<<"$sshd_t" | tr '\n' ';')
	report sshd_config $ok "${eff:-$sshd_t}"

	local boot keys k old=()
	boot=$(awk '/^btime/ { print $2 }' /proc/stat)
	keys=$(compgen -G '/etc/ssh/ssh_host_*_key' | tr '\n' ' ')
	for k in $keys; do
		[ "$(stat -c %Y "$k")" -ge "$boot" ] || old+=("$k")
	done
	[ -n "$keys" ] && [ -e /etc/ssh/ssh_host_ed25519_key ] && [ "${#old[@]}" -eq 0 ]
	report ssh_host_keys $? "boot $boot; keys: $keys${old:+; older than boot: ${old[*]}}"

	ok=0
	for line in 'session required pam_env.so readenv=1 envfile=/etc/sbx/env' 'session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env'; do
		grep -qxF "$line" /etc/pam.d/sshd || ok=1
	done
	[ -f /etc/sbx/env ] || ok=1
	report pam $ok "$(grep -c pam_env.so /etc/pam.d/sshd) pam_env lines; /etc/sbx/env $([ -f /etc/sbx/env ] && echo exists || echo missing)"

	local ci
	ci=$(cloud-init status 2>&1 | tr '\n' ' ')
	[[ $ci == *"status: disabled"* ]] && [ -e /etc/cloud/cloud-init.disabled ]
	report cloudinit $? "$ci; cloud-init.disabled $([ -e /etc/cloud/cloud-init.disabled ] && echo present || echo absent)"

	local np
	np=$(ls /etc/netplan)
	[ ! -e /etc/netplan/50-cloud-init.yaml ] && grep -q 'name: "en\*"' /etc/netplan/10-sbx.yaml &&
		! grep -rq macaddress /etc/netplan
	report netplan $? "files: $np"

	local ip
	ip=$(ip -4 -o addr show scope global | awk '$2 ~ /^en/ { split($4, a, "/"); print a[1]; exit }')
	[ -n "$ip" ] && ip_in_cidr "$ip" "${EXPECT_SUBNET:-0.0.0.0/32}"
	report ipv4 $? "ip=${ip:-none} expect=${EXPECT_SUBNET:-unset}"

	local dns
	dns=$(timeout 20 getent hosts example.com 2>&1 | head -n1)
	[ -n "$dns" ]
	report dns $? "${dns:-no answer}"
	local https
	https=$(curl -fsS -o /dev/null -m 30 -w '%{http_code}' https://example.com 2>&1)
	report https $? "$https"

	# netplan (26.04) runs wait-online only for interfaces it can name; with "match: en*" the
	# unit is skipped by its condition and network-online.target is reached without waiting.
	# Either that, or a wait of at most 15 s (spec 8.4), passes.
	local start end st cond online
	st=$(systemctl show -p ActiveState --value systemd-networkd-wait-online.service)
	cond=$(systemctl show -p ConditionResult --value systemd-networkd-wait-online.service)
	start=$(systemctl show -p InactiveExitTimestampMonotonic --value systemd-networkd-wait-online.service)
	end=$(systemctl show -p ActiveEnterTimestampMonotonic --value systemd-networkd-wait-online.service)
	online=$(systemctl is-active network-online.target 2>&1)
	if [ "$st" = inactive ] && [ "$cond" = no ]; then
		[ "$online" = active ]
		report wait_online $? "skipped by its condition (netplan), network-online.target $online"
	else
		[ "$st" = active ] && [ "${end:-0}" -gt 0 ] && [ $((end - start)) -le 15000000 ]
		report wait_online $? "state=$st took $(((${end:-0} - ${start:-0}) / 1000)) ms, network-online.target $online"
	fi
}

check_users() {
	local id_out
	id_out=$(id user 2>&1)
	[ "$(id -u user 2>/dev/null)" = 1000 ] && id -nG user | tr ' ' '\n' | grep -qx sudo &&
		id -nG user | tr ' ' '\n' | grep -qx docker
	report user $? "$id_out"

	local s
	s=$(timeout 30 sudo -u user sudo -n true 2>&1)
	report sudo $? "sudo -n true as user: ${s:-ok}"

	[ -e /var/lib/systemd/linger/user ]
	report linger $? "$(ls /var/lib/systemd/linger 2>&1 | tr '\n' ' ')"

	local others
	others=$(awk -F: '$3 >= 1000 && $3 != 65534 && $1 != "user" { print $1 }' /etc/passwd | tr '\n' ' ')
	[ -z "$others" ] && ! id ubuntu >/dev/null 2>&1
	report no_other_users $? "${others:-none}"

	local pr pu
	pr=$(passwd -S root | awk '{ print $2 }')
	pu=$(passwd -S user | awk '{ print $2 }')
	[ "$pr" = L ] && [ "$pu" = L ]
	report passwords_locked $? "root=$pr user=$pu"

	local keys
	keys=$(find / -xdev \( -name authorized_keys -o -name authorized_keys2 \) -print 2>/dev/null | tr '\n' ' ')
	[ -z "$keys" ]
	report no_authorized_keys $? "${keys:-none}"

	local bl
	bl=$(ls -d /etc/skel/.bash_logout /home/user/.bash_logout /root/.bash_logout 2>/dev/null | tr '\n' ' ')
	[ -z "$bl" ]
	report bash_logout $? "${bl:-none}"

	local u
	u=$(timeout 30 sudo -u user unshare -Ur true 2>&1)
	report userns $? "unshare -Ur true as user: ${u:-ok}"

	local left=()
	[ -e /var/log/sbx-build ] && left+=(/var/log/sbx-build)
	compgen -G '/var/lib/cloud/instances/*' >/dev/null && left+=(/var/lib/cloud/instances/*)
	[ -e /root/.bash_history ] && left+=(/root/.bash_history)
	[ -e /home/user/.bash_history ] && left+=(/home/user/.bash_history)
	[ -f /etc/sbx-template/build.json ] || left+=("no /etc/sbx-template/build.json")
	# The build VM's journal (another machine-id) must not ship with the template.
	local mid j
	mid=$(cat /etc/machine-id)
	for j in /var/log/journal/*/; do
		[ -d "$j" ] && [ "$(basename "$j")" != "$mid" ] && left+=("journal ${j%/}")
	done
	[ "${#left[@]}" -eq 0 ]
	report leftovers $? "${left[*]:-none}"

	local label
	label=$(blkid -o value -s LABEL /dev/sr0 2>/dev/null)
	[ "${label,,}" != cidata ]
	report no_ci_drive $? "/dev/sr0 label: ${label:-none}"

	local want host
	want=$(printf '%s' "${MACHINE_ID:-}" | tr -d '-' | tr 'A-F' 'a-f')
	want=sbx-${want: -12}
	host=$(hostname)
	[ "$host" = "$want" ]
	report hostname $? "hostname=$host want=$want"
}

# Tools of spec 8.9, `key|command`. `command -v` only for the tools spec 10
# item 11 names.
TOOLS=(
	"node|node --version"
	"npm|npm --version"
	"npx|command -v npx"
	"bun|bun --version"
	"bunx|command -v bunx"
	"go|go version"
	"gofmt|command -v gofmt"
	"cargo|cargo --version"
	"rustc|rustc --version"
	"rustup|rustup --version"
	"rustfmt|rustfmt --version"
	"cargo-clippy|cargo-clippy --version"
	"clippy-driver|clippy-driver --version"
	"python3|python3 --version"
	"pip3|pip3 --version"
	"uv|uv --version"
	"uvx|command -v uvx"
	"gh|gh --version"
	"java|java --version"
	"javac|javac --version"
	"jar|jar --version"
	"docker|docker --version"
	"docker-compose|docker compose version"
	"docker-buildx|docker buildx version"
	"google-chrome|google-chrome --version"
	"google-chrome-stable|google-chrome-stable --version"
	"ffmpeg|ffmpeg -version"
	"xdotool|xdotool --version"
	"claude|claude --version"
	"codex|codex --version"
	"opencode|opencode --version"
	"gemini|gemini --version"
	"pnpm|pnpm --version"
	"sbx|sbx --version"
	"git|git --version"
	"git-lfs|git-lfs --version"
	"rg|rg --version"
	"fd|fd --version"
	"jq|jq --version"
)

# first_line <rc> <output>: the value of a tool for TOOLS.
first_line() {
	local rc=$1 out line
	out=$(printf '%s' "$2" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/\r//g')
	line=$(grep -m1 -v '^[[:space:]]*$' <<<"$out" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
	if [ "$rc" -eq 0 ] && [ -n "$line" ]; then
		echo "$line"
	elif [ "$rc" -eq 127 ]; then
		echo missing
	else
		echo "error: rc=$rc $line"
	fi
}

# The CLIs may create dot files in the home of `user` and in /tmp (state,
# install ids). Before the build seals the image, all of it goes again.
snapshot_paths() {
	find /home/user /tmp /var/tmp -xdev -name 'systemd-private-*' -prune -o -print 2>/dev/null | LC_ALL=C sort
}

tools_json() {
	local before entry key cmd out rc direct login
	before=$(mktemp)
	snapshot_paths >"$before"
	for entry in "${TOOLS[@]}"; do
		key=${entry%%|*}
		cmd=${entry#*|}
		# Direct exec: argv with the env an agent command gets, no shell
		# startup files (spec S3 8.2). `command -v` needs a shell.
		if [[ $cmd == "command -v "* ]]; then
			out=$(timeout -k 5 30 sudo -n -u user env -i PATH=$STD_PATH HOME=/home/user USER=user LOGNAME=user LANG=C.UTF-8 CI=1 /bin/sh -c "$cmd" 2>&1)
		else
			# shellcheck disable=SC2086 # cmd is split into argv on purpose
			out=$(timeout -k 5 30 sudo -n -u user env -i PATH=$STD_PATH HOME=/home/user USER=user LOGNAME=user LANG=C.UTF-8 CI=1 $cmd 2>&1)
		fi
		rc=$?
		[[ $cmd == "command -v "* ]] && [ "$rc" -ne 0 ] && rc=127
		direct=$(first_line "$rc" "$out")
		out=$(timeout -k 5 30 sudo -n -iu user bash -lc "CI=1 $cmd" 2>&1)
		rc=$?
		[[ $cmd == "command -v "* ]] && [ "$rc" -ne 0 ] && rc=127
		login=$(first_line "$rc" "$out")
		printf '%s\t%s\t%s\n' "$key" "${direct//$'\t'/ }" "${login//$'\t'/ }"
	done | python3 -I -c '
import json, sys
tools = {}
for line in sys.stdin.read().splitlines():
    key, direct, login = line.split("\t")
    tools[key] = {"direct": direct, "login": login}
print(json.dumps(tools, separators=(",", ":")))
'
	snapshot_paths | LC_ALL=C comm -13 "$before" - | LC_ALL=C sort -r | while read -r p; do
		rm -rf -- "$p"
	done
	rm -f "$before"
}

main() {
	if [ "${SBX_VERIFY_MODE:-}" != tools ]; then
		check_system
		check_network
		check_users
	fi
	printf 'TOOLS %s\n' "$(tools_json)"
}

main </dev/null
