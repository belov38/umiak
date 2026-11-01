#!/usr/bin/env bash
# Builds the patched moonlight-web web-server.exe of the windows-desktop recipe (S10 spec 8.6).
# Upstream v3.0.1 with ping-order.patch applied to its pinned moonlight-common-rust: the audio
# stream waits for the first video packet, so Sunshine cannot take the audio socket for the
# video address. Run before `umiak-tpl build windows-desktop`; the output lands in
# ../files/moonlight-web/ (gitignored), where desktop-install.ps1 picks it up.
#
#   infra/templates/windows-desktop/moonlight-web/build.sh
#
# Needs Docker. Only the server binary changes; the web assets stay those of the pinned zip.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../files/moonlight-web"
MOONLIGHT_WEB_TAG=v3.0.1
# The rev moonlight-web v3.0.1 pins in Cargo.toml.
MOONLIGHT_COMMON_REV=a972937b2e84b21a6a390873930e3afe4cfa767d
# The toolchain of moonlight-web's rust-toolchain.toml.
RUST_IMAGE=rust:1.99.0-trixie

work=$(mktemp -d)
mkdir -p "$OUT"
docker run --rm \
	-v "$HERE:/in:ro" -v "$work:/out" \
	-e MOONLIGHT_WEB_TAG="$MOONLIGHT_WEB_TAG" -e MOONLIGHT_COMMON_REV="$MOONLIGHT_COMMON_REV" \
	"$RUST_IMAGE" bash -euo pipefail -c '
apt-get update -qq
apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null
mkdir -p /src && cd /src
git clone -q --depth 1 --branch "$MOONLIGHT_WEB_TAG" https://github.com/MrCreativ3001/moonlight-web-stream.git web
git clone -q https://github.com/MrCreativ3001/moonlight-common-rust.git common
git -C common checkout -q "$MOONLIGHT_COMMON_REV"
git -C common apply /in/ping-order.patch
grep -q "rev = \"$MOONLIGHT_COMMON_REV\"" web/Cargo.toml
printf "\n[patch.\"https://github.com/MrCreativ3001/moonlight-common-rust.git\"]\nmoonlight-common = { path = \"../common\" }\n" >>web/Cargo.toml
cd web
rustup target add x86_64-pc-windows-gnu >/dev/null
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
# Stable paths and no PE timestamp keep repeated builds comparable.
export RUSTFLAGS="--remap-path-prefix=/src=/build --remap-path-prefix=$CARGO_HOME=/cargo -C link-arg=-Wl,--no-insert-timestamp"
cargo build -q --release --target x86_64-pc-windows-gnu
cp target/x86_64-pc-windows-gnu/release/web-server.exe /out/
'
exe_sha=$(shasum -a 256 "$work/web-server.exe" | cut -d" " -f1)
patch_sha=$(shasum -a 256 "$HERE/ping-order.patch" | cut -d" " -f1)
cp "$work/web-server.exe" "$OUT/web-server.exe"
cat >"$OUT/build.json" <<JSON
{
  "upstream": "moonlight-web-stream $MOONLIGHT_WEB_TAG",
  "moonlightCommonRev": "$MOONLIGHT_COMMON_REV",
  "patch": "ping-order.patch",
  "patchSha256": "$patch_sha",
  "rustImage": "$RUST_IMAGE",
  "sha256": "$exe_sha"
}
JSON
rm -r "$work"
echo "web-server.exe $exe_sha -> $OUT"
