#!/usr/bin/env bash
# 30-toolchains (spec S5 section 8.9): Node, Go, Bun, uv, gh, Rust and Chrome
# from their official URLs, each checked against the sha256 of versions.toml.
# Every command ends up in /usr/local/bin (Chrome in /usr/bin).
set -euo pipefail
# shellcheck source=SCRIPTDIR/../lib.sh
. "$(dirname "$0")/../lib.sh"

dl=$UMIAK_WORK_DIR/downloads
mkdir -p "$dl"
chmod 0755 "$UMIAK_WORK_DIR" "$dl"

# Node LTS (+ npm, npx) into /usr/local.
v=$(toml_get tools.node.version)
f=$dl/node-v$v-linux-x64.tar.xz
fetch_verify "https://nodejs.org/dist/v$v/node-v$v-linux-x64.tar.xz" "$(toml_get tools.node.sha256)" "$f"
rm -rf "$dl/node" && mkdir "$dl/node"
tar -xJf "$f" -C "$dl/node" --no-same-owner
cp -a "$dl/node/node-v$v-linux-x64/"{bin,include,lib,share} /usr/local/

# Go into /usr/local/go.
v=$(toml_get tools.go.version)
f=$dl/go$v.linux-amd64.tar.gz
fetch_verify "https://go.dev/dl/go$v.linux-amd64.tar.gz" "$(toml_get tools.go.sha256)" "$f"
rm -rf /usr/local/go
tar -xzf "$f" -C /usr/local --no-same-owner
ln -sfn /usr/local/go/bin/go /usr/local/bin/go
ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# Bun (+ bunx).
v=$(toml_get tools.bun.version)
f=$dl/bun-v$v-linux-x64.zip
fetch_verify "https://github.com/oven-sh/bun/releases/download/bun-v$v/bun-linux-x64.zip" "$(toml_get tools.bun.sha256)" "$f"
rm -rf "$dl/bun" && mkdir "$dl/bun"
unzip -q -o "$f" -d "$dl/bun"
install -m 0755 "$dl/bun/bun-linux-x64/bun" /usr/local/bin/bun
ln -sfn bun /usr/local/bin/bunx

# uv, uvx.
v=$(toml_get tools.uv.version)
f=$dl/uv-$v-x86_64-unknown-linux-gnu.tar.gz
fetch_verify "https://github.com/astral-sh/uv/releases/download/$v/uv-x86_64-unknown-linux-gnu.tar.gz" "$(toml_get tools.uv.sha256)" "$f"
rm -rf "$dl/uv" && mkdir "$dl/uv"
tar -xzf "$f" -C "$dl/uv" --no-same-owner
install -m 0755 "$dl/uv/uv-x86_64-unknown-linux-gnu/uv" "$dl/uv/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/

# gh.
v=$(toml_get tools.gh.version)
f=$dl/gh_${v}_linux_amd64.tar.gz
fetch_verify "https://github.com/cli/cli/releases/download/v$v/gh_${v}_linux_amd64.tar.gz" "$(toml_get tools.gh.sha256)" "$f"
rm -rf "$dl/gh" && mkdir "$dl/gh"
tar -xzf "$f" -C "$dl/gh" --no-same-owner
install -m 0755 "$dl/gh/gh_${v}_linux_amd64/bin/gh" /usr/local/bin/gh

# Rust: rustup as `user` (~/.rustup, ~/.cargo), proxies linked into
# /usr/local/bin. rustup-init comes from the versioned archive URL: the
# unversioned dist/ URL is replaced on every rustup release.
v=$(toml_get tools.rust.version)
rv=$(toml_get tools.rust.rustup_version)
f=$dl/rustup-init
fetch_verify "https://static.rust-lang.org/rustup/archive/$rv/x86_64-unknown-linux-gnu/rustup-init" "$(toml_get tools.rust.rustup_init_sha256)" "$f"
chmod 0755 "$f"
as_user "$f" -y --no-modify-path --default-toolchain "$v" --profile minimal -c rustfmt -c clippy
for t in cargo rustc rustup rustfmt cargo-clippy clippy-driver; do
	[ -x "/home/user/.cargo/bin/$t" ] || die "rustup did not install $t"
	ln -sfn "/home/user/.cargo/bin/$t" "/usr/local/bin/$t"
done

# Google Chrome .deb by exact version; the package adds Google's apt source,
# which stays so the user can update Chrome.
v=$(toml_get chrome.google_chrome_stable.version)
f=$dl/google-chrome-stable_${v}_amd64.deb
fetch_verify "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${v}_amd64.deb" "$(toml_get chrome.google_chrome_stable.sha256)" "$f"
chmod 0644 "$f"
apt_install "$f"

for t in node npm npx bun bunx go gofmt uv uvx gh cargo rustc rustup rustfmt cargo-clippy clippy-driver; do
	[ -x "/usr/local/bin/$t" ] || die "/usr/local/bin/$t is missing"
done
for t in node bun uv gh rustc cargo; do
	log "$t: $(as_user "$t" --version </dev/null | head -n1)"
done
log "go: $(as_user go version)"
log "done"
