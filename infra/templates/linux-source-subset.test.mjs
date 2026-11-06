import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeLinuxSubset } from "./linux-source-subset.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(run) {
	const root = await mkdtemp(join(tmpdir(), "umiak-linux-subset-test-"));
	try {
		const files = {
			"CMakeLists.txt": "add_subdirectory(src)",
			"src/CMakeLists.txt": "add_library(libvirtualhid core/linux.cpp)",
			"src/core/linux.cpp": "// MIT Linux implementation",
			"src/include/library.hpp": "// MIT header",
			"src/include/exported-only.hpp": "// Sunshine-only public header",
			"LICENSE.md": "[MIT License](LICENSES/MIT.md)",
			"LICENSES/MIT.md": "MIT notice fixture",
			"LICENSES/license-map.md":
				"# Map\n\n- Library: MIT.\n- Driver `src/platform/windows/driver/` and `src/platform/windows/broker/sal.hpp`:\n  [LizardByte Source-Available License 1.0](https://example.test/sal).\n",
			"src/platform/windows/driver/sal.cpp": "// Excluded SAL driver",
			"src/platform/windows/broker/sal.hpp": "// Excluded SAL broker",
			"src/platform/windows/unused-mit.cpp": "// Unused MIT Windows backend",
		};
		const archive = join(root, "upstream.tar.gz");
		execFileSync(
			"python",
			[
				"-c",
				`
import io,json,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as archive:
    for path,text in json.load(sys.stdin).items():
        data=text.encode();member=tarfile.TarInfo('original/'+path);member.size=len(data)
        archive.addfile(member,io.BytesIO(data))
`,
				archive,
			],
			{ input: JSON.stringify(files) },
		);
		const selected = Object.keys(files).filter(
			(p) => !p.startsWith("src/platform/"),
		);
		const audit = {
			format: "umiak-linux-source-audit/v1",
			system: "Linux",
			target: "libvirtualhid",
			targetSources: ["src/core/linux.cpp"],
			compilerDependencies: ["src/core/linux.cpp", "src/include/library.hpp"],
			interfaceHeaders: [
				"src/include/exported-only.hpp",
				"src/include/library.hpp",
			],
			cmakeInputs: ["CMakeLists.txt", "src/CMakeLists.txt"],
			excludedSALPaths: [
				"src/platform/windows/broker/sal.hpp",
				"src/platform/windows/driver/",
			],
			files: selected.map((path) => ({
				path,
				sha256: sha(files[path]),
				sizeBytes: Buffer.byteLength(files[path]),
			})),
		};
		await run({ root, archive, audit, files });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
test("packages the compiler-derived MIT closure deterministically, preserving the upstream notices/map", async () => {
	await fixture(async ({ root, archive, audit, files }) => {
		const output = join(root, "subset.tar.gz");
		const selection = await materializeLinuxSubset({ archive, audit, output });
		assert.deepEqual(
			selection.selectedFiles,
			audit.files.map((f) => f.path).sort(),
		);
		assert.deepEqual(selection.excludedSALPaths, audit.excludedSALPaths);
		const actual = JSON.parse(
			execFileSync(
				"python",
				[
					"-c",
					`
import json,sys,tarfile
with tarfile.open(sys.argv[1]) as a: print(json.dumps({m.name:a.extractfile(m).read().decode() for m in a.getmembers()}))
`,
					output,
				],
				{ encoding: "utf8" },
			),
		);
		for (const path of selection.selectedFiles)
			assert.equal(actual[`libvirtualhid/${path}`], files[path]);
		assert.ok(!Object.keys(actual).some((p) => p.includes("windows/")));
		const first = await readFile(output);
		await materializeLinuxSubset({ archive, audit, output });
		assert.deepEqual(await readFile(output), first);
	});
});
for (const field of [
	"targetSources",
	"compilerDependencies",
	"interfaceHeaders",
	"cmakeInputs",
])
	test(`stops if a SAL file occurs in ${field}`, async () => {
		await fixture(async ({ root, archive, audit }) => {
			audit[field].push("src/platform/windows/driver/sal.cpp");
			await assert.rejects(
				materializeLinuxSubset({
					archive,
					audit,
					output: join(root, "subset.tar.gz"),
				}),
				/SAL-licensed file/,
			);
		});
	});
test("rejects changed license maps or source bytes before producing a subset", async () => {
	await fixture(async ({ root, archive, audit }) => {
		const output = join(root, "subset.tar.gz");
		const changed = structuredClone(audit);
		changed.excludedSALPaths = [];
		await assert.rejects(
			materializeLinuxSubset({ archive, audit: changed, output }),
			/SAL path map differs/,
		);
		audit.files[0].sha256 = "0".repeat(64);
		await assert.rejects(
			materializeLinuxSubset({ archive, audit, output }),
			/differs from the original/,
		);
	});
});
test("records generated build inputs separately instead of copying generated or unused source", async () => {
	await fixture(async ({ root, archive, audit }) => {
		const generated = {
			path: "generated/version.hpp",
			sha256: sha("generated"),
			sizeBytes: 9,
		};
		audit.files.push(generated);
		const selection = await materializeLinuxSubset({
			archive,
			audit,
			output: join(root, "subset.tar.gz"),
		});
		assert.deepEqual(selection.generatedInputs, [generated]);
		assert.ok(!selection.selectedFiles.includes(generated.path));
	});
});

test("isolated auditor derives its closure from CMake/compiler evidence and stops on SAL dependencies", async () => {
	await fixture(async ({ root, archive }) => {
		const program = `
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('audit',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# Parser fixture only: all subprocess calls are replaced; upstream CMake never executes on this host.
module.platform.system=lambda:'Linux'
module.subprocess.check_output=lambda *a,**kw:'fixture compiler/CMake'
def one(name,sal):
    work=Path(sys.argv[3])/name;work.mkdir()
    def run(command,**kw):
        source=next((work/'unpack').iterdir());build=work/'build';reply=build/'.cmake/api/v1/reply'
        if '--build' not in command:
            reply.mkdir(parents=True)
            (reply/'index-fixture.json').write_text(json.dumps({'reply':{'codemodel-v2':{'jsonFile':'model.json'},'cmakeFiles-v1':{'jsonFile':'cmake.json'}}}))
            (reply/'model.json').write_text(json.dumps({'configurations':[{'targets':[{'name':'libvirtualhid','jsonFile':'target.json'}]}]}))
            (reply/'target.json').write_text(json.dumps({'sources':[{'path':str(source/'src/core/linux.cpp')}]}))
            (reply/'cmake.json').write_text(json.dumps({'inputs':[{'path':str(source/p)} for p in ['CMakeLists.txt','src/CMakeLists.txt']]}))
            (build/'interface-includes.txt').write_text(str(source/'src/include'))
            (build/'compile_commands.json').write_text(json.dumps([{'file':str(source/'src/core/linux.cpp'),'command':'fixture compile'}]))
        else:
            dep='src/platform/windows/driver/sal.cpp' if sal else 'src/include/library.hpp'
            (build/'linux.cpp.o.d').write_text('object: '+str(source/'src/core/linux.cpp')+' '+str(source/dep))
    module.subprocess.run=run
    module.audit(Path(sys.argv[2]),work/'result.json')
    return json.loads((work/'result.json').read_text())
result=one('mit',False)
assert result['targetSources']==['src/core/linux.cpp']
assert result['compilerDependencies']==['src/core/linux.cpp','src/include/library.hpp']
assert any(f['path']=='LICENSES/MIT.md' for f in result['files'])
assert result['interfaceHeaders']==['src/include/exported-only.hpp','src/include/library.hpp']
assert not any('unused-mit' in f['path'] for f in result['files'])
try: one('sal',True)
except ValueError as error: assert 'SAL-licensed file' in str(error)
else: raise AssertionError('SAL compiler input was accepted')
`;
		execFileSync("python", [
			"-c",
			program,
			new URL("./source-audit-libvirtualhid.py", import.meta.url).pathname,
			archive,
			root,
		]);
	});
});
