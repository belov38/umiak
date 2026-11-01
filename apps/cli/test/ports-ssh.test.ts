// Ports and SSH through the real CLI (S7 §11.2, §11.3, §14.1, §14.2):
// port/ports/unport/port-token, ssh (an ephemeral key and certificate for
// the system ssh, which is a recording fake here), ssh-config (checked with
// the real `ssh -G`, which runs its `Match exec` without connecting),
// ssh-cert [--ensure] and ssh-keys.
import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { type CliWorld, startWorld, until } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

const MAIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"main.ts",
);

/** Principals and Key ID of a certificate, read by ssh-keygen -L. */
function certInfo(file: string): { principals: string[]; keyId: string } {
	const text = execFileSync("ssh-keygen", ["-L", "-f", file], {
		encoding: "utf8",
	});
	const keyId = text.match(/Key ID: "([^"]*)"/)?.[1] ?? "";
	const p = text.split("Principals:")[1]?.split("Critical Options:")[0] ?? "";
	return {
		principals: p
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
		keyId,
	};
}

describe("ports and ssh", () => {
	let w: CliWorld;
	let home: CliHome;
	let env: Record<string, string>;
	let sb: { id: string; slug: string };
	beforeAll(async () => {
		w = await startWorld({ oidc: { deviceInterval: 0 } });
		sb = await w.readySandbox();
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(() => {
		home = cliHome();
		env = { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: w.secret };
	});
	afterEach(() => home.rm());

	const umiak = (args: string[], o: { tty?: boolean } = {}) =>
		runCli(args, { env, ...o });

	it("port --token prints the URL with its token; ports, port-token and unport", async () => {
		const human = await umiak(["port", sb.slug, "3000", "--token"], {
			tty: true,
		});
		expect(human.code, human.stderr).toBe(0);
		expect(human.stdout.trim()).toMatch(
			new RegExp(
				`^https://${sb.slug}-3000\\.umiak\\.test/\\?_token=umiakp_\\S+$`,
			),
		);
		// A second PUT issues no token: the URL alone.
		const again = await umiak(["port", "3000"], { tty: true });
		expect(again.code, again.stderr).toBe(0);
		expect(again.stdout.trim()).toBe(`https://${sb.slug}-3000.umiak.test`);

		const pub = await umiak(["port", sb.id, "8080", "--public", "--json"]);
		expect(pub.code, pub.stderr).toBe(0);
		expect(pub.last()).toMatchObject({
			port: 8080,
			access: "public",
			url: `https://${sb.slug}-8080.umiak.test`,
		});
		expect(pub.last()).not.toHaveProperty("token");
		expect((await umiak(["port", sb.id, "1", "--public", "--sso"])).code).toBe(
			2,
		);
		expect((await umiak(["port", sb.id, "http"])).code).toBe(2);

		const ports = await umiak(["ports", sb.id]);
		expect(ports.code, ports.stderr).toBe(0);
		const hosted = (ports.last().hosted as { port: number }[]).map(
			(p) => p.port,
		);
		expect(hosted.sort()).toEqual([3000, 8080]);
		const table = await umiak(["ports", sb.id], { tty: true });
		expect(table.stdout).toContain("3000");
		expect(table.stdout).toContain(`https://${sb.slug}-8080.umiak.test`);

		const tok = await umiak(["port-token", sb.id, "3000"], { tty: true });
		expect(tok.code, tok.stderr).toBe(0);
		expect(tok.stdout.trim()).toMatch(/\?_token=umiakp_/);
		expect(tok.stdout.trim()).not.toBe(human.stdout.trim());

		const un = await umiak(["unport", sb.id, "3000"]);
		expect(un.code, un.stderr).toBe(0);
		const after = await umiak(["ports", sb.id]);
		expect(
			(after.last().hosted as { port: number }[]).map((p) => p.port),
		).toEqual([8080]);
	});

	it("ssh runs the system ssh with an ephemeral key, its certificate and the known_hosts cache, then removes them", async () => {
		const bin = join(home.dir, "bin");
		const rec = join(home.dir, "rec");
		mkdirSync(bin);
		mkdirSync(rec);
		writeFileSync(
			join(bin, "ssh"),
			[
				"#!/bin/sh",
				'printf "%s\\n" "$@" > "$REC/argv"',
				'prev=""',
				'for a in "$@"; do',
				'  if [ "$prev" = "-i" ]; then cp "$a" "$REC/key"; ls -ld "$(dirname "$a")" > "$REC/dir"; fi',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
				'  case "$a" in CertificateFile=*) cp "${a#CertificateFile=}" "$REC/cert" ;; esac',
				'  prev="$a"',
				"done",
				"exit 5",
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "ssh"), 0o755);
		const r = await runCli(["ssh", sb.slug, "--", "echo", "hi there"], {
			env: { ...env, PATH: `${bin}:${env.PATH}`, REC: rec },
		});
		expect(r.stderr).toBe("");
		expect(r.code).toBe(5);
		const argv = readFileSync(join(rec, "argv"), "utf8").split("\n");
		argv.pop();
		const key = argv[argv.indexOf("-i") + 1] as string;
		const knownHosts = join(home.configDir, "known_hosts");
		expect(argv).toEqual([
			"-i",
			key,
			"-o",
			`CertificateFile=${key}-cert.pub`,
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			`UserKnownHostsFile=${knownHosts}`,
			"-p",
			"2222",
			`${sb.slug}@ssh.umiak.test`,
			"echo",
			"hi there",
		]);
		expect(readFileSync(join(rec, "dir"), "utf8")).toMatch(/^drwx------/);
		expect(readFileSync(join(rec, "key"), "utf8")).toContain(
			"OPENSSH PRIVATE KEY",
		);
		const info = certInfo(join(rec, "cert"));
		expect(info.principals).toEqual([sb.id]);
		expect(info.keyId).toMatch(/^umiak:key:key_/);
		// The files are gone after ssh exits.
		expect(existsSync(key)).toBe(false);
		expect(existsSync(dirname(key))).toBe(false);
		// known_hosts names the non-standard port as [host]:port.
		expect(readFileSync(knownHosts, "utf8")).toBe(
			`[ssh.umiak.test]:2222 ${w.hostKeys[0]}\n`,
		);
	});

	it("ssh survives SIGTERM and SIGHUP: passes them to ssh and still removes the key", async () => {
		const bin = join(home.dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "ssh"),
			[
				"#!/bin/sh",
				'printf "%s\\n" "$@" > "$REC.tmp" && mv "$REC.tmp" "$REC"',
				"exec sleep 30",
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "ssh"), 0o755);
		for (const [sig, code] of [
			["SIGTERM", 143],
			["SIGHUP", 129],
		] as const) {
			const rec = join(home.dir, `argv-${sig}`);
			let child: ChildProcess | undefined;
			const run = runCli(["ssh", sb.id], {
				env: { ...env, PATH: `${bin}:${env.PATH}`, REC: rec },
				onSpawn: (c) => {
					child = c;
				},
			});
			await until(async () => (existsSync(rec) ? true : undefined));
			const argv = readFileSync(rec, "utf8").split("\n");
			const key = argv[argv.indexOf("-i") + 1] as string;
			expect(existsSync(key)).toBe(true);
			child?.kill(sig);
			const r = await run;
			expect(r.code, r.stderr).toBe(code);
			expect(existsSync(dirname(key))).toBe(false);
		}
	});

	it("ssh-cert writes a certificate; --ensure keeps a fresh one and renews one about to expire", async () => {
		const first = await umiak(["ssh-cert", sb.id, "--json"]);
		expect(first.code, first.stderr).toBe(0);
		const c = first.last() as {
			identityFile: string;
			certificateFile: string;
			principal: string;
			validBefore: string;
			renewed: boolean;
		};
		expect(c).toMatchObject({ principal: sb.id, renewed: true });
		expect(c.certificateFile).toBe(`${c.identityFile}-cert.pub`);
		expect(certInfo(c.certificateFile).principals).toEqual([sb.id]);
		expect(readFileSync(join(home.configDir, "known_hosts"), "utf8")).toContain(
			"[ssh.umiak.test]:2222 ssh-ed25519 ",
		);
		const cert1 = readFileSync(c.certificateFile, "utf8");
		// Concurrent first runs in a fresh home end with one key that matches
		// the certificate.
		const other = cliHome();
		try {
			const oenv = {
				...other.env,
				UMIAK_API_URL: w.url,
				UMIAK_API_KEY: w.secret,
			};
			const runs = await Promise.all(
				[1, 2, 3].map(() =>
					runCli(["ssh-cert", sb.id, "--json"], { env: oenv }),
				),
			);
			for (const x of runs) expect(x.code, x.stderr).toBe(0);
			const k = runs[0]?.last().identityFile as string;
			const keyFp = execFileSync("ssh-keygen", ["-l", "-f", k], {
				encoding: "utf8",
			}).split(" ")[1] as string;
			const certText = execFileSync(
				"ssh-keygen",
				["-L", "-f", `${k}-cert.pub`],
				{
					encoding: "utf8",
				},
			);
			expect(certText).toContain(keyFp);
		} finally {
			other.rm();
		}

		const ensure = await umiak(["ssh-cert", sb.slug, "--ensure", "--json"]);
		expect(ensure.code, ensure.stderr).toBe(0);
		expect(ensure.last()).toMatchObject({ renewed: false });
		expect(readFileSync(c.certificateFile, "utf8")).toBe(cert1);

		// Less than 2 minutes left: --ensure gets a new one.
		const meta = join(dirname(c.identityFile), "cert.json");
		const m = JSON.parse(readFileSync(meta, "utf8"));
		writeFileSync(
			meta,
			JSON.stringify({
				...m,
				validBefore: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const renew = await umiak(["ssh-cert", sb.id, "--ensure", "--json"]);
		expect(renew.last()).toMatchObject({ renewed: true });
		const cert2 = readFileSync(c.certificateFile, "utf8");
		expect(cert2).not.toBe(cert1);
		// The key stays; without --ensure the certificate is always new.
		const plain = await umiak(["ssh-cert", sb.id], { tty: true });
		expect(plain.code, plain.stderr).toBe(0);
		expect(plain.stdout.trim()).toBe(c.certificateFile);
		expect(readFileSync(c.certificateFile, "utf8")).not.toBe(cert2);
	});

	it("ssh-config prints a Host block whose Match exec gets the certificate (checked with ssh -G)", async () => {
		const r = await umiak(["ssh-config", sb.slug]);
		expect(r.code, r.stderr).toBe(0);
		const cfg = r.stdout;
		expect(cfg).toContain(`Host umiak-${sb.slug}\n`);
		expect(cfg).toContain(
			`Match originalhost umiak-${sb.slug} exec "umiak ssh-cert ${sb.id} --ensure"`,
		);
		const file = join(home.dir, "ssh_config");
		writeFileSync(file, cfg);
		// `umiak` on PATH is this CLI.
		const bin = join(home.dir, "bin");
		mkdirSync(bin);
		const bun = execFileSync(
			"sh",
			["-c", `command -v ${process.env.UMIAK_TEST_BUN ?? "bun"}`],
			{ encoding: "utf8" },
		).trim();
		writeFileSync(
			join(bin, "umiak"),
			`#!/bin/sh\nexec "${bun}" "${MAIN}" "$@"\n`,
		);
		chmodSync(join(bin, "umiak"), 0o755);
		// Async: the api runs in this process and must answer the Match exec.
		const { stdout: g } = await promisify(execFile)(
			"ssh",
			["-G", "-F", file, `umiak-${sb.slug}`],
			{
				encoding: "utf8",
				env: { ...env, PATH: `${bin}:${env.PATH}` },
				timeout: 20_000,
			},
		);
		const opt = (k: string) =>
			g
				.split("\n")
				.filter((l) => l.startsWith(`${k} `))
				.map((l) => l.slice(k.length + 1));
		expect(opt("hostname")).toEqual(["ssh.umiak.test"]);
		expect(opt("port")).toEqual(["2222"]);
		expect(opt("user")).toEqual([sb.slug]);
		const certFile = join(home.configDir, "ssh", sb.id, "id_ed25519-cert.pub");
		expect(opt("certificatefile")).toEqual([certFile]);
		expect(opt("userknownhostsfile")).toEqual([
			join(home.configDir, "known_hosts"),
		]);
		// The Match exec ran `umiak ssh-cert --ensure`: the certificate is there.
		expect(certInfo(certFile).principals).toEqual([sb.id]);
	});

	it("ssh-keys add (default ~/.ssh/id_ed25519.pub), list and rm need a person", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		w.oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		const login = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		expect(login.code, login.stderr).toBe(0);
		const penv = home.env;
		mkdirSync(join(home.dir, ".ssh"));
		execFileSync("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-C",
			"me@laptop",
			"-f",
			join(home.dir, ".ssh", "id_ed25519"),
		]);
		const add = await runCli(["ssh-keys", "add"], { env: penv });
		expect(add.code, add.stderr).toBe(0);
		const key = add.last() as { id: string; name: string; fingerprint: string };
		expect(key).toMatchObject({ name: "me@laptop", type: "ssh-ed25519" });
		const fp = execFileSync(
			"ssh-keygen",
			["-l", "-f", join(home.dir, ".ssh", "id_ed25519.pub")],
			{ encoding: "utf8" },
		).split(" ")[1];
		expect(key.fingerprint).toBe(fp);

		const other = join(home.dir, "other");
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
		const add2 = await runCli(
			["ssh-keys", "add", `${other}.pub`, "--name", "ci box"],
			{ env: penv },
		);
		expect(add2.code, add2.stderr).toBe(0);

		const list = await runCli(["ssh-keys", "list"], { env: penv });
		expect(list.code, list.stderr).toBe(0);
		expect(
			(list.last().data as { name: string }[]).map((k) => k.name).sort(),
		).toEqual(["ci box", "me@laptop"]);
		const table = await runCli(["ssh-keys", "list"], {
			env: penv,
			tty: true,
		});
		expect(table.stdout).toContain(fp);

		// Two keys named alike: rm by that name is refused.
		const third = join(home.dir, "third");
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", third]);
		const dup = await runCli(
			["ssh-keys", "add", `${third}.pub`, "--name", "ci box"],
			{ env: penv },
		);
		expect(dup.code, dup.stderr).toBe(0);
		const amb = await runCli(["ssh-keys", "rm", "ci box"], { env: penv });
		expect(amb.code).toBe(2);
		expect(amb.stderr).toContain("2 SSH keys");
		const dupFp = (dup.last() as { fingerprint: string }).fingerprint;
		expect((await runCli(["ssh-keys", "rm", dupFp], { env: penv })).code).toBe(
			0,
		);
		const rm = await runCli(["ssh-keys", "rm", key.id, "ci box"], {
			env: penv,
		});
		expect(rm.code, rm.stderr).toBe(0);
		const empty = await runCli(["ssh-keys", "list"], { env: penv });
		expect(empty.last().data).toEqual([]);
		expect((await runCli(["ssh-keys", "rm", "nope"], { env: penv })).code).toBe(
			3,
		);
		// A team key has no SSH keys of its own.
		const team = await umiak(["ssh-keys", "add", `${other}.pub`]);
		expect(team.code).toBe(4);
	});
});
