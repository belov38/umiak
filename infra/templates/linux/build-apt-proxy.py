#!/usr/bin/env python3
"""Disposable capture-only apt transport configuration; never weakens apt trust."""
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

PROXY_CONFIG = 'etc/apt/apt.conf.d/98umiak-build-proxy'
BACKUP = 'var/lib/umiak-build/ubuntu.sources-before-proxy'


def snapshot_sources(text, snapshot):
    if not re.fullmatch(r'\d{8}T\d{6}Z', snapshot):
        raise ValueError('invalid pinned apt snapshot')
    output, skip, rewritten = [], False, 0
    for line in text.splitlines():
        if re.match(r'(?i)^Snapshot:', line):
            skip = True
            continue
        if re.match(r'(?i)^URIs:', line):
            rewritten += 1
            output.append(f'URIs: http://snapshot.ubuntu.com/ubuntu/{snapshot}/')
            skip = True
            continue
        if line[:1].isspace() and skip:
            continue
        skip = False
        output.append(line)
    if not rewritten:
        raise ValueError('Ubuntu sources have no URIs to pin')
    return '\n'.join(output) + '\n'


def configure(snapshot, proxy, root=Path('/')):
    parsed = urlsplit(proxy)
    if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment or any(c.isspace() for c in proxy) or chr(34) in proxy or chr(92) in proxy:
        raise ValueError('build apt proxy must be an HTTP origin without credentials')
    sources = root / 'etc/apt/sources.list.d/ubuntu.sources'
    original = sources.read_text()
    rewritten = snapshot_sources(original, snapshot)
    backup = root / BACKUP
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        backup.write_text(original)
    config = root / PROXY_CONFIG
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(f'Acquire::http::Proxy "{proxy}";\n')
    sources.write_text(rewritten)


if __name__ == '__main__':
    mode, snapshot = sys.argv[1:3]
    if mode == 'configure':
        configure(snapshot, sys.argv[3], Path(sys.argv[4]) if len(sys.argv) > 4 else Path('/'))
    elif mode == 'sources':
        source = Path(sys.argv[3])
        source.write_text(snapshot_sources(source.read_text(), snapshot))
    else:
        raise ValueError('unknown build apt proxy mode')
