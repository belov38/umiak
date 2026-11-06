import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { runStep } from "../../apps/template-builder/src/runner.ts";
import { writeGuestFile } from "../../apps/template-builder/src/seal.ts";
import { captureSourceFile } from "./source-artifact.mjs";

const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Safe host-side data transformation only. Source CMake never executes on the runner. */
export async function materializeLinuxSubset({ archive, audit, output }) {
	const program = String.raw`
import gzip,hashlib,io,json,re,sys,tarfile
from pathlib import Path
audit=json.load(open(sys.argv[2]))
if audit.get('format')!='umiak-linux-source-audit/v1' or audit.get('system')!='Linux' or audit.get('target')!='libvirtualhid': raise ValueError('invalid Linux source derivation')
with tarfile.open(sys.argv[1]) as source:
    entries={}
    for member in source.getmembers():
        parts=member.name.split('/',1)
        if len(parts)!=2 or not parts[1]: continue
        path=parts[1]
        if path.startswith('/') or '..' in path.split('/'): raise ValueError('unsafe upstream source path')
        if member.isfile(): entries[path]=member
    mapping=source.extractfile(entries['LICENSES/license-map.md']).read().decode()
    excluded=[]
    for block in re.split(r'\n(?=- )',mapping):
        if 'LizardByte Source-Available License' in block:
            excluded += [p for p in re.findall(chr(96)+'([^'+chr(96)+']+)'+chr(96),block) if '/' in p and not p.startswith(('http:','https:'))]
    if not excluded or sorted(set(excluded))!=audit['excludedSALPaths']: raise ValueError('upstream SAL path map differs from the guest audit')
    def check(path):
        if path.startswith('/') or '..' in path.split('/'): raise ValueError('unsafe derived source path')
        if any(path==p.rstrip('/') or path.startswith(p) for p in excluded): raise ValueError('SAL-licensed file used by Linux target: '+path)
    for path in audit['targetSources']+audit['compilerDependencies']+audit['interfaceHeaders']+audit['cmakeInputs']: check(path)
    selected={};generated=[]
    for item in audit['files']:
        path=item['path'];check(path)
        if path not in entries:
            generated.append(item);continue
        data=source.extractfile(entries[path]).read()
        if hashlib.sha256(data).hexdigest()!=item['sha256'] or len(data)!=item['sizeBytes']: raise ValueError('configured Linux input differs from the original source: '+path)
        selected[path]=data
    required=['CMakeLists.txt','src/CMakeLists.txt','LICENSE.md','LICENSES/license-map.md']
    if any(p not in selected for p in required) or not any(p.startswith('LICENSES/') and 'MIT' in p for p in selected): raise ValueError('Linux subset omits its build inputs or MIT notices')
    with open(sys.argv[3],'wb') as target,gzip.GzipFile(filename='',fileobj=target,mode='wb',mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w',format=tarfile.USTAR_FORMAT) as subset:
        for path,data in sorted(selected.items()):
            info=tarfile.TarInfo('libvirtualhid/'+path);info.size=len(data);info.mode=0o755 if entries[path].mode&0o111 else 0o644
            subset.addfile(info,io.BytesIO(data))
    print(json.dumps(dict(selectedFiles=sorted(selected),generatedInputs=generated,excludedSALPaths=sorted(set(excluded)))))
`;
	const file = `${output}.audit.json`;
	await writeFile(file, JSON.stringify(audit));
	try {
		const { stdout } = await exec(
			"python",
			["-c", program, archive, file, output],
			{ maxBuffer: 2 * 1024 ** 2, timeout: 120000 },
		);
		return JSON.parse(stdout);
	} finally {
		await rm(file, { force: true });
	}
}
async function copyToGuest(io, path, destination) {
	const must = async (cmd, input) => {
		const r = await io.exec(cmd, {
			...(input === undefined ? {} : { input }),
			timeoutMs: 120000,
		});
		if (r.exitCode !== 0)
			throw Error(`Source audit transfer failed: ${r.stderr.slice(0, 500)}`);
	};
	await must([
		"sh",
		"-c",
		'mkdir -p "$(dirname "$1")"; : > "$1"',
		"sh",
		destination,
	]);
	const stream = createReadStream(path, { highWaterMark: 24 * 1024 });
	for await (const chunk of stream)
		await must(
			["sh", "-c", 'base64 -d >> "$1"', "sh", destination],
			chunk.toString("base64"),
		);
}
export async function deriveLinuxSourceSubset({
	source,
	cache,
	guest,
	commit,
}) {
	if (!guest)
		throw Error(
			"Mixed-license libvirtualhid source requires an isolated Linux CMake audit guest",
		);
	const scratch = await mkdtemp(join(cache, ".linux-source-subset-"));
	const guestRoot = `/var/tmp/umiak-source-audit-${randomUUID()}`;
	try {
		const archive = join(scratch, "upstream.tar.gz"),
			target = await open(archive, "wx");
		try {
			for (const chunk of source.chunks)
				for await (const b of createReadStream(
					join(cache, "blobs/sha256", chunk.sha256),
				))
					await target.writeFile(b);
		} finally {
			await target.close();
		}
		const bytes = await readFile(
			new URL("./source-audit-libvirtualhid.py", import.meta.url),
		);
		await copyToGuest(guest, archive, `${guestRoot}/upstream.tar.gz`);
		await writeGuestFile(guest, `${guestRoot}/audit.py`, bytes.toString());
		const script = `#!/bin/bash
set -euo pipefail
printf '%s  %s\\n' '${source.sha256}' '${guestRoot}/upstream.tar.gz' | sha256sum --check --status
# This audit runs after export, in the disposable online capture VM. These dev packages never enter the layer.
timeout 900s apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -y --no-install-recommends install libevdev-dev libx11-dev libxtst-dev
python3 -I '${guestRoot}/audit.py' '${guestRoot}/upstream.tar.gz' '${guestRoot}/result.json'
`;
		await writeGuestFile(guest, `${guestRoot}/audit.sh`, script);
		await runStep(guest, {
			name: "source-audit-libvirtualhid",
			script: `${guestRoot}/audit.sh`,
			log: (line) => console.log(`[source audit] ${line}`),
			timeoutMs: 30 * 60_000,
		});
		const result = await guest.readFile(
			`${guestRoot}/result.json`,
			0,
			1024 ** 2,
		);
		if (!result.length || result.length >= 1024 ** 2)
			throw Error("Source audit result is missing or exceeds its bound");
		const audit = JSON.parse(result);
		const output = join(scratch, "linux-mit.tar.gz");
		const selection = await materializeLinuxSubset({ archive, audit, output });
		// Reconstruct and compile only the selected original bytes. Missing generator/header inputs fail here.
		await copyToGuest(guest, output, `${guestRoot}/subset.tar.gz`);
		await writeGuestFile(
			guest,
			`${guestRoot}/replay.sh`,
			`#!/bin/bash
set -euo pipefail
mkdir '${guestRoot}/replay'
python3 -I '${guestRoot}/audit.py' '${guestRoot}/subset.tar.gz' '${guestRoot}/replay/result.json'
`,
		);
		await runStep(guest, {
			name: "source-audit-libvirtualhid-subset",
			script: `${guestRoot}/replay.sh`,
			log: (line) => console.log(`[source subset] ${line}`),
			timeoutMs: 15 * 60_000,
		});
		const replayBytes = await guest.readFile(
			`${guestRoot}/replay/result.json`,
			0,
			1024 ** 2,
		);
		if (!replayBytes.length || replayBytes.length >= 1024 ** 2)
			throw Error("Reconstructed source audit exceeds its bound");
		const replay = JSON.parse(replayBytes);
		for (const field of [
			"targetSources",
			"compilerDependencies",
			"interfaceHeaders",
			"cmakeInputs",
			"files",
		])
			if (JSON.stringify(audit[field]) !== JSON.stringify(replay[field]))
				throw Error(`Reconstructed Linux subset changes ${field}`);
		const contents = await readFile(output);
		const subset = await captureSourceFile({
			url: `${source.url}#linux-mit-subset`,
			sha256: sha(contents),
			sizeBytes: (await stat(output)).size,
			cache,
			fetcher: async () =>
				new Response(Readable.toWeb(createReadStream(output))),
		});
		return {
			...subset,
			originalArchive: {
				url: source.url,
				sha256: source.sha256,
				sizeBytes: source.sizeBytes,
				commit,
			},
			derivation: {
				...audit,
				...selection,
				auditScriptSha256: sha(bytes),
				auditScript: bytes.toString(),
				reconstructionVerified: true,
				scope:
					"MIT Linux library sources/build inputs only; SAL code and unrelated Windows drivers are excluded",
			},
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
