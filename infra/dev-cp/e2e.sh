#!/usr/bin/env bash
# umiak dev control plane: end-to-end scenario against the stack on CT 590, from the Mac,
# with the real CLI and both SDKs. Dev only.
#
#   infra/dev-cp/e2e.sh [--keep-going]
#
# Needs: the stack deployed (deploy.sh), the e2e user (dev-users.sh), the tailnet (api, Keycloak,
# previews, SSH gateway) and `ssh $UMIAK_E2E_PVE_SSH` (default `pve`, root) for the leftover check.
# The CLI is built if apps/cli/dist/umiak-<os>-<arch> is missing (UMIAK_E2E_UMIAK overrides). It runs
# with its own config and state directories (mktemp), never the operator's ~/.config/umiak profile.
# The work dir holds the e2e user's tokens and SSH key; it is removed at the end unless
# UMIAK_E2E_KEEP_WORKDIR=1.
#
# Steps: login (device grant approved by kc-browser.py), create, exec (codes, signal, timeout,
# stdin, streaming), detach + logs -f, PTY (e2e-pty.py), cp up/down (80 MB chunked, a directory
# as tar), preview in token and sso mode (curl with the dev CA; kc-browser.py for the SSO login),
# umiak ssh and plain ssh on :2222, fork, snapshot and create --from, stop/resume (env and secrets),
# delete, TS and Python SDK, idle stop, and no leftovers on pve (VMIDs 500-589, snapshot LVs).
# At most two 2 GB sandboxes run at once. Prints a PASS/FAIL table; exit 1 if any step failed.
# Without --keep-going the first failure stops the run (created sandboxes are deleted).
# pass and log always return 0, so `test && pass || fail` is an if-else; the single-quoted
# commands run in the sandbox shell.
# shellcheck disable=SC2015,SC2016
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
KEEP_GOING=0
[[ "${1:-}" == "--keep-going" ]] && KEEP_GOING=1
PVE_SSH="${UMIAK_E2E_PVE_SSH:-pve}"
E2E_USER="${UMIAK_DEVCP_E2E_EMAIL:-e2e@example.com}"
E2E_PW="${UMIAK_CONFIG_DIR:-$HOME/.config/umiak}/dev-cp/e2e-password"
CA="$CA_DIR/ca.pem"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
[[ "$arch" == x86_64 ]] && arch=x64
[[ "$arch" == aarch64 ]] && arch=arm64
UMIAK="${UMIAK_E2E_UMIAK:-$REPO/apps/cli/dist/umiak-$os-$arch}"

W=$(mktemp -d "${TMPDIR:-/tmp}/umiak-e2e.XXXXXX")
SNAP_NAME="e2e-$(openssl rand -hex 6)"
# mise keeps its config and trust records under the XDG dirs; pin them before the override, or the
# python3/node shims stop working ("config files are not trusted").
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mise}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/mise}"
export XDG_CONFIG_HOME="$W/config" XDG_STATE_HOME="$W/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$W/bin" "$W/files"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() {
	log "ERROR: $*"
	exit 1
}

[[ "$AUTH_MODE" = none || -s "$E2E_PW" ]] || die "$E2E_PW is missing: run infra/dev-cp/dev-users.sh"
[[ -s "$CA" ]] || die "$CA is missing: run infra/dev-cp/deploy.sh"
if [[ ! -x "$UMIAK" ]]; then
	log "building the CLI"
	(cd "$REPO" && mise exec -- pnpm --filter @umiak/cli build >/dev/null) || die "CLI build failed"
fi
# The SDKs find the CLI profile through `umiak auth token --json` on PATH.
ln -s "$UMIAK" "$W/bin/umiak"
export PATH="$W/bin:$PATH"
log "work dir $W"

RESULTS=()
FAILED=0
CREATED=()
CURRENT=""

