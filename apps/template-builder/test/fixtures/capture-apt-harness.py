"""Execute the real guest exporter with hermetic guest paths and fake apt commands."""
import hashlib
import json
import pathlib
import runpy
import sys
import tempfile
from unittest.mock import patch

RealPath = type(pathlib.Path())
script, case = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='capture-apt-fixture-') as tmp:
    guest = RealPath(tmp)

    def path(value):
        value = str(value)
        # Only production guest absolute paths are remapped; all IO stays in this fixture.
        if value.startswith('/'):
            return guest / value.lstrip('/')
        return RealPath(value)

    def save(name, data):
        dest = path(name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data if isinstance(data, bytes) else data.encode())
        return dest

    lists = '/var/lib/apt/lists/'
    snapshot = '20261030T000000Z'
    snapshot_base = f'https://snapshot.ubuntu.com/ubuntu/{snapshot}/'
    sources = f'Types: deb\nSnapshot: {snapshot}\n'
    if case == 'two-snapshot-ids':
        sources += 'Snapshot: 20261029T000000Z\n'
    if case == 'missing-snapshot-id':
        sources = 'Types: deb\n'
    if case in ('proxy-http', 'proxy-canonical-after', 'proxy-wrong-id'):
        pin = '20261029T000000Z' if case == 'proxy-wrong-id' else snapshot
        sources = f'Types: deb\nURIs: http://snapshot.ubuntu.com/ubuntu/{pin}/\n'
    if case == 'proxy-mixed-ids':
        sources = f'Types: deb\nURIs: http://snapshot.ubuntu.com/ubuntu/{snapshot}/ https://snapshot.ubuntu.com/ubuntu/20261029T000000Z/\n'
    save('/etc/apt/sources.list.d/ubuntu.sources', sources)
    if case == 'proxy-canonical-after':
        save('/etc/apt/apt.conf.d/98umiak-build-proxy', 'Acquire::http::Proxy "http://192.0.2.1:3142";\n')
        save('/etc/apt/sources.list.d/docker.sources', 'URIs: http://download.docker.com/linux/ubuntu\n')
        save('/etc/apt/sources.list.d/xtradeb.sources', 'URIs: http://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/\n')
    key = b'-----BEGIN PGP PUBLIC KEY BLOCK-----\nfixture authority\n'
    save('/usr/share/keyrings/ubuntu-archive-keyring.gpg', key)
    save('/etc/apt/keyrings/docker.asc', key)
    save('/etc/apt/keyrings/xtradeb-apps.asc', key)
    if case != 'non-docker-no-doc':
        save('/usr/share/doc/fixture/copyright', 'fixture MIT notice')
    if case == 'docker-doc-notices':
        save('/usr/share/doc/docker-buildx-plugin/LICENSE', 'original Docker LICENSE')
        save('/usr/share/doc/docker-buildx-plugin/NOTICE', 'original Docker NOTICE')
    save('/etc/apt/preferences.d/fixture', 'Package: fixture\nPin-Priority: 100\n')
    save('/var/lib/umiak-layer-capture/debs/fixture.deb', b'original deb bytes')
    path('/var/lib/umiak-layer-capture/licenses').mkdir()
    targets, expected = [], {}

    def release(origin, suite, label):
        return f'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: {origin}\nSuite: {suite}\nLabel: {label}\n\n-----BEGIN PGP SIGNATURE-----\nfixture (host verifies real signatures)\n'.replace('\n', '\r\n')

    def add_target(prefix, base, suite, component, origin='Ubuntu', selected=False):
        filename = lists + prefix + f'_dists_{suite}_{component}_binary-amd64_Packages.lz4'
        content = f'original {origin} {suite} {component} Packages\n'
        save(filename, content)
        text = release(origin, suite, 'snapshot' if selected else 'live discovery')
        if selected and suite == 'resolute-backports':
            if case == 'origin-mismatch':
                text = release('Docker', suite, 'bad origin')
            if case == 'suite-mismatch':
                text = release(origin, 'resolute', 'bad suite')
            if case == 'outside-lists':
                filename = '/tmp/unexpected_dists_resolute-backports_main_binary-amd64_Packages'
        if not (selected and suite == 'resolute-backports' and case == 'missing-release'):
            save(lists + prefix + f'_dists_{suite}_InRelease', text)
        targets.append(f'Origin: {origin}\nSuite: {suite}\nTrusted: yes\nArchitecture: amd64\nBase-URI: {base}\nFilename: {filename}\nMetaKey: {component}/binary-amd64/Packages\n')
        if selected:
            family = {'Ubuntu': 'ubuntu', 'Docker': 'docker', 'LP-PPA-xtradeb-apps': 'xtradeb'}[origin]
            item = expected.setdefault(f'{family}-{suite}', dict(release=text, indexes={}))
            item['indexes'][f'{component}/binary-amd64/Packages'] = content

    for suite in ('resolute', 'resolute-updates', 'resolute-security', 'resolute-backports'):
        live_host = 'security.ubuntu.com' if suite == 'resolute-security' else 'archive.ubuntu.com'
        live_prefix = f'{live_host}_ubuntu'
        # Both stale list files and apt 3's genuinely active live discovery targets.
        save(lists + live_prefix + f'_dists_{suite}_InRelease', release('Ubuntu', suite, 'stale/live mirror'))
        if case in ('live-discovery', 'live-only-suite', 'third-party'):
            for component in ('main', 'universe'):
                add_target(live_prefix, f'http://{live_host}/ubuntu/', suite, component)
        if case == 'live-only-suite' and suite == 'resolute-security':
            continue
        for component in ('main', 'universe'):
            add_target(f'snapshot.ubuntu.com_ubuntu_{snapshot}', snapshot_base.replace('https:', 'http:') if case.startswith('proxy-') else snapshot_base, suite, component, selected=True)
    if case == 'two-snapshot-base-mirrors':
        add_target(f'snapshot.ubuntu.com_ubuntu_{snapshot}_alternate', snapshot_base + 'alternate/', 'resolute', 'main')
    if case == 'third-party':
        add_target('download.docker.com_linux_ubuntu', 'https://download.docker.com/linux/ubuntu/', 'resolute', 'stable', origin='Docker', selected=True)
        add_target('ppa.launchpadcontent.net_xtradeb_apps_ubuntu', 'https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/', 'resolute', 'main', origin='LP-PPA-xtradeb-apps', selected=True)
    commands = []

    def check_output(args, **kwargs):
        commands.append(list(args))
        if args == ('apt-get', 'indextargets', 'Identifier: Packages'):
            return '\n'.join(targets)
        if args[0] == 'dpkg-query':
            text = 'installed\tfixture\t1.0\tamd64\tfixture-source\t1.0\n'
            if case in ('docker-no-doc', 'docker-doc-notices'):
                text += 'installed\tdocker-buildx-plugin\t0.38.1-1~ubuntu.26.04~resolute\tamd64\tdocker-buildx-plugin\t0.38.1-1~ubuntu.26.04~resolute\n'
            if case == 'sunshine-no-doc':
                text += 'installed\tsunshine\t2026.914.233613\tamd64\tsunshine\t2026.914.233613\n'
            return text
        raise AssertionError(f'unexpected host command: {args}')

    def run(args, *, stdout, check):
        commands.append(list(args))
        assert args[:2] == ['/usr/lib/apt/apt-helper', 'cat-file'] and check
        stdout.write(path(args[2]).read_bytes())

    # Production code imports Path then uses absolute guest paths. Only IO/commands
    # are substituted; release_of, record parsing, selection and export run unchanged.
    with patch('pathlib.Path', side_effect=path), patch('subprocess.check_output', side_effect=check_output), patch('subprocess.run', side_effect=run), patch('shutil.which', return_value=None):
        runpy.run_path(script, run_name='__main__')

    output = path('/var/lib/umiak-layer-capture/inputs/apt-capture')
    captured = json.loads((output / 'capture.json').read_text())
    assert {repo['name'] for repo in captured['repositories']} == set(expected)
    for repo in captured['repositories']:
        selected = expected[repo['name']]
        assert repo['indexes'] == list(selected['indexes'])
        assert (output / repo['name'] / 'InRelease').read_bytes() == selected['release'].encode()
        assert (output / repo['name'] / 'archive.asc').read_bytes() == key
        for index, contents in selected['indexes'].items():
            assert (output / repo['name'] / index).read_text() == contents
    if case == 'proxy-canonical-after':
        after = path('/var/lib/umiak-layer-capture/build/apt-after')
        for name in ('ubuntu', 'docker', 'xtradeb'):
            text = (after / f'{name}.sources').read_text()
            assert 'URIs: https://' in text and '192.0.2.1' not in text
    deb = captured['debs'][0]
    assert deb['sha256'] == hashlib.sha256(b'original deb bytes').hexdigest()
    assert path('/var/lib/umiak-layer-capture/' + deb['path']).read_bytes() == b'original deb bytes'
    notices = json.loads(path('/var/lib/umiak-layer-capture/licenses/packages.json').read_text())
    assert notices[0]['source'] == 'fixture-source'
    if case == 'sunshine-no-doc':
        sunshine = next(p for p in notices if p['name'] == 'sunshine')
        assert sunshine['version'] == '2026.914.233613'
        content = path('/var/lib/umiak-layer-capture/' + sunshine['notice']).read_text()
        assert 'ships no /usr/share/doc copyright file' in content
        assert 'GPL-3.0' in content and 'pinned upstream' in content
        assert 'source companion' in content
        assert not path('/usr/share/doc/sunshine').exists()
        assert sunshine['notices'] == [sunshine['notice']]
    if case in ('docker-no-doc', 'docker-doc-notices'):
        docker = next(p for p in notices if p['name'] == 'docker-buildx-plugin')
        content = path('/var/lib/umiak-layer-capture/' + docker['notice']).read_text()
        assert 'ships no /usr/share/doc copyright file' in content
        assert 'Apache License 2.0' in content
        assert 'pinned upstream release tags' in content
        if case == 'docker-no-doc':
            assert not path('/usr/share/doc/docker-buildx-plugin').exists()
            assert docker['notices'] == [docker['notice']]
        else:
            for title in ('LICENSE', 'NOTICE'):
                entry = f'licenses/deb-notices/docker-buildx-plugin/{title}'
                assert entry in docker['notices']
                assert path('/var/lib/umiak-layer-capture/' + entry).read_text() == f'original Docker {title}'
    print(json.dumps({'repositories': captured['repositories'], 'commands': commands}))
