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
lists = Path('/var/lib/apt/lists')


def release_of(target):
    # The InRelease beside the index apt actually uses. Earlier updates (cloud-init
    # bootstrap before the snapshot pin) leave stale lists from other mirrors with
    # the same origin/suite; never pick a Release by scanning the whole directory.
    index = Path(target['filename'])
    prefix, sep, rest = index.name.partition('_dists_')
    if not sep or index.parent != lists:
        raise ValueError('unexpected apt index location')
    dist = rest.split('_', 1)[0]
    path = lists / f'{prefix}_dists_{dist}_InRelease'
    if not path.is_file():
        raise ValueError('apt InRelease missing for an active index')
    text = path.read_text()
    # Parse only the signed cleartext body; signature verification happens on the host.
    body = text.split('\n\n', 1)[1].split('-----BEGIN PGP SIGNATURE-----', 1)[0]
    fields = records(body)[0]
    if (fields.get('origin'), fields.get('suite')) != (target.get('origin'), target.get('suite')):
        raise ValueError('apt InRelease does not match its index target')
    return path


# apt 3 resolves `Snapshot:` by fetching the live archive InRelease (for its
# `Snapshots:` URL) and then the snapshot itself, so live archive targets stay
# active beside the pinned snapshot ones. Packages come from the snapshot only:
# capture exactly those Ubuntu targets and ignore the live discovery targets.
snapshot_ids = {
    line.split(':', 1)[1].strip()
    for line in Path('/etc/apt/sources.list.d/ubuntu.sources').read_text().splitlines()
    if line.startswith('Snapshot:')
}
# A capture-only cache proxy uses an explicit pinned URI instead of apt 3 discovery.
for line in Path('/etc/apt/sources.list.d/ubuntu.sources').read_text().splitlines():
    if line.startswith('URIs:'):
        for uri in line.split(':', 1)[1].split():
            match = re.fullmatch(r'https?://snapshot\.ubuntu\.com/ubuntu/(\d{8}T\d{6}Z)/?', uri)
            if match:
                snapshot_ids.add(match.group(1))
if len(snapshot_ids) != 1:
    raise ValueError('expected exactly one pinned Ubuntu apt snapshot')
snapshot_id = snapshot_ids.pop()
snapshot_bases = tuple(f'{scheme}://snapshot.ubuntu.com/ubuntu/{snapshot_id}/' for scheme in ('https', 'http'))


def live_ubuntu_discovery(target):
    return target.get('origin') == 'Ubuntu' and not target.get('base-uri', '').startswith(snapshot_bases)


releases = {}
repos = {}
targets = [
    target for target in records(run('apt-get', 'indextargets', 'Identifier: Packages'))
    if target.get('architecture') == 'amd64'
]
captured_ubuntu = {target.get('suite') for target in targets
                   if target.get('origin') == 'Ubuntu' and not live_ubuntu_discovery(target)}
if any(target.get('suite') not in captured_ubuntu for target in targets if live_ubuntu_discovery(target)):
    raise ValueError('an Ubuntu suite has no pinned snapshot index')
