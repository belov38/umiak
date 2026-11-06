#!/usr/bin/env python3
"""Smoke-test native Chromium's loopback CDP endpoint inside the isolated guest."""
import json
import os
import pwd
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

unit = 'umiak-layer-cdp.service'
with tempfile.TemporaryDirectory(prefix='umiak-cdp-') as directory:
    user = pwd.getpwnam('user')
    os.chown(directory, user.pw_uid, user.pw_gid)
    try:
        subprocess.run(['systemd-run', '--unit=umiak-layer-cdp', '--collect',
                        '--property=User=user', '--property=Environment=HOME=/home/user',
                        '--property=KillMode=control-group', '--', '/usr/bin/chromium',
                        '--headless', '--disable-background-networking', '--no-first-run',
                        '--no-default-browser-check', '--remote-debugging-port=0',
                        '--remote-debugging-address=127.0.0.1', f'--user-data-dir={directory}',
                        'about:blank'], check=True)
        active_port = Path(directory) / 'DevToolsActivePort'
        deadline = time.monotonic() + 60
        while not active_port.is_file():
            if time.monotonic() > deadline:
                raise RuntimeError('native Chromium did not expose its CDP endpoint')
            time.sleep(0.2)
        port = int(active_port.read_text().splitlines()[0])
        if not 1 <= port <= 65535:
            raise ValueError('invalid Chromium CDP port')
        # Ignore proxy environment even if a future recipe adds one.
        http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def get(path):
            with http.open(f'http://127.0.0.1:{port}/{path}', timeout=10) as response:
                data = response.read(65537)
                if len(data) > 65536:
                    raise ValueError('oversized CDP response')
                return json.loads(data)
        version = get('json/version')
        if 'Chrome/' not in version.get('Browser', '') or not version.get('webSocketDebuggerUrl', '').startswith(f'ws://127.0.0.1:{port}/'):
            raise ValueError('native Chromium CDP version/discovery contract failed')
        if not any(page.get('type') == 'page' and page.get('url') == 'about:blank' for page in get('json/list')):
            raise ValueError('native Chromium did not create the offline page')
        print(json.dumps(dict(browser=version['Browser'], protocol=version.get('Protocol-Version'), ok=True)))
    finally:
        subprocess.run(['systemctl', 'stop', unit], check=False)
