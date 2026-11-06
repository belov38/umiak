#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Runs only in the isolated Linux capture guest, after its layer export is frozen."""
import hashlib
import json
import platform
import re
import subprocess
import sys
import tarfile
from pathlib import Path


def sal_paths(text):
    result = []
    for block in re.split(r'\n(?=- )', text):
        if 'LizardByte Source-Available License' not in block:
            continue
        for value in re.findall(r'`([^`]+)`', block):
            if '/' in value and not value.startswith(('http:', 'https:')):
                if value.startswith('/') or '..' in value.split('/'):
                    raise ValueError('unsafe upstream license-map path')
                result.append(value)
    if not result:
        raise ValueError('upstream SAL path map is missing or changed')
    return sorted(set(result))


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def audit(archive, result_file):
    if platform.system() != 'Linux':
        raise ValueError('source audit requires an isolated Linux guest')
    work = result_file.parent
    unpack = work / 'unpack'
    unpack.mkdir()
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if len(members) > 50000 or sum(m.size for m in members) > 2 * 1024**3:
            raise ValueError('source archive exceeds audit bounds')
        source.extractall(unpack, filter='data')
    roots = list(unpack.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('source archive must have one project root')
    root = roots[0].resolve()
    license_map = (root / 'LICENSES/license-map.md').read_text()
    excluded = sal_paths(license_map)

    def relative(value, base):
        path = Path(value)
        if not path.is_absolute():
            path = base / path
        path = path.resolve()
        if not path.is_relative_to(root):
            return None
        return path.relative_to(root).as_posix()

    def check(paths):
        for path in paths:
            if any(path == item.rstrip('/') or path.startswith(item) for item in excluded):
                raise ValueError(f'SAL-licensed file is used by the Linux target: {path}')

    wrapper = work / 'wrapper'
    wrapper.mkdir()
    # A subproject, as in Sunshine. Diagnostics/tests/docs/Windows packages are not the library target.
    (wrapper / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.24)
project(SunshineLinuxSourceAudit LANGUAGES C CXX)
set(BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LIBVIRTUALHID_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LIBVIRTUALHID_BUILD_WINDOWS_DRIVER OFF CACHE BOOL "" FORCE)
set(LIBVIRTUALHID_BUILD_WINDOWS_BROKER OFF CACHE BOOL "" FORCE)
set(LIBVIRTUALHID_INSTALL OFF CACHE BOOL "" FORCE)
set(LIBVIRTUALHID_ENABLE_PACKAGING OFF CACHE BOOL "" FORCE)
add_subdirectory("''' + str(root) + '''" libvirtualhid)
file(GENERATE OUTPUT "${CMAKE_BINARY_DIR}/interface-includes.txt"
     CONTENT "$<TARGET_GENEX_EVAL:libvirtualhid,$<TARGET_PROPERTY:libvirtualhid,INTERFACE_INCLUDE_DIRECTORIES>>")
''')
    build = work / 'build'
    query = build / '.cmake/api/v1/query'
    query.mkdir(parents=True)
    for name in ('codemodel-v2', 'cmakeFiles-v1'):
        (query / name).write_text('')
    command = ['cmake', '-S', str(wrapper), '-B', str(build), '-G', 'Unix Makefiles',
               '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
               '-DLIBVIRTUALHID_ENABLE_XTEST=ON', '-DLIBVIRTUALHID_WARNINGS_AS_ERRORS=OFF']
    subprocess.run(command, check=True, timeout=300)
    reply = build / '.cmake/api/v1/reply'
    index = json.loads(sorted(reply.glob('index-*.json'))[-1].read_text())
    model = json.loads((reply / index['reply']['codemodel-v2']['jsonFile']).read_text())
    target = next(t for c in model['configurations'] for t in c['targets'] if t['name'] == 'libvirtualhid')
    target = json.loads((reply / target['jsonFile']).read_text())
    target_sources = sorted(filter(None, (relative(s['path'], wrapper) for s in target['sources'])))
    if not target_sources:
        raise ValueError('CMake produced no Linux library sources')
    check(target_sources)
    subprocess.run(['cmake', '--build', str(build), '--target', 'libvirtualhid', '--parallel', '2'], check=True, timeout=600)
    dependencies = set(target_sources)
    depfiles = list(build.rglob('*.o.d'))
    if not depfiles:
        raise ValueError('compiler produced no dependency files')
    for depfile in depfiles:
        text = depfile.read_text().replace('\\\n', ' ')
        for value in text.split(':', 1)[-1].split():
            path = relative(value, build)
            if path:
                dependencies.add(path)
    check(dependencies)
    # Preserve the exported API as well as headers compiled by the static library itself:
    # Sunshine consumes this interface, including headers not used by libvirtualhid's own .cpp files.
    interface_headers = set()
    for directory in (build / 'interface-includes.txt').read_text().split(';'):
        if not directory:
            continue
        if '$<' in directory:
            raise ValueError('unresolved CMake exported include expression')
        directory = Path(directory).resolve()
        if directory.is_relative_to(root):
            for header in directory.rglob('*'):
                if header.is_file():
                    interface_headers.add(header.relative_to(root).as_posix())
    if not interface_headers:
        raise ValueError('CMake exported no public Linux API headers')
    check(interface_headers)
    cmake_files = json.loads((reply / index['reply']['cmakeFiles-v1']['jsonFile']).read_text())
    build_inputs = sorted(filter(None, (relative(item['path'], wrapper) for item in cmake_files['inputs'])))
    check(build_inputs)
    # Derive the notice path from the pinned upstream repository summary, not a file allowlist.
    notices = re.findall(r'\[[^\]]*MIT[^\]]*\]\((LICENSES/[^)]+)\)', (root / 'LICENSE.md').read_text())
    if not notices:
        raise ValueError('upstream MIT notice reference is missing')
    selected = sorted(dependencies | interface_headers | set(build_inputs) | set(notices) | {'LICENSE.md', 'LICENSES/license-map.md'})
    check(selected)
    files = []
    for path in selected:
        file = root / path
        if not file.is_file():
            raise ValueError(f'Linux build input is not a regular file: {path}')
        files.append(dict(path=path, sha256=sha(file), sizeBytes=file.stat().st_size))
    result_file.write_text(json.dumps(dict(
        format='umiak-linux-source-audit/v1', system='Linux',
        method='CMake File API libvirtualhid target + actual GCC dependency files + exported API headers + CMake configuration inputs',
        command=command, target='libvirtualhid', targetSources=target_sources,
        compilerDependencies=sorted(dependencies), interfaceHeaders=sorted(interface_headers), cmakeInputs=build_inputs,
        excludedSALPaths=excluded, files=files,
        cmakeVersion=subprocess.check_output(['cmake', '--version'], text=True).splitlines()[0],
        compilerVersion=subprocess.check_output(['c++', '--version'], text=True).splitlines()[0],
        wrapperCMake=(wrapper / 'CMakeLists.txt').read_text().replace(str(root), '${SOURCE_ROOT}'),
        wrapperSha256=sha(wrapper / 'CMakeLists.txt'),
        compileCommands=[dict(file=relative(item['file'], build),
                              command=item['command'].replace(str(root), '${SOURCE_ROOT}').replace(str(work), '${WORK}'))
                         for item in json.loads((build / 'compile_commands.json').read_text())],
    )))


if __name__ == '__main__':
    audit(Path(sys.argv[1]), Path(sys.argv[2]))