# step <name>: starts a step; pass/fail finish it.
step() {
	CURRENT=$1
	log "== $1"
}
pass() {
	RESULTS+=("PASS|$CURRENT|${1:-}")
	log "PASS $CURRENT ${1:-}"
}
fail() {
	RESULTS+=("FAIL|$CURRENT|${1:-}")
	FAILED=1
	log "FAIL $CURRENT ${1:-}"
	((KEEP_GOING)) || finish
}
# json <python expression on d>: reads JSON from stdin.
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

cleanup() {
	local s
	# ${a[@]+...}: an empty array under set -u in the bash 3.2 of macOS.
	for s in ${CREATED[@]+"${CREATED[@]}"}; do
		"$UMIAK" rm "$s" --yes >/dev/null 2>&1 || true
	done
	"$UMIAK" snapshot rm "$SNAP_NAME" --yes >/dev/null 2>&1 || true
	[[ -n "${SSHK_ID:-}" ]] && "$UMIAK" ssh-keys rm "$SSHK_ID" >/dev/null 2>&1
	return 0
}
FINISHED=0
finish() {
	((FINISHED)) && return
	FINISHED=1
	cleanup
	printf '\n%-6s %-28s %s\n' RESULT STEP DETAILS
	local r
	for r in ${RESULTS[@]+"${RESULTS[@]}"}; do
		IFS='|' read -r a b c <<<"$r"
		printf '%-6s %-28s %s\n' "$a" "$b" "$c"
	done
	if [[ "${UMIAK_E2E_KEEP_WORKDIR:-0}" == 1 ]]; then
		printf '\nwork dir (tokens, SSH key): %s\n' "$W"
	else
		python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$W"
	fi
	exit "$FAILED"
}
trap 'finish' INT TERM HUP
# Unexpected exits (set -u, a crash) still delete the sandboxes and the work dir.
trap '((FINISHED)) || { FAILED=1; finish; }' EXIT

# Wait for deletions to finish before starting the next VM.
wait_empty_budget() {
 local used
 for _ in $(seq 1 60); do
  used=$(ssh -o BatchMode=yes "$PVE_SSH" 'qm list | awk "\$1 >= 500 && \$1 <= 589 && \$3 == \"running\" {sum += \$4} END {print sum+0}"') || return 1
  [[ "$used" == 0 ]] && return 0
  sleep 1
 done
 die "Sequential VM budget did not become free"
}

# create_sb <args...>: create --wait; sets SB to the slug and remembers it for cleanup. Not in
# $(...): CREATED must be set in this shell.
create_sb() {
 wait_empty_budget || return 1
	local out
	SB=""
	out=$("$UMIAK" create --wait --json "$@") || return 1
	SB=$(tail -1 <<<"$out" | json 'd["sandbox"]["slug"] if d.get("event") == "ready" else ""')
	if [[ -z "$SB" ]]; then
		SB=$(head -1 <<<"$out" | json 'd["sandbox"]["slug"]' 2>/dev/null)
		[[ -n "$SB" ]] && CREATED+=("$SB")
		return 1
	fi
	CREATED+=("$SB")
}
# vms_in_range: sandbox VMIDs on pve (500-589), one line.
vms_in_range() {
	ssh -o BatchMode=yes "$PVE_SSH" 'qm list | awk "\$1 >= 500 && \$1 <= 589 {print \$1}" | xargs'
}

step "preflight"
usage=$(ssh -o BatchMode=yes "$PVE_SSH" 'qm list | awk "\$1 >= 500 && \$1 <= 589 && \$3 == \"running\" {sum += \$4} END {print sum+0}"')
[[ "$usage" == 0 ]] || die "Sequential acceptance requires no running sandbox VMs; found RAM $usage MB"
BASE_VMS=$(vms_in_range) || die "ssh $PVE_SSH failed"
[[ -z "$BASE_VMS" ]] || log "note: VMs already in 500-589: $BASE_VMS"
"$UMIAK" version >/dev/null && pass "umiak $("$UMIAK" version 2>/dev/null | head -1); pve VMs before: ${BASE_VMS:-none}"

