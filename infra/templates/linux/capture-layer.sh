#!/usr/bin/env bash
# Called only inside an isolated online capture VM, before cleanup removes inputs.
set -euo pipefail
python3 -I /mnt/seed/build/capture-apt.py
python3 -I - <<'PY'
import hashlib,json,os,shutil,stat
from pathlib import Path
root=Path('/var/lib/umiak-layer-capture')
(root/'licenses/umiak').mkdir(parents=True,exist_ok=True)
shutil.copyfile('/mnt/seed/build/umiak-LICENSE',root/'licenses/umiak/LICENSE')
if (root/'inputs.jsonl').exists(): shutil.copyfile(root/'inputs.jsonl',root/'inputs/fetch.jsonl')
for entry in (root/'inputs/fetch.jsonl').read_text().splitlines():
    url=json.loads(entry)['url']
    if any(x in url for x in ('github.com/oven-sh/bun/', 'github.com/anomalyco/opencode/', 'claude-code-releases')):
        raise ValueError('node-only vendor input in capture')
# npm's package-lock preserves exact tarball URLs, integrity and all transitive versions.
prefix=Path('/opt/umiak-npm')
lock=json.loads((prefix/'package-lock.json').read_text())
npm=[]
for path,entry in lock['packages'].items():
    if not path: continue
    if not path.startswith('node_modules/') or '..' in path.split('/') or entry.get('link'):
        raise ValueError('unexpected npm dependency path/link')
    p=prefix/path
    if not p.is_dir():
        if entry.get('optional'): continue
        raise ValueError(f'npm input missing: {path}')
    package=json.loads((p/'package.json').read_text())
    name=package['name']; version=package['version']
    if name in {'@anthropic-ai/claude-code','opencode-ai','bun','@oven/bun'} or name.startswith(('opencode-linux-', '@anthropic-ai/claude-code-')): raise ValueError('proprietary CLI in capture')
    notices=[]
    for notice in p.iterdir():
        if notice.is_file() and notice.name.lower().startswith(('license','licence','copying','notice')):
            relative=f'licenses/npm/{name}/{notice.name}'
            target=root/relative; target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(notice,target); notices.append(relative)
    npm.append(dict(name=name,version=version,license=package.get('license'),notices=notices,integrity=entry.get('integrity'),url=entry.get('resolved'),repository=package.get('repository')))
(root/'licenses/npm.json').write_text(json.dumps(npm))
files=[]
for parent,dirs,names in os.walk(root,followlinks=False):
    for name in dirs:
        p=Path(parent)/name
        if p.is_symlink(): raise ValueError('symlink directory in capture')
    for name in names:
        p=Path(parent)/name; relative=p.relative_to(root).as_posix()
        if relative.split('/')[0] not in {'inputs','build','licenses'}: continue
        info=p.lstat()
        if not stat.S_ISREG(info.st_mode): raise ValueError('special file in capture')
        with p.open('rb') as f: sha=hashlib.file_digest(f,'sha256').hexdigest()
        files.append(dict(path=relative,sizeBytes=info.st_size,sha256=sha,mode=0o644))
(root/'files.json').write_text(json.dumps(files,separators=(',',':')))
PY
