#!/usr/bin/env bash
# boat-dev-clone dev control plane: people of the dev Keycloak realm `sbx` on CT 590. Dev only.
#
#   infra/dev-cp/dev-users.sh
#
# Creates (or updates) two users with a verified email:
# The realm takes the email as the username (registrationEmailAsUsername), so people log in
# with the email.
#   ilia@example.com temporary password in ~/.config/sbx/dev-cp/ilia-initial-password; Keycloak
#                    asks for a new one at the first login. Set only when the file is new.
#   e2e@example.com  permanent password in ~/.config/sbx/dev-cp/e2e-password (e2e.sh).
# Passwords are generated on this Mac once (0600, outside git) and reach the CT over ssh stdin.
# Each user gets a personal team with the owner role at the first login (api JIT).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=infra/dev-cp/names.sh
source "$HERE/names.sh"
CT="${SBX_DEVCP_SSH:-sbx@$CT_IP}"
DIR="${SBX_CONFIG_DIR:-$HOME/.config/sbx}/dev-cp"
ILIA_EMAIL="${SBX_DEVCP_ILIA_EMAIL:-ilia@example.com}"
E2E_EMAIL="${SBX_DEVCP_E2E_EMAIL:-e2e@example.com}"

install -d -m 700 "$DIR"
# new_password file: creates the file with a random password; prints 1 if it was created.
new_password() {
	if [[ -s "$1" ]]; then
		echo 0
	else
		(umask 077 && LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 >"$1")
		echo 1
	fi
}
ilia_new=$(new_password "$DIR/ilia-initial-password")
new_password "$DIR/e2e-password" >/dev/null

{
	for kv in "ILIA_EMAIL=$ILIA_EMAIL" "E2E_EMAIL=$E2E_EMAIL" \
		"ILIA_NEW=$ilia_new" "ILIA_PW=$(cat "$DIR/ilia-initial-password")" \
		"E2E_PW=$(cat "$DIR/e2e-password")"; do
		printf 'export %s=%q\n' "${kv%%=*}" "${kv#*=}"
	done
	cat <<'EOF'
set -euo pipefail
cd ~/boat-dev-clone/deploy/compose
kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@" </dev/null; }
kc config credentials --server http://localhost:8080 --realm master --user admin \
	--password "$(cat secrets/keycloak/admin-password)" >/dev/null
# ensure email first last temporary(true|false) password set(1|0). Keycloak 26 asks for
# first and last name (VERIFY_PROFILE) when they are missing.
ensure() {
	local id set=$6
	id=$(kc get users -r sbx -q "email=$1" -q exact=true --fields id --format csv --noquotes | head -1)
	if [ -z "$id" ]; then
		kc create users -r sbx -s "username=$1" -s "email=$1" -s "firstName=$2" -s "lastName=$3" \
			-s emailVerified=true -s enabled=true 2>/dev/null
		id=$(kc get users -r sbx -q "email=$1" -q exact=true --fields id --format csv --noquotes | head -1)
		set=1
		echo "created $1"
	else
		kc update "users/$id" -r sbx -s "firstName=$2" -s "lastName=$3" -s emailVerified=true -s enabled=true
		echo "updated $1"
	fi
	[ -n "$id" ] || { echo "no user $1" >&2; exit 1; }
	if [ "$set" = 1 ]; then
		if [ "$4" = true ]; then
			kc set-password -r sbx --userid "$id" --new-password "$5" --temporary
		else
			kc set-password -r sbx --userid "$id" --new-password "$5"
			kc update "users/$id" -r sbx -s 'requiredActions=[]'
		fi
		echo "password set for $1 (temporary: $4)"
	fi
}
ensure "$ILIA_EMAIL" Ilia Belov true "$ILIA_PW" "$ILIA_NEW"
# The e2e password is set every time: it must stay permanent and match the Mac's file.
ensure "$E2E_EMAIL" E2E User false "$E2E_PW" 1
EOF
} | ssh -o BatchMode=yes "$CT" 'bash -s'
echo "ilia: login $ILIA_EMAIL, temporary password in $DIR/ilia-initial-password"
echo "e2e:  login $E2E_EMAIL, password in $DIR/e2e-password"