if [[ "$AUTH_MODE" = none ]]; then
 step "login (local)"
 "$UMIAK" login --api-url "$API_URL" --credential-store file >"$W/login.out" 2>"$W/login.err" || fail "local login"
 "$UMIAK" whoami --json >"$W/whoami.json" && pass "tokenless owner"
else
step "login (device grant)"
"$UMIAK" login --no-browser --credential-store file --api-url "$API_URL" >"$W/login.out" 2>"$W/login.err" &
lp=$!
for _ in $(seq 1 30); do
	grep -q device_code "$W/login.out" 2>/dev/null && break
	sleep 1
done
uri=$(head -1 "$W/login.out" | json 'd["verificationUriComplete"]' 2>/dev/null)
if [[ -n "$uri" ]] && python3 "$HERE/kc-browser.py" device "$uri" "$E2E_USER" "$E2E_PW" >/dev/null && wait "$lp"; then
	team=$("$UMIAK" whoami --json | json 'd["team"]["role"]')
	[[ "$team" == owner ]] && pass "whoami: team role $team" || fail "team role $team"
else
	kill "$lp" 2>/dev/null
	KEEP_GOING=0
	fail "$(cat "$W/login.err" | xargs)"
fi

fi

step "create --wait"
t0=$(date +%s)
create_sb --template linux --size 2gb --env FOO=bar --secret TOKEN=s3cret || {
	KEEP_GOING=0
	fail "create"
}
S=$SB
pass "$S ready in $(($(date +%s) - t0)) s"

step "exec codes and env"
out=$("$UMIAK" exec "$S" -- sh -c 'echo "out $FOO $TOKEN"; echo err >&2' 2>"$W/err")
rc=$?
[[ $rc == 0 && "$out" == "out bar s3cret" && "$(cat "$W/err")" == err ]] || fail "stdout/stderr/env: rc=$rc out=$out"
"$UMIAK" exec "$S" -- sh -c 'exit 7'
c1=$?
"$UMIAK" exec "$S" -- sh -c 'kill -TERM $$'
c2=$?
"$UMIAK" exec "$S" --timeout 2 -- sleep 10
c3=$?
c4=$(echo stdin-data | "$UMIAK" exec "$S" --stdin -- cat)
[[ $c1 == 7 && $c2 == 143 && $c3 == 124 && "$c4" == stdin-data ]] &&
	pass "exit 7, signal 143, timeout 124, stdin" || fail "codes $c1 $c2 $c3 stdin=$c4"

step "exec streaming"
# Arrival of each line of a 1 s ticker, in ms since the start: live output keeps the spacing.
times=$(python3 - "$UMIAK" "$S" <<'PY'
import subprocess, sys, time
t0 = time.time()
p = subprocess.Popen([sys.argv[1], "exec", sys.argv[2], "--", "sh", "-c",
                      "for i in 1 2 3 4 5; do echo t$i; sleep 1; done"], stdout=subprocess.PIPE)
print(" ".join(str(int((time.time() - t0) * 1000)) for _ in p.stdout))
p.wait()
PY
)
gaps=$(awk '{n = 0; for (i = 2; i <= NF; i++) if ($i - $(i - 1) >= 700) n++; print n}' <<<"$times")
[[ "$gaps" == 4 ]] && pass "lines at $times ms" || fail "lines at '$times' ms"

step "detach + logs -f"
cid=$("$UMIAK" exec "$S" --detach -- sh -c 'for i in 1 2 3 4 5; do echo line $i; sleep 1; done; exit 3')
sleep 2
"$UMIAK" logs "$S" "$cid" -f >"$W/logs.out"
lrc=$?
lines=$(grep -c '^line ' "$W/logs.out")
st=$("$UMIAK" ps "$S" --json | json "[c for c in d['data'] if c['id'] == '$cid'][0]['exitCode']" 2>/dev/null)
[[ "$lines" == 5 && "$st" == 3 && "$lrc" == 3 ]] && pass "$cid: 5 lines, exit 3, logs -f exit 3" || fail "lines=$lines exit=$st logs -f exit=$lrc"

