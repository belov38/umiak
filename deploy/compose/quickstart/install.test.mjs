import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scriptPath = new URL("./install.sh", import.meta.url);
async function runInstaller({
	arch = "arm64",
	os = "Darwin",
	badChecksum = false,
	ca = false,
} = {}) {
	const dir = await mkdtemp(join(tmpdir(), "umiak-install-test-"));
	const bin = join(dir, "bin");
	await mkdir(bin);
	const loginLog = join(dir, "login");
	const binary = `#!/bin/sh\nprintf '%s\\n' "$@" > '${loginLog}'\n`;
	const sum = createHash("sha256").update(binary).digest("hex");
	const downloads = [];
	const file = `umiak-${os === "Darwin" ? "darwin" : "linux"}-${arch === "aarch64" || arch === "arm64" ? "arm64" : "x64"}`;
	const caPath = join(dir, "test-ca.pem");
	if (ca) await writeFile(caPath, "test-ca");
	const server = createServer((req, res) => {
		downloads.push(req.url);
		if (req.url === "/downloads/SHA256SUMS")
			res.end(`${badChecksum ? "0".repeat(64) : sum}  ${file}\n`);
		else if (req.url === `/downloads/${file}`) res.end(binary);
		else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${server.address().port}`;
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
		caPath,
	);
	const child = spawn("/bin/sh", [], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			HOME: dir,
			UMIAK_INSTALL_DIR: target,
			...(ca ? { UMIAK_CA_CERT: caPath } : {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (x) => (output += x));
	child.stderr.on("data", (x) => (output += x));
	child.stdin.end(script);
	const status = await new Promise((r) => child.on("close", r));
	await new Promise((r) => server.close(r));
	return {
		status,
		output,
		downloads,
		installed: await readFile(join(target, "umiak"), "utf8"),
		login: await readFile(loginLog, "utf8").catch(() => null),
		origin,
		caPath,
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

test("passes chosen private CA to CLI login", async () => {
	const r = await runInstaller({ ca: true });
	assert.equal(r.status, 0, r.output);
	assert.equal(
		r.login,
		`login\n--api-url\n${r.origin}\n--cacert\n${r.caPath}\n`,
	);
});
for (const [os, arch, release] of [
	["Darwin", "x86_64", "darwin-x64"],
	["Linux", "x86_64", "linux-x64"],
	["Linux", "aarch64", "linux-arm64"],
])
	test(`installs ${release}`, async () => {
		const r = await runInstaller({ os, arch });
		assert.equal(r.status, 0, r.output);
		assert.ok(r.downloads.includes(`/downloads/umiak-${release}`));
	});
