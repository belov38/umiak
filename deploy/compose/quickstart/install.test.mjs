import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const scriptPath = new URL("./install.sh", import.meta.url);
async function runInstaller({
	arch = "arm64",
	os = "Darwin",
	badChecksum = false,
	originHost = "127.0.0.1",
	corruptArchive = false,
	invalidGzip = false,
	badArchiveChecksum = false,
	tty = false,
	skipLogin = false,
	interrupt = false,
} = {}) {
	const dir = await mkdtemp(join(tmpdir(), "umiak-install-test-"));
	const bin = join(dir, "bin");
	await mkdir(bin);
	const loginLog = join(dir, "login");
	const binary = `#!/bin/sh\nprintf '%s\\n' "$@" > '${loginLog}'\n`;
	const sum = createHash("sha256").update(binary).digest("hex");
	const compressed = invalidGzip
		? Buffer.from("invalid gzip")
		: gzipSync(binary);
	const archiveSum = createHash("sha256").update(compressed).digest("hex");
	const downloads = [];
	const file = `umiak-${os === "Darwin" ? "darwin" : "linux"}-${arch === "aarch64" || arch === "arm64" ? "arm64" : "x64"}`;
	const server = createServer((req, res) => {
		downloads.push(req.url);
		if (req.url === "/downloads/SHA256SUMS")
			res.end(
				`${badChecksum ? "0".repeat(64) : sum}  ${file}\n${badArchiveChecksum ? "0".repeat(64) : archiveSum}  ${file}.gz\n`,
			);
		else if (req.url === "/downloads/DOWNLOADS")
			res.end(`0.1.0 ${file}.gz ${compressed.length}\n`);
		else if (req.url === `/downloads/${file}.gz`)
			res.end(corruptArchive ? Buffer.from("corrupt gzip") : compressed);
		else if (req.url === `/downloads/${file}`) res.end(binary);
		else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://${originHost}:${server.address().port}`;
	await writeFile(
		join(bin, "uname"),
		`#!/bin/sh\ncase "$1" in -s) echo '${os}';; -m) echo '${arch}';; esac\n`,
	);
	await chmod(join(bin, "uname"), 0o755);
	const target = join(dir, "installed");
	await mkdir(target);
	await writeFile(join(target, "umiak"), "old-binary");
	const script = (await readFile(scriptPath, "utf8")).replaceAll(
		"__UMIAK_ORIGIN__",
		origin,
	);
	const curlLog = join(dir, "curl-args");
	const realCurl = execFileSync("which", ["curl"], { encoding: "utf8" }).trim();
	await writeFile(
		join(bin, "curl"),
		`#!/bin/sh\nprintf '%s\\n' "$@" >> '${curlLog}'\n${interrupt ? 'kill -INT "$PPID"; exit 0' : `exec '${realCurl}' --noproxy '*' --connect-to '${originHost}:${server.address().port}:127.0.0.1:${server.address().port}' "$@"`}\n`,
	);
	await chmod(join(bin, "curl"), 0o755);
	const installer = join(dir, "installer.sh");
	await writeFile(installer, script);
	// A real PTY exercises the shell's -t check and curl's terminal renderer.
	const ptyRunner = `import os, pty, sys
pid, fd = pty.fork()
if pid == 0: os.execv("/bin/sh", ["/bin/sh", sys.argv[1]])
while True:
 try:
  data = os.read(fd, 65536)
  if not data: break
  os.write(1, data)
 except OSError: break
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
	const args = tty ? ["-c", ptyRunner, installer] : [installer];
	const child = spawn(tty ? "/usr/bin/python3" : "/bin/sh", args, {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			HOME: dir,
			UMIAK_INSTALL_DIR: target,
			...(skipLogin ? { UMIAK_INSTALL_SKIP_LOGIN: "1" } : {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (x) => (output += x));
	child.stderr.on("data", (x) => (output += x));
	child.stdin.end();
	const status = await new Promise((r) => child.on("close", r));
	await new Promise((r) => server.close(r));
	return {
		status,
		output,
		downloads,
		installed: await readFile(join(target, "umiak"), "utf8"),
		login: await readFile(loginLog, "utf8").catch(() => null),
		origin,
		curlArgs: await readFile(curlLog, "utf8").catch(() => ""),
	};
}
test("installs verified same-origin binary into chosen directory then pairs", async () => {
	const r = await runInstaller();
	assert.equal(r.status, 0, r.output);
	assert.match(r.installed, /#!\/bin\/sh/);
	assert.equal(r.login, `login\n--api-url\n${r.origin}\n`);
});
test("checksum failure preserves existing binary and never logs in", async () => {
	const r = await runInstaller({ badChecksum: true });
	assert.notEqual(r.status, 0);
	assert.equal(r.installed, "old-binary");
	assert.equal(r.login, null);
});
test("unsupported architecture fails before any download", async () => {
	const r = await runInstaller({ arch: "mips64" });
	assert.notEqual(r.status, 0);
	assert.deepEqual(r.downloads, []);
	assert.match(r.output, /Unsupported architecture/);
});
test("unsupported OS fails before any download", async () => {
	const r = await runInstaller({ os: "FreeBSD" });
	assert.notEqual(r.status, 0);
	assert.deepEqual(r.downloads, []);
	assert.match(r.output, /Unsupported operating system/);
});

for (const originHost of ["192.168.1.10", "100.64.0.2", "umiak.example.com"])
	test(`installs over HTTP at ${originHost} and explains same-channel checksums`, async () => {
		const r = await runInstaller({ originHost });
		assert.equal(r.status, 0, r.output);
		assert.equal(r.login, `login\n--api-url\n${r.origin}\n`);
		assert.equal(
			(r.output.match(/integrity relies on the local network/g) ?? []).length,
			1,
		);
		assert.match(r.output, /SHA256SUMS.*same.*channel/);
	});
for (const [os, arch, release] of [
	["Darwin", "x86_64", "darwin-x64"],
	["Linux", "x86_64", "linux-x64"],
	["Linux", "aarch64", "linux-arm64"],
])
	test(`installs ${release}`, async () => {
		const r = await runInstaller({ os, arch });
		assert.equal(r.status, 0, r.output);
		assert.ok(r.downloads.includes(`/downloads/umiak-${release}.gz`));
	});

for (const mode of ["corruptArchive", "badArchiveChecksum", "invalidGzip"])
	test(`${mode} preserves existing binary and never pairs`, async () => {
		const r = await runInstaller({ [mode]: true });
		assert.notEqual(r.status, 0);
		assert.equal(r.installed, "old-binary");
		assert.equal(r.login, null);
		assert.match(r.output, /Checksum verification failed|Decompression failed/);
	});
for (const tty of [false, true])
	test(`download progress uses stderr TTY=${tty}`, async () => {
		const r = await runInstaller({ tty });
		assert.equal(r.status, 0, r.output);
		assert.match(
			r.output,
			/Downloading umiak 0\.1\.0 for darwin-arm64 \(0\.0 MB\)…/,
		);
		assert.equal(r.curlArgs.includes("--progress-bar"), tty, r.curlArgs);
		assert.equal(r.output.includes("100.0%"), tty, r.output);
		assert.match(r.output, /Add this directory to PATH:/);
		assert.match(r.output, /Pair the CLI/);
		assert.ok(r.output.indexOf("PATH:") < r.output.indexOf("Pair the CLI"));
	});

test("skip login installs verified bytes and prints manual pairing without starting it", async () => {
	const r = await runInstaller({ skipLogin: true });
	assert.equal(r.status, 0, r.output);
	assert.match(r.installed, /#!\/bin\/sh/);
	assert.equal(r.login, null);
	assert.ok(r.output.includes(`umiak login --api-url '${r.origin}'`), r.output);
});

test("interrupt exits 130, cleans temporary downloads and preserves existing installation", async () => {
	const r = await runInstaller({ interrupt: true });
	assert.equal(r.status, 130, r.output);
	assert.equal(r.installed, "old-binary");
	assert.equal(r.login, null);
	assert.deepEqual(r.downloads, []);
	const scratchFile = r.curlArgs.trim().split("\n").at(-1);
	const { access } = await import("node:fs/promises");
	await assert.rejects(access(join(scratchFile, "..")), { code: "ENOENT" });
});