step "pty (umiak shell)"
r=$(python3 "$HERE/e2e-pty.py" "$UMIAK" "$S")
grep -q 'pty ok' <<<"$r" && pass "$(head -1 <<<"$r")" || fail "$r"

step "cp up/down"
F="$W/files"
mkdir -p "$F/dir/sub" "$F/down"
echo hello >"$F/small.txt"
head -c 80000000 /dev/urandom >"$F/big.bin"
echo a >"$F/dir/a.txt"
echo b >"$F/dir/sub/b.txt"
chmod 755 "$F/dir/sub/b.txt"
ln -s a.txt "$F/dir/link"
ok=1
"$UMIAK" cp "$F/small.txt" "$S:small.txt" || ok=0
t0=$(date +%s)
"$UMIAK" cp "$F/big.bin" "$S:big.bin" || ok=0
up=$(($(date +%s) - t0))
"$UMIAK" cp -r "$F/dir" "$S:updir" || ok=0
t0=$(date +%s)
"$UMIAK" cp "$S:big.bin" "$F/down/big.bin" || ok=0
down=$(($(date +%s) - t0))
"$UMIAK" cp -r "$S:updir" "$F/down/updir" || ok=0
remote=$("$UMIAK" exec "$S" -- sh -c 'cat small.txt; sha256sum big.bin | cut -d" " -f1; stat -c %a updir/sub/b.txt; readlink updir/link' | xargs)
want="hello $(shasum -a 256 "$F/big.bin" | cut -d' ' -f1) 755 a.txt"
back="$(shasum -a 256 "$F/down/big.bin" | cut -d' ' -f1) $(cat "$F/down/updir/sub/b.txt") $(readlink "$F/down/updir/link")"
if [[ $ok == 1 && "$remote" == "$want" && "$back" == "$(cut -d' ' -f2 <<<"$want") b a.txt" ]]; then
	pass "80 MB up ${up}s down ${down}s, sha256 equal, dir tar with mode and symlink"
else
	fail "ok=$ok remote='$remote' want='$want' back='$back'"
fi

step "preview token"
"$UMIAK" exec "$S" --detach -- python3 -m http.server 3000 >/dev/null
p=$("$UMIAK" port "$S" 3000 --token --json)
url=$(json 'd["url"]' <<<"$p")
tok=$(json 'd["token"]' <<<"$p")
cc() { curl -sS --cacert "$CA" --max-time 20 -o /dev/null -w '%{http_code}' "$@"; }
for _ in $(seq 1 15); do
	[[ "$(cc -H "Umiak-Port-Token: $tok" "$url/")" == 200 ]] && break
	sleep 1
done
r="$(cc "$url/") $(cc "$url/?_token=umiakp_bad") $(cc -H "Umiak-Port-Token: $tok" "$url/") $(cc -H 'Accept: text/html' -c "$W/jar" "$url/?_token=$tok") $(cc -b "$W/jar" "$url/")"
[[ "$r" == "401 401 200 302 200" ]] && pass "$url: none 401, bad 401, header 200, browser 302+cookie, cookie 200" || fail "codes $r"

if [[ "$AUTH_MODE" = none ]]; then
 step "preview public"
 "$UMIAK" port "$S" 3000 --public >/dev/null
 [[ "$(cc "$url/")" == 200 ]] && pass "public 200" || fail "public preview"
 step "guest control plane isolation"
 "$UMIAK" exec "$S" -- python3 -c 'import socket