for target in targets:
    if live_ubuntu_discovery(target):
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
        release = release_of(target)
        releases[name] = release
        shutil.copyfile(release, directory / 'InRelease')
        key = Path(keyring).read_bytes()
        if not key.startswith(b'-----BEGIN PGP PUBLIC KEY BLOCK-----'):
            key = subprocess.check_output(['gpg', '--batch', '--no-options', '--no-default-keyring', '--keyring', keyring, '--armor', '--export', fingerprint])
        if not key:
            raise ValueError('pinned apt authority missing')
        (directory / 'archive.asc').write_bytes(key)
        repo = dict(name=name, suite=suite, components=[], keyFingerprint=fingerprint, indexes=[])
        repos[name] = repo
    if release_of(target) != releases[name]:
        raise ValueError(f'ambiguous captured apt Release: {name}')
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
DOCKER_PACKAGES = {'docker-ce', 'docker-ce-cli', 'docker-ce-rootless-extras', 'docker-buildx-plugin', 'docker-compose-plugin', 'containerd.io'}
# Upstream .deb packages fetched directly (not from an apt archive) that ship no
# Debian copyright file. Their GPL-3.0 license text is collected by the host from
# the pinned upstream tag and their exact source sits in the source companion.
UPSTREAM_GPL_PACKAGES = {'sunshine'}
UPSTREAM_GPL_NOTICE = (
    '{name} {version} is the upstream release .deb and ships no /usr/share/doc copyright file.\n'
    'License: GPL-3.0. The exact license text is collected from the pinned upstream\n'
    'release tag into licenses/upstream, and the corresponding source is published in\n'
    'the layer source companion.\n'
)
DOCKER_NOTICE = (
    '{name} {version} from download.docker.com ships no /usr/share/doc copyright file.\n'
    'Upstream license: Apache License 2.0. The exact LICENSE and NOTICE texts are\n'
    'collected from the pinned upstream release tags into licenses/upstream and\n'
    'listed in the layer inventory (Docker components).\n'
)
packages = []
for line in run('dpkg-query', '-W', '-f', '${db:Status-Status}\t${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n').splitlines():
    status, name, version, arch, source, source_version = line.split('\t')
    if status != 'installed':
        continue
    doc = Path('/usr/share/doc') / name.split(':')[0] / 'copyright'
    notice = f'licenses/deb/{name.replace(":", "_")}.copyright'
    destination = root / notice
    destination.parent.mkdir(parents=True, exist_ok=True)
    if doc.is_file():
        shutil.copyfile(doc, destination)
    elif name.split(':')[0] in UPSTREAM_GPL_PACKAGES:
        destination.write_text(UPSTREAM_GPL_NOTICE.format(name=name, version=version))
    elif name.split(':')[0] in DOCKER_PACKAGES:
        # Docker's own repository packages ship no Debian copyright file. The host
        # collects their Apache-2.0 LICENSE/NOTICE texts from the pinned upstream
        # release tags (layer-notices.mjs); record that here instead of a copy.
        destination.write_text(DOCKER_NOTICE.format(name=name, version=version))
    else:
        raise ValueError(f'package license notice missing: {name}')
    notices=[notice]
    if not doc.parent.is_dir():
        packages.append(dict(name=name, version=version, arch=arch, source=source, sourceVersion=source_version, notice=notice, notices=notices))
        continue
    for extra in sorted(doc.parent.iterdir()):
        if extra.is_file() and extra.name.lower().startswith(('license','licence','copying','notice')):
            relative=f'licenses/deb-notices/{name.replace(":", "_")}/{extra.name}'
            target=root/relative; target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(extra,target); notices.append(relative)
    packages.append(dict(name=name, version=version, arch=arch, source=source, sourceVersion=source_version, notice=notice, notices=notices))
(root / 'licenses/packages.json').write_text(json.dumps(packages))
# Record the versions of the Apache Docker runtime components for source references.
components={}
for tool in ('runc','containerd','dockerd'):
    executable=shutil.which(tool)
    if executable:
        components[tool]=subprocess.check_output([executable,'--version'],text=True,timeout=30).strip()
(root / 'licenses/docker-components.json').write_text(json.dumps(components))


# Preserve normal post-customization update sources without using them during replay.
after = root / 'build/apt-after'
after.mkdir(parents=True, exist_ok=True)
for p in Path('/etc/apt/sources.list.d').glob('*.sources'):
    if not Path('/etc/apt/apt.conf.d/98umiak-build-proxy').is_file():
        shutil.copyfile(p, after / p.name)
        continue
    text = p.read_text()
    for repository in ('snapshot.ubuntu.com/ubuntu/', 'download.docker.com/linux/ubuntu', 'ppa.launchpadcontent.net/xtradeb/apps/ubuntu'):
        text = text.replace('http://' + repository, 'https://' + repository)
    (after / p.name).write_text(text)
for p in Path('/etc/apt/preferences.d').glob('*'):
    if p.is_file(): shutil.copyfile(p, after / (p.name + '.pref'))
