#!/usr/bin/env python3
"""Export original apt inputs from an isolated capture guest; host re-verifies them."""
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

root = Path('/var/lib/umiak-layer-capture')
output = root / 'inputs/apt-capture'
output.mkdir(parents=True, exist_ok=True)


def records(text):
    result, record, previous = [], {}, None
    for line in text.splitlines() + ['']:
        if not line:
            if record:
                result.append(record)
            record, previous = {}, None
        elif line[0].isspace():
            if previous is None:
                raise ValueError('orphan apt field continuation')
            record[previous] += '\n' + line.strip()
        else:
            key, value = line.split(':', 1)
            previous = key.lower()
            if previous in record:
                raise ValueError('duplicate apt field')
            record[previous] = value.strip()
    return result


def run(*args):
    return subprocess.check_output(args, text=True)


# Map only the three approved authorities. Never export an arbitrary guest trust key.
authorities = {
    'Ubuntu': ('ubuntu', 'F6ECB3762474EDA9D21B7022871920D1991BC93C', '/usr/share/keyrings/ubuntu-archive-keyring.gpg'),
    'Docker': ('docker', '9DC858229FC7DD38854AE2D88D81803C0EBFCD88', '/etc/apt/keyrings/docker.asc'),
    'LP-PPA-xtradeb-apps': ('xtradeb', '5301FA4FD93244FBC6F6149982BB6851C64F6880', '/etc/apt/keyrings/xtradeb-apps.asc'),
}
releases = {}
for path in Path('/var/lib/apt/lists').glob('*_InRelease'):
    text = path.read_text()
    # Parse only the signed cleartext body; signature verification happens on the host.
    body = text.split('\n\n', 1)[1].split('-----BEGIN PGP SIGNATURE-----', 1)[0]
    fields = records(body)[0]
    identity = (fields.get('origin'), fields.get('suite'))
    if identity in releases:
        raise ValueError(f'ambiguous captured apt Release: {identity}')
    releases[identity] = path
repos = {}
for target in records(run('apt-get', 'indextargets', 'Identifier: Packages')):
    if target.get('architecture') != 'amd64':
        continue
    origin, suite = target.get('origin'), target.get('suite')
    if target.get('trusted') != 'yes' or origin not in authorities:
        raise ValueError('unexpected or unauthenticated apt authority')
    if not re.fullmatch(r'resolute(?:-updates|-security|-backports)?', suite or ''):
        raise ValueError('unexpected captured apt suite')
    family, fingerprint, keyring = authorities[origin]
    name = f'{family}-{suite}'
    repo = repos.get(name)
    if repo is None:
        directory = output / name
        directory.mkdir()
        shutil.copyfile(releases[(origin, suite)], directory / 'InRelease')
        key = Path(keyring).read_bytes()
        if not key.startswith(b'-----BEGIN PGP PUBLIC KEY BLOCK-----'):
            key = subprocess.check_output(['gpg', '--batch', '--no-options', '--no-default-keyring', '--keyring', keyring, '--armor', '--export', fingerprint])
        if not key:
            raise ValueError('pinned apt authority missing')
        (directory / 'archive.asc').write_bytes(key)
        repo = dict(name=name, suite=suite, components=[], keyFingerprint=fingerprint, indexes=[])
        repos[name] = repo
    meta = target['metakey']
    if not re.fullmatch(r'[a-z][a-z0-9-]*/binary-amd64/Packages', meta):
        raise ValueError('unexpected apt index path')
    component = meta.split('/')[0]
    if component not in repo['components']:
        repo['components'].append(component)
    if meta in repo['indexes']:
        continue
    destination = output / name / meta
    destination.parent.mkdir(parents=True, exist_ok=True)
    # apt-helper understands the exact compression of apt's own cache filename.
    with destination.open('wb') as stream:
        subprocess.run(['/usr/lib/apt/apt-helper', 'cat-file', target['filename']], stdout=stream, check=True)
    repo['indexes'].append(meta)
debs = []
for path in sorted((root / 'debs').glob('*.deb')):
    sha = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
    relative = f'inputs/apt-capture/debs/{sha}.deb'
    dest = root / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        shutil.copyfile(path, dest)
        debs.append(dict(path=relative, sha256=sha, sizeBytes=path.stat().st_size))
(output / 'capture.json').write_text(json.dumps(dict(repositories=list(repos.values()), debs=debs)))
# Exact final installed package versions and distribution-provided notices, including base packages.
packages = []
for line in run('dpkg-query', '-W', '-f', '${db:Status-Status}\t${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n').splitlines():
    status, name, version, arch, source, source_version = line.split('\t')
    if status != 'installed':
        continue
    doc = Path('/usr/share/doc') / name.split(':')[0] / 'copyright'
    notice = f'licenses/deb/{name.replace(":", "_")}.copyright'
    if not doc.is_file():
        raise ValueError(f'package license notice missing: {name}')
    destination = root / notice
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(doc, destination)
    packages.append(dict(name=name, version=version, arch=arch, source=source, sourceVersion=source_version, notice=notice))
(root / 'licenses/packages.json').write_text(json.dumps(packages))

# Preserve normal post-customization update sources without using them during replay.
after = root / 'build/apt-after'
after.mkdir(parents=True, exist_ok=True)
for p in Path('/etc/apt/sources.list.d').glob('*.sources'):
    shutil.copyfile(p, after / p.name)
for p in Path('/etc/apt/preferences.d').glob('*'):
    if p.is_file(): shutil.copyfile(p, after / (p.name + '.pref'))