for port in (4180,8080,8090):
 s=socket.socket(); s.settimeout(3)
 try:
  s.connect(("192.168.68.90",port)); s.sendall(b"GET /v1/meta HTTP/1.1\r\nHost: 192.168.68.90:8080\r\nConnection: close\r\n\r\n"); data=s.recv(1024); assert b"403" in data.split(b"\r\n")[0],data
 except (TimeoutError,ConnectionRefusedError,OSError): pass
 finally: s.close()
print("app/API/MCP blocked or denied")' && pass "all three ports" || fail "guest can reach control plane"
else
step "preview sso"
"$UMIAK" port "$S" 3000 --sso >/dev/null
r1=$(cc "$url/")
r=$(python3 "$HERE/kc-browser.py" get "$url/" "$E2E_USER" "$E2E_PW" --cacert "$CA")
if [[ "$r1" == 401 ]] && grep -q 'status 200' <<<"$r" && grep -q '__Host-umiak_auth' <<<"$r" && grep -q 'Directory listing' <<<"$r"; then
	pass "non-browser 401; browser: Keycloak login -> /umiak-auth -> callback -> 200 with __Host-umiak_auth"
else
	fail "non-browser $r1; $(head -3 <<<"$r" | xargs)"
fi

fi

step "umiak ssh"
r=$("$UMIAK" ssh "$S" -- -o BatchMode=yes 'echo ssh-$(hostname); exit 4' </dev/null)
rc=$?
[[ $rc == 4 && "$r" == "ssh-umiak-$S" ]] && pass "certificate login, exit 4" || fail "rc=$rc out=$r"

step "plain ssh :2222"
ssh-keygen -q -t ed25519 -N '' -C umiak-e2e -f "$W/id_e2e"
SSHK_ID=$("$UMIAK" ssh-keys add "$W/id_e2e.pub" --json | json 'd["id"]')
r=$(ssh -p 2222 -i "$W/id_e2e" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
	-o UserKnownHostsFile="$XDG_CONFIG_HOME/umiak/known_hosts" "$S@$SSH_HOST" 'echo plain-$(hostname)' </dev/null)
[[ "$r" == "plain-umiak-$S" ]] && pass "registered key, host key from /v1/meta" || fail "out=$r"
"$UMIAK" ssh-keys rm "$SSHK_ID" >/dev/null && SSHK_ID=""

step "fork"
"$UMIAK" exec "$S" -- sh -c 'echo fork-marker > marker.txt'
src=$("$UMIAK" exec "$S" -- cat /etc/machine-id)
"$UMIAK" stop "$S" --wait >/dev/null
F1=$("$UMIAK" fork "$S" --wait --json | tail -1 | json 'd["sandbox"]["slug"] if d.get("event") == "ready" else ""')
if [[ -n "$F1" ]]; then
	CREATED+=("$F1")
	r=$("$UMIAK" exec "$F1" -- sh -c 'cat marker.txt; cat /etc/machine-id; hostname; echo $FOO' | xargs)
	[[ "$r" == "fork-marker "*" umiak-$F1 bar" && "$r" != *"$src"* ]] &&
		pass "$F1: own machine-id and hostname, files and env copied" || fail "$r (source machine-id $src)"
else
	fail "fork did not become ready"
fi

step "snapshot + create --from"
ss=$("$UMIAK" snapshot save "${F1:-$S}" "$SNAP_NAME" --wait --json | tail -1 |
	json "d['snapshot']['state'] + ':' + str(d['snapshot']['consistency']) if d['event'] == 'ready' else 'failed:' + d['code']")
[[ -n "${F1:-}" ]] && "$UMIAK" rm "$F1" --yes >/dev/null
S2=""
create_sb --from "$SNAP_NAME" && S2=$SB
r=$([[ -n "$S2" ]] && "$UMIAK" exec "$S2" -- cat marker.txt)
[[ "$ss" == ready:* && "$r" == fork-marker ]] && pass "snapshot $ss; $S2 has the marker" || fail "snapshot $ss, marker '$r'"
[[ -n "$S2" ]] && "$UMIAK" rm "$S2" --yes >/dev/null
"$UMIAK" snapshot rm "$SNAP_NAME" --yes >/dev/null

