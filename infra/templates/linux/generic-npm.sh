#!/usr/bin/env bash
# A lockfile plus npm's original content-addressed inputs, proved by fresh offline ci.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
prefix=/opt/umiak-npm
cache=$UMIAK_WORK_DIR/npm-cache
mkdir -p "$prefix" "$cache"
if [ "${UMIAK_LAYER_MODE:-}" = replay ]; then
 install -m 0644 "$UMIAK_LAYER_ROOT/inputs/npm/package.json" "$prefix/package.json"
 install -m 0644 "$UMIAK_LAYER_ROOT/inputs/npm/package-lock.json" "$prefix/package-lock.json"
 tar -xf "$UMIAK_LAYER_ROOT/inputs/npm/cache.tar" -C "$cache" --no-same-owner
 npm ci --offline --prefix "$prefix" --cache "$cache" --no-audit --no-fund
else
 python3 -I - "$UMIAK_BUILD_DIR/versions.toml" "$prefix/package.json" <<'PY'
import json,sys,tomllib
pins=tomllib.load(open(sys.argv[1],'rb'))['npm']
allowed={'@openai/codex','@google/gemini-cli','pnpm'}
if not allowed.issubset(pins): sys.exit('generic npm pins are incomplete')
# Never capture proprietary/unknown root CLI packages into a public layer.
json.dump(dict(name='umiak-offline-tools',version='1.0.0',private=True,dependencies={k:pins[k] for k in sorted(allowed)}),open(sys.argv[2],'w'))
PY
 npm install --prefix "$prefix" --cache "$cache" --no-audit --no-fund
 if [ "${UMIAK_LAYER_MODE:-}" = capture ]; then
  mkdir -p "$UMIAK_CAPTURE_DIR/inputs/npm"
  install -m 0644 "$prefix/package.json" "$prefix/package-lock.json" "$UMIAK_CAPTURE_DIR/inputs/npm/"
  tar -cf "$UMIAK_CAPTURE_DIR/inputs/npm/cache.tar" -C "$cache" .
 fi
fi
for tool in codex gemini pnpm; do
 [ -x "$prefix/node_modules/.bin/$tool" ] || die "npm did not install $tool"
 ln -sfn "$prefix/node_modules/.bin/$tool" "/usr/local/bin/$tool"
done
