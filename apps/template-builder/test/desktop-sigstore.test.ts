import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const recipe = readFileSync(
	new URL(
		"../../../infra/templates/linux-desktop/steps/60-desktop.sh",
		import.meta.url,
	),
	"utf8",
);
const start = recipe.indexOf("# Pin cosign's TUF cache");
const end = recipe.indexOf("install -d -o user", start);
const pem = (kind: string, value: string) =>
	`-----BEGIN ${kind}-----\n${Buffer.from(value).toString("base64")}\n-----END ${kind}-----\n`;

it("sets TUF_ROOT before verification and captures the root from that cache, never /root/.sigstore", () => {
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	expect(recipe.slice(start, end)).toContain(
		'export TUF_ROOT="$UMIAK_WORK_DIR/sigstore-tuf"',
	);
	expect(recipe).not.toContain("/root/.sigstore");
	expect(recipe).toContain(
		'trusted_root="$TUF_ROOT/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"',
	);
	expect(recipe).toContain(
		'cp "$trusted_root" "$UMIAK_CAPTURE_DIR/inputs/desktop/"',
	);
});

for (const mode of ["capture", "replay", "tampered", "wrong-key"] as const) {
	it(`verifies the real legacy Sigstore recipe block without HOME or network: ${mode}`, () => {
		const root = mkdtempSync(join(tmpdir(), "umiak-sigstore-"));
		try {
			const work = join(root, "work"),
				layer = join(root, "layer"),
				capture = join(root, "capture");
			const desktop = join(layer, "inputs/desktop");
			mkdirSync(work);
			mkdirSync(desktop, { recursive: true });
			const trust = {
				certificateAuthorities: [
					{
						certChain: {
							certificates: ["fulcio-root", "fulcio-intermediate"].map((s) => ({
								rawBytes: Buffer.from(s).toString("base64"),
							})),
						},
					},
					{
						certChain: {
							certificates: [
								{
									rawBytes: Buffer.from("other-fulcio-root").toString("base64"),
								},
							],
						},
					},
				],
				tlogs: ["wrong-rekor", "right-rekor"].map((s) => ({
					publicKey: { rawBytes: Buffer.from(s).toString("base64") },
				})),
				ctlogs: [
					"old-test-ct",
					mode === "wrong-key" ? "wrong-ct" : "right-ct",
				].map((s) => ({
					publicKey: { rawBytes: Buffer.from(s).toString("base64") },
				})),
			};
			writeFileSync(join(desktop, "trusted_root.json"), JSON.stringify(trust));
			// Legacy bundle is copied unchanged; stub cosign tests orchestration, not cryptography.
			writeFileSync(
				join(desktop, "cua-driver.sigstore.json"),
				JSON.stringify({
					base64Signature: "fixture",
					cert: "fixture",
					rekorBundle: {},
				}),
			);
			const payload = "original pinned Cua archive";
			writeFileSync(
				join(work, "cua-driver.tar.gz"),
				mode === "tampered" ? "tampered" : payload,
			);
			const checker = join(root, "cosign.py");
			writeFileSync(
				checker,
				`import hashlib,json,os,pathlib,shutil,sys
assert 'HOME' not in os.environ
work=pathlib.Path(os.environ['UMIAK_WORK_DIR'])
desktop=pathlib.Path(os.environ['UMIAK_LAYER_ROOT'])/'inputs/desktop'
args=sys.argv[1:]
offline=os.environ['UMIAK_LAYER_MODE']=='replay'
expected=['verify-blob']+(['--offline'] if offline else [])+['--bundle',str(work/'cua-driver.sigstore.json'),'--certificate-identity','https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v0.38.0','--certificate-oidc-issuer','https://token.actions.githubusercontent.com',str(work/'cua-driver.tar.gz')]
assert args==expected, args
assert json.loads((work/'cua-driver.sigstore.json').read_text())['base64Signature']=='fixture'
if not offline:
    dest=pathlib.Path(os.environ['TUF_ROOT'])/'tuf-repo-cdn.sigstore.dev/targets/trusted_root.json'
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(desktop/'trusted_root.json',dest)
    sys.exit(0)
fulcio=pathlib.Path(os.environ['SIGSTORE_ROOT_FILE']).read_text()
assert fulcio==${JSON.stringify(["fulcio-root", "fulcio-intermediate", "other-fulcio-root"].map((s) => pem("CERTIFICATE", s)).join(""))}
rekor=pathlib.Path(os.environ['SIGSTORE_REKOR_PUBLIC_KEY'])
ct=pathlib.Path(os.environ['SIGSTORE_CT_LOG_PUBLIC_KEY_FILE'])
assert rekor.read_text().count('BEGIN PUBLIC KEY')==1
assert ct.read_text().count('BEGIN PUBLIC KEY')==1
with (work/'attempts').open('a') as f: f.write(rekor.name+':'+ct.name+'\\n')
valid=rekor.read_text()==${JSON.stringify(pem("PUBLIC KEY", "right-rekor"))} and ct.read_text()==${JSON.stringify(pem("PUBLIC KEY", "right-ct"))}
valid=valid and hashlib.sha256((work/'cua-driver.tar.gz').read_bytes()).hexdigest()==${JSON.stringify(createHash("sha256").update(payload).digest("hex"))}
sys.exit(0 if valid else 1)
`,
			);
			writeFileSync(
				join(work, "cosign"),
				'#!/bin/sh\nexec python3 "$FIXTURE_CHECKER" "$@"\n',
				{ mode: 0o755 },
			);
			const env = { ...process.env };
			delete env.HOME;
			delete env.SIGSTORE_ROOT_FILE;
			delete env.SIGSTORE_REKOR_PUBLIC_KEY;
			delete env.SIGSTORE_CT_LOG_PUBLIC_KEY_FILE;
			const script = `die() { echo "DIE: $*" >&2; exit 47; }
curl() { cp "$UMIAK_LAYER_ROOT/inputs/desktop/cua-driver.sigstore.json" "$UMIAK_WORK_DIR/cua-driver.sigstore.json"; }
cua=0.38.0
${recipe.slice(start, end)}
`;
			const result = spawnSync("bash", ["-euc", script], {
				encoding: "utf8",
				timeout: 10000,
				env: {
					...env,
					UMIAK_WORK_DIR: work,
					UMIAK_LAYER_ROOT: layer,
					UMIAK_CAPTURE_DIR: capture,
					UMIAK_LAYER_MODE: mode === "capture" ? "capture" : "replay",
					FIXTURE_CHECKER: checker,
					HTTP_PROXY: "http://127.0.0.1:1",
					HTTPS_PROXY: "http://127.0.0.1:1",
				},
			});
			expect(result.error).toBeUndefined();
			if (mode === "tampered" || mode === "wrong-key") {
				expect(result.status, result.stderr).toBe(47);
				expect(result.stderr).toContain(
					"Cua Driver signature failed offline verification",
				);
			} else expect(result.status, result.stderr).toBe(0);
			if (mode === "capture") {
				expect(
					readFileSync(
						join(capture, "inputs/desktop/trusted_root.json"),
						"utf8",
					),
				).toBe(JSON.stringify(trust));
			} else {
				expect(
					readFileSync(join(work, "attempts"), "utf8").trim().split("\n"),
				).toEqual([
					"tlogs-0.pub:ctlogs-0.pub",
					"tlogs-0.pub:ctlogs-1.pub",
					"tlogs-1.pub:ctlogs-0.pub",
					"tlogs-1.pub:ctlogs-1.pub",
				]);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