step "stop/resume"
if [[ "$("$UMIAK" info "$S" --json | json 'd["state"]')" != stopped ]]; then
 "$UMIAK" stop "$S" --wait --json >/dev/null || fail "stop"
fi
st=$("$UMIAK" info "$S" --json | json 'd["state"]')
wait_empty_budget || fail "VM budget"
t0=$(date +%s)
"$UMIAK" resume "$S" --wait --json >/dev/null
t=$(($(date +%s) - t0))
r=$("$UMIAK" exec "$S" -- sh -c 'echo $FOO $TOKEN; cat small.txt' | xargs)
# Resume sends the SSH user CA keys again (UpdateSshCa in the provision step).
rs=$("$UMIAK" ssh "$S" -- -o BatchMode=yes 'echo resumed-ssh' </dev/null)
[[ "$st" == stopped && "$r" == "bar s3cret hello" && "$rs" == resumed-ssh ]] && pass "stopped, resumed in ${t}s; env, secret, files and ssh kept" || fail "state=$st out=$r ssh=$rs"

step "delete"
"$UMIAK" rm "$S" --yes >/dev/null
for _ in $(seq 1 30); do
	st=$("$UMIAK" info "$S" --json 2>/dev/null | json 'd["state"]' 2>/dev/null)
	[[ "$st" != deleting ]] && break
	sleep 2
done
[[ "$st" == deleted || -z "$st" ]] && pass "state ${st:-not found}" || fail "state $st"

step "sdk ts"
wait_empty_budget || fail "VM budget"
r=$(cd "$REPO" && mise exec -- node packages/sdk-ts/e2e/devcp.ts 2>&1)
grep -q '^ok delete' <<<"$r" && ! grep -q 'check failed\|Error' <<<"$r" &&
	pass "$(grep -c '^ok' <<<"$r") checks" || fail "$(tail -3 <<<"$r" | xargs)"

step "sdk python"
wait_empty_budget || fail "VM budget"
r=$(cd "$REPO/packages/sdk-py" && mise exec -- uv run --locked --quiet python e2e/devcp.py 2>&1)
grep -q '^ok delete' <<<"$r" && ! grep -q 'check failed\|Error' <<<"$r" &&
	pass "$(grep -c '^ok' <<<"$r") checks" || fail "$(tail -3 <<<"$r" | xargs)"

step "idle stop (--idle 60s)"
create_sb --idle 60s || fail "create"
I=$SB
t0=$(date +%s)
st=""
for _ in $(seq 1 30); do
	st=$("$UMIAK" info "$I" --json | json 'd["state"] + ":" + str(d["stopReason"])')
	[[ "$st" == stopped:* ]] && break
	sleep 10
done
[[ "$st" == stopped:idle ]] && pass "stopped by idle after $(($(date +%s) - t0)) s" || fail "state $st"
"$UMIAK" rm "$I" --yes >/dev/null

step "no leftovers on pve"
left=""
# The last rm returns while the sandbox is still deleting; wait for it to leave the list too.
for _ in $(seq 1 40); do
	left=$(vms_in_range)
	snaps=$(ssh -o BatchMode=yes "$PVE_SSH" 'lvs --noheadings -o lv_name pve | grep -c umiak-snap-')
	mine=$("$UMIAK" list --json | json 'len(d["data"])')
	[[ "$left" == "$BASE_VMS" && "$snaps" == 0 && "$mine" == 0 ]] && break
	sleep 3
done
[[ "$left" == "$BASE_VMS" && "$snaps" == 0 && "$mine" == 0 ]] &&
	pass "VMs 500-589: ${left:-none}; snapshot LVs: 0; sandboxes of the e2e team: 0" ||
	fail "VMs '$left' (before '$BASE_VMS'), snapshot LVs $snaps, sandboxes $mine"

CREATED=()
finish
