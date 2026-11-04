#!/bin/sh
# Checks for the repository-root install.sh: shellcheck, no-TTY refusal and a
# network-free dry run. Run from anywhere: sh deploy/installer/tests/install_sh_test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
script="$here/../../../install.sh"
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

shellcheck -s sh "$script" || fail "shellcheck reported issues"

for shell in sh dash bash; do
 command -v "$shell" >/dev/null 2>&1 || continue
 set +e
 out=$(UMIAK_TTY=/nonexistent/tty "$shell" "$script" </dev/null 2>&1)
 code=$?
 set -e
 [ "$code" -eq 2 ] || fail "$shell: expected exit 2 without a TTY, got $code"
 case "$out" in
  *'Run this in an interactive shell'*) ;;
  *) fail "$shell: missing no-TTY message: $out" ;;
 esac
done

# No usable terminal and no --non-interactive: clear message, exit 2.
set +e
out=$(UMIAK_TTY=/nonexistent/tty sh "$script" </dev/null 2>&1)
code=$?
set -e
[ "$code" -eq 2 ] || fail "expected exit 2 without a TTY, got $code"
case "$out" in
 *'Run this in an interactive shell or pass --non-interactive with flags (see --help)'*) ;;
 *) fail "missing no-TTY message: $out" ;;
esac

# Same through a pipe, as in curl ... | sh.
set +e
out=$(UMIAK_TTY=/nonexistent/tty sh <"$script" 2>&1)
code=$?
set -e
[ "$code" -eq 2 ] || fail "expected exit 2 for piped script without a TTY, got $code"

# Dry run: resolves URLs and target without network, root or a TTY.
out=$(UMIAK_TTY=/nonexistent/tty UMIAK_VERSION=1.2.3 UMIAK_INSTALL_DRY_RUN=1 sh "$script" --non-interactive 2>&1)
printf '%s\n' "$out" | grep -qx 'bundle https://github.com/belov38/umiak/releases/download/v1.2.3/umiak-installer-1.2.3.tar.gz' \
 || fail "dry run bundle URL: $out"
printf '%s\n' "$out" | grep -qx 'sums https://github.com/belov38/umiak/releases/download/v1.2.3/SHA256SUMS' \
 || fail "dry run sums URL: $out"
printf '%s\n' "$out" | grep -qx 'target /var/lib/umiak-installer/1.2.3' || fail "dry run target: $out"

# Invalid version strings are refused before any download.
set +e
out=$(UMIAK_TTY=/nonexistent/tty UMIAK_VERSION='1.2.3;id' UMIAK_INSTALL_DRY_RUN=1 sh "$script" --non-interactive 2>&1)
code=$?
set -e
[ "$code" -ne 0 ] || fail "invalid version accepted"

printf 'install.sh tests passed\n'
