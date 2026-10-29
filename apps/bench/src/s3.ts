import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExecResult,
	type MachineInfo,
	type QuiesceHook,
	type Smbios,
	type SnapshotRef,
	s2SerialPayload,
} from "@sbx/pve";
import { type Ctx, RamGuard } from "./context.ts";
import { preflight } from "./preflight.ts";
import { redact } from "./report.ts";

/**
 * S3 stand (plan Task 20): the guest agent in real VMs cloned from the
 * template. Builds the dev-signed packages and the integration test binary
 * with test/linux/run.sh (BUILD_ONLY), pushes them through QGA, installs the
 * agent and runs checks A-G of the task brief. Every VM and snapshot made here
 * is deleted in a finally block, owner-checked.
 */
export interface S3Options {
	keep: boolean;
	outDir: string;
	/** Skip check B (the container suite inside the VM). */
	skipSuite: boolean;
}

type Status = "PASS" | "FAIL" | "SKIPPED";

interface CheckResult {
	status: Status;
	evidence: string[];
}

const CHECKS = ["A", "B", "C", "D", "E", "F", "G"] as const;
type CheckId = (typeof CHECKS)[number];

const SIZE = { cores: 2, memoryMb: 2048 };
const RAM_CAP_MB = 8192;
/**
 * Base64 characters per QGA exec call (a multiple of 4). Proxmox limits the
 * input-data parameter of agent/exec to 64 KiB ("data too large").
 */
const CHUNK = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const guestAgent = join(repo, "services/guest-agent");

const log = (s: string) =>
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");

/** Builds the bundle: /it (packages, test binary, stand-setup.sh) as tar.xz. */
function buildBundle(): { file: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sbx-s3-stand-"));
	log("build packages and the test binary (linux/amd64)");
	execFileSync(join(guestAgent, "test/linux/run.sh"), [], {
		env: { ...process.env, BUILD_ONLY: dir, GOARCH_IT: "amd64" },
		stdio: ["ignore", "ignore", "inherit"],
	});
	cpSync(
		join(guestAgent, "test/linux/stand-setup.sh"),
		join(dir, "it/stand-setup.sh"),
	);
	const file = join(dir, "it.tar.xz");
	execFileSync(
		"/bin/sh",
		["-c", `tar --no-xattrs -cf - -C "${dir}" it | xz -9 -T0 > "${file}"`],
		{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
	);
	return { file, dir };
}

interface FactsJson {
	machine_id: string;
	smbios_uuid: string;
	etc_machine_id: string;
	hostname: string;
	etc_hostname: string;
	host_keys_sha256: string;
	sandbox_id: string;
	boot_id: string;
	first_seq: number;
	first_type: string;
	first_machine_id: string;
	last_seq: number;
	commands: number;
	ready: boolean;
	ssh_active: string;
}

export async function runS3(ctx: Ctx, o: S3Options): Promise<number> {
	const { api, node, machines, cfg } = ctx;
	const qga = machines.qga;
	const results = Object.fromEntries(
		CHECKS.map((c) => [c, { status: "SKIPPED", evidence: [] }]),
	) as unknown as Record<CheckId, CheckResult>;
	const secrets: string[] = [];
	const created: { vmid: number; owner: string }[] = [];
	const snaps: SnapshotRef[] = [];
	const cleanupLog: string[] = [];
	const ram = new RamGuard(ctx, RAM_CAP_MB);
	const runId = randomBytes(4).toString("hex");
	const startedAt = new Date();
	const ev = (c: CheckId, s: string) => {
		results[c].evidence.push(redact(s, secrets));
		log(`${c}: ${redact(s, secrets)}`);
	};
	const verdict = (c: CheckId, ok: boolean) => {
		if (results[c].status !== "FAIL") results[c].status = ok ? "PASS" : "FAIL";
	};

	const newSmbios = (): Smbios => {
		const uuid = randomUUID();
		const serial = s2SerialPayload(uuid, randomBytes(32));
		secrets.push(serial, Buffer.from(serial).toString("base64"));
		return { uuid, serial };
	};

	/** VMIDs of all guests on the node (read-only inventory). */
	const allGuests = async () => {
		const g = await node.call<{
			guests: { qm: { vmid: number }[]; pct: { vmid: number }[] };
		}>("inventory", { sections: ["guests"] });
		return {
			qm: g.guests.qm.map((x) => x.vmid).sort((a, b) => a - b),
			pct: g.guests.pct.map((x) => x.vmid).sort((a, b) => a - b),
		};
	};

	const create = async (
		label: string,
		smbios: Smbios,
		from?: SnapshotRef,
	): Promise<MachineInfo> => {
		// Host rules: only VMIDs 500-598, never the template 599.
		if (
			cfg.vmidRange.min < 500 ||
			cfg.vmidRange.max > 598 ||
			cfg.templateVmid !== 599
		)
			throw new Error(
				`refusing to create: VMID range ${cfg.vmidRange.min}-${cfg.vmidRange.max}, template ${cfg.templateVmid}`,
			);
		if (created.length >= 2)
			throw new Error("refusing to create a third VM (host rule: at most 2)");
		const owner = `s3-stand-${runId}-${label}`;
		const m = from
			? await machines.fork(from, { size: SIZE, smbios, ownerId: owner })
			: await machines.create({ size: SIZE, smbios, ownerId: owner });
		created.push({ vmid: m.vmid, owner });
		if (m.vmid < 500 || m.vmid > 598)
			throw new Error(`allocator returned VMID ${m.vmid} outside 500-598`);
		log(`${label}: VM ${m.vmid} (owner ${owner})`);
		return m;
	};

	const start = async (vmid: number) => {
		const owner = created.find((c) => c.vmid === vmid)?.owner;
		if (!owner) throw new Error(`VM ${vmid} is not ours`);
		await ram.reserve(vmid, SIZE.memoryMb);
		const t0 = Date.now();
		await machines.start(vmid, { expectedOwner: owner });
		const r = await machines.waitReady(vmid, { startedAt: t0 });
		log(
			`VM ${vmid} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.ip}`,
		);
		return r;
	};

	/** Runs a command in the guest; a non-zero exit throws. */
	const guest = async (
		vmid: number,
		command: string[],
		opts: { timeoutMs?: number; input?: string; allowFail?: boolean } = {},
	): Promise<ExecResult> => {
		const r = await qga.exec(vmid, command, opts);
		if (r.exitCode !== 0 && !opts.allowFail)
			throw new Error(
				`guest ${command.slice(0, 3).join(" ")}: exit ${r.exitCode}\n${redact(r.stdout.slice(-4000), secrets)}\n${redact(r.stderr.slice(-4000), secrets)}`,
			);
		return r;
	};
	const bash = (
		vmid: number,
		script: string,
		opts: { timeoutMs?: number; input?: string; allowFail?: boolean } = {},
	) => guest(vmid, ["bash", "-c", script], opts);

	/** Runs one test of the integration binary in the guest. */
	const standTest = (
		vmid: number,
		name: string,
		opts: {
			env?: Record<string, string>;
			input?: string;
			timeoutMs?: number;
		} = {},
	) =>
		qga.exec(
			vmid,
			[
				"/usr/bin/env",
				"SBX_STAND=1",
				...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
				"/it/integration.test",
				"-test.run",
				`^${name}$`,
				"-test.v",
				"-test.count=1",
				"-test.timeout=10m",
			],
			{
				timeoutMs: opts.timeoutMs ?? 11 * 60_000,
				...(opts.input !== undefined ? { input: opts.input } : {}),
			},
		);
	const testOk = (r: ExecResult, name: string) =>
		r.exitCode === 0 && r.stdout.includes(`--- PASS: ${name} `);
	const testTail = (r: ExecResult) =>
		redact(
			`${r.stdout}\n${r.stderr}`
				.split("\n")
				.filter((l) => l.trim() !== "")
				.slice(-25)
				.join("\n"),
			secrets,
		);

	const facts = async (vmid: number): Promise<FactsJson> => {
		const r = await standTest(vmid, "TestStandFacts");
		const line = r.stdout.split("\n").find((l) => l.startsWith("STAND-FACTS "));
		if (!testOk(r, "TestStandFacts") || !line)
			throw new Error(`TestStandFacts failed:\n${testTail(r)}`);
		return JSON.parse(line.slice("STAND-FACTS ".length)) as FactsJson;
	};

	const push = async (vmid: number, file: string, remote: string) => {
		const data = readFileSync(file);
		const b64 = data.toString("base64");
		await bash(vmid, `mkdir -p "$(dirname ${remote})" && : > ${remote}.b64`);
		const t0 = Date.now();
		for (let off = 0; off < b64.length; off += CHUNK)
			await guest(vmid, ["/bin/sh", "-c", `cat >> ${remote}.b64`], {
				input: b64.slice(off, off + CHUNK),
				timeoutMs: 120_000,
			});
		const r = await bash(
			vmid,
			`base64 -d ${remote}.b64 > ${remote} && rm -f ${remote}.b64 && sha256sum ${remote}`,
			{ timeoutMs: 120_000 },
		);
		if (!r.stdout.startsWith(sha256(data)))
			throw new Error(`push ${remote}: checksum mismatch`);
		log(
			`pushed ${(data.length / 1048576).toFixed(1)} MiB in ${Math.ceil(b64.length / CHUNK)} calls, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
		);
	};

	const bootId = async (vmid: number) =>
		(
			await guest(vmid, ["cat", "/proc/sys/kernel/random/boot_id"])
		).stdout.trim();

	const doctor = async (vmid: number) =>
		JSON.parse(
			(await guest(vmid, ["/usr/local/bin/sbx-agent", "doctor", "--json"]))
				.stdout,
		) as {
			units: Record<string, string>;
			identity?: { machine_id: string; written_machine_id: string };
			tunnel_url: { url: string; source: string };
			identity_dir: string;
			test_aids?: string[];
			versions: { current: string };
			readiness?: unknown;
		};

	// Greps the whole root disk (raw block device) for each pattern. Patterns
	// come on stdin (QGA logs exec arguments in the guest journal) into a
	// tmpfs file; only sha256 hashes of matches leave the guest.
	const rawGrep = async (vmid: number, patterns: string[]) => {
		const r = await bash(
			vmid,
			`set -o pipefail
disk=/dev/$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
echo "disk $disk $(blockdev --getsize64 "$disk")" >&2
p=$(mktemp -p /dev/shm)
trap 'rm -f "$p"' EXIT
cat >"$p"
# NUL -> newline: grep holds a whole line in memory, and long zero runs of
# a raw disk would be one huge line (grep alone was OOM-killed).
tr '\\0' '\\n' <"$disk" | LC_ALL=C grep -a -o -F -f "$p" | while IFS= read -r m; do printf %s "$m" | sha256sum | cut -c1-64; done | sort | uniq -c
st=("\${PIPESTATUS[@]}")
[ "\${st[0]}" = 0 ] && [ "\${st[1]}" -le 1 ]`,
			{ input: `${patterns.join("\n")}\n`, timeoutMs: 15 * 60_000 },
		);
		const counts = new Map<string, number>();
		for (const line of r.stdout.split("\n")) {
			const m = /^\s*(\d+)\s+([0-9a-f]{64})$/.exec(line);
			if (m) counts.set(m[2] ?? "", Number(m[1]));
		}
		return {
			disk: r.stderr.trim(),
			count: (p: string) => counts.get(sha256(p)) ?? 0,
		};
	};

	// 0. Preflight and the inventory before.
	const pf = await preflight(ctx);
	const pfFailed = pf.checks.filter((c) => !c.ok);
	if (pfFailed.length > 0) {
		for (const c of pfFailed)
			log(`preflight FAILED: ${c.name} ${c.detail ?? ""}`);
		return 1;
	}
	const guestsBefore = await allGuests();
	log(
		`guests before: qm ${guestsBefore.qm.join(",")} pct ${guestsBefore.pct.join(",")}`,
	);
	const version = await api.get<{ version: string }>("/version");

	const bundle = buildBundle();
	const bundleSha = sha256(readFileSync(bundle.file));
	let suiteLog = "";
	let exitCode = 0;
	try {
		// --- A: install, agent active without a tunnel.
		const smA = newSmbios();
		const a = await create("src", smA);
		const ra = await start(a.vmid);
		const os = await bash(
			a.vmid,
			`. /etc/os-release; echo "$PRETTY_NAME"; uname -r; systemctl --version | head -1; id -nu 1000 2>/dev/null || echo none; swapon --show --noheadings | wc -l; command -v docker || echo nodocker; cat /proc/sys/kernel/random/boot_id >/dev/null`,
		);
		ev("A", `guest: ${os.stdout.trim().split("\n").join(" | ")}`);
		await push(a.vmid, bundle.file, "/root/stand/it.tar.xz");
		await bash(
			a.vmid,
			"tar -xJf /root/stand/it.tar.xz -C / && rm -f /root/stand/it.tar.xz",
			{
				timeoutMs: 120_000,
			},
		);
		const inst = await guest(
			a.vmid,
			["bash", "/it/stand-setup.sh", "install"],
			{
				timeoutMs: 300_000,
				allowFail: true,
			},
		);
		if (inst.exitCode !== 0) {
			ev("A", `install failed: ${redact(inst.stderr.slice(-3000), secrets)}`);
			verdict("A", false);
			throw new Error("install failed");
		}
		const active = (
			await guest(
				a.vmid,
				["systemctl", "is-active", "sbx-agent", "sbx-identity"],
				{
					allowFail: true,
				},
			)
		).stdout
			.trim()
			.split("\n");
		const d = await doctor(a.vmid);
		ev("A", `systemctl is-active sbx-agent sbx-identity: ${active.join(",")}`);
		ev(
			"A",
			`doctor: version ${d.versions.current}, units ${JSON.stringify(d.units)}, identity.machine_id ${d.identity?.machine_id} (smbios uuid ${smA.uuid}), tunnel_url ${d.tunnel_url.url} source ${d.tunnel_url.source}, identity_dir ${d.identity_dir}, test_aids ${JSON.stringify(d.test_aids ?? [])}`,
		);
		verdict(
			"A",
			active.every((s) => s === "active") &&
				d.identity?.machine_id === smA.uuid &&
				d.tunnel_url.source === "config" &&
				d.identity_dir === "/sys/class/dmi/id",
		);

		// --- B: the container suite inside the VM (fake smbios on tmpfs).
		if (o.skipSuite) {
			ev("B", "skipped by --skip-suite");
		} else {
			await guest(a.vmid, ["bash", "/it/stand-setup.sh", "it-mode"], {
				timeoutMs: 180_000,
			});
			log("B: running the integration suite in the VM (several minutes)");
			const t0 = Date.now();
			const r = await qga.exec(
				a.vmid,
				[
					"/it/integration.test",
					"-test.v",
					"-test.count=1",
					"-test.timeout=30m",
					"-test.skip",
					"TestFreezeLoopExt4",
				],
				{ timeoutMs: 35 * 60_000 },
			);
			suiteLog = redact(`${r.stdout}\n--- stderr ---\n${r.stderr}`, secrets);
			const tops = [
				...suiteLog.matchAll(
					/^--- (PASS|FAIL|SKIP): (Test\w+) \(([\d.]+)s\)/gm,
				),
			];
			for (const m of tops) ev("B", `${m[2]}: ${m[1]} (${m[3]} s)`);
			for (const line of suiteLog.split("\n"))
				if (/idle agent VmRSS|shim VmRSS/.test(line))
					ev("G", `TestMemory (suite): ${line.trim()}`);
			ev(
				"B",
				`exit ${r.exitCode} after ${((Date.now() - t0) / 1000).toFixed(0)} s; skipped by flag: TestFreezeLoopExt4 (asserts the loop fs is the only freezable mount; real / freeze is check D)`,
			);
			verdict(
				"B",
				r.exitCode === 0 &&
					tops.length > 0 &&
					tops.every((m) => m[1] !== "FAIL"),
			);
			const back = await guest(
				a.vmid,
				["bash", "/it/stand-setup.sh", "real-mode"],
				{
					timeoutMs: 180_000,
					allowFail: true,
				},
			);
			const d2 = await doctor(a.vmid);
			ev(
				"A",
				`after B, back to the real smbios: setup exit ${back.exitCode}, doctor machine_id ${d2.identity?.machine_id}, identity_dir ${d2.identity_dir}`,
			);
			if (back.exitCode !== 0 || d2.identity?.machine_id !== smA.uuid) {
				verdict("A", false);
				throw new Error("could not return to the real smbios identity");
			}
		}

		// --- C: reboot.
		{
			const r1 = await standTest(a.vmid, "TestStandRebootBefore");
			ev(
				"C",
				`before: ${testOk(r1, "TestStandRebootBefore") ? "ok" : "FAILED"}\n${testTail(r1)}`,
			);
			if (!testOk(r1, "TestStandRebootBefore")) verdict("C", false);
			else {
				const before = await bootId(a.vmid);
				await api
					.post(`/nodes/${cfg.node}/qemu/${a.vmid}/agent/exec`, {
						command: ["systemctl", "reboot"],
					})
					.catch(() => {});
				const t0 = Date.now();
				let after = before;
				while (after === before) {
					if (Date.now() - t0 > 300_000)
						throw new Error("VM did not reboot in 5 min");
					await sleep(2000);
					after = await bootId(a.vmid).catch(() => before);
				}
				ev(
					"C",
					`guest reboot (systemctl reboot via QGA): boot_id changed after ${((Date.now() - t0) / 1000).toFixed(0)} s`,
				);
				const r2 = await standTest(a.vmid, "TestStandRebootAfter");
				ev(
					"C",
					`after: ${testOk(r2, "TestStandRebootAfter") ? "ok" : "FAILED"}\n${testTail(r2)}`,
				);
				verdict("C", testOk(r2, "TestStandRebootAfter"));
			}
		}

		// --- F (planting) before D: the snapshot of D then holds the secrets' state.
		const fSecrets = [0, 1, 2].map(
			(i) =>
				`sbx-stand-${["env", "file", "cmd"][i]}-${randomBytes(12).toString("hex")}`,
		);
		secrets.push(...fSecrets);
		const control = `sbx-stand-control-${randomBytes(12).toString("hex")}`;
		{
			const r = await standTest(a.vmid, "TestStandSecretsPlant", {
				input: `${fSecrets.join("\n")}\n`,
			});
			ev(
				"F",
				`plant (secret_env, secret_files, command env of a finished and a running command; sync): ${testOk(r, "TestStandSecretsPlant") ? "ok" : "FAILED"}`,
			);
			if (!testOk(r, "TestStandSecretsPlant")) {
				ev("F", testTail(r));
				verdict("F", false);
			}
			// Positive control: a non-secret marker written to a file must be found.
			await bash(
				a.vmid,
				`printf '%s\\n' "$(cat)" > /var/tmp/stand-control && sync`,
				{
					input: control,
				},
			);
		}

		// --- D: Quiesce + S1 snapshot + Thaw; then auto-thaw without Thaw.
		let snap: SnapshotRef | undefined;
		{
			// Docker is in the template: a container (an offline image of
			// /bin/sleep and its libraries) to see the pause.
			let container = "";
			const dk = await bash(
				a.vmid,
				`set -e
command -v docker >/dev/null || exit 3
systemctl start docker.service
r=$(mktemp -d)
for f in /bin/sleep $(ldd /bin/sleep | grep -o '/[^ ]*'); do mkdir -p "$r$(dirname "$f")"; cp -L "$f" "$r$f"; done
tar -C "$r" -c . | docker import - sbx-stand/sleep:1 >/dev/null
rm -rf "$r"
docker run -d --name sbx-stand-sleep sbx-stand/sleep:1 /bin/sleep 3600`,
				{ timeoutMs: 120_000, allowFail: true },
			);
			if (dk.exitCode === 0) container = dk.stdout.trim();
			ev(
				"D",
				container
					? `docker container ${container.slice(0, 12)} running (agent docker enabled: ${(await guest(a.vmid, ["grep", "-A1", "^\\[docker\\]", "/etc/sbx-agent/agent.toml"], { allowFail: true })).stdout.replace(/\s+/g, " ").trim()})`
					: `no docker container (exit ${dk.exitCode}): ${dk.stderr.trim().slice(-300)}`,
			);
			let testRun: Promise<ExecResult> | undefined;
			const waitMark = async (name: string, ms: number) => {
				const t0 = Date.now();
				while (
					(
						await guest(a.vmid, ["test", "-e", `/run/sbx-stand/${name}`], {
							allowFail: true,
						})
					).exitCode !== 0
				) {
					if (Date.now() - t0 > ms)
						throw new Error(`marker ${name} not seen in ${ms} ms`);
					await sleep(100);
				}
			};
			let tFrozen = 0;
			let tSnapDone = 0;
			const hook: QuiesceHook = {
				freeze: async () => {
					const t0 = Date.now();
					testRun = standTest(a.vmid, "TestStandQuiesce", {
						env: { STAND_QUIESCE: "snapshot", STAND_CONTAINER: container },
					});
					testRun.catch(() => {});
					await waitMark("frozen", 20_000);
					tFrozen = Date.now() - t0;
				},
				thaw: async () => {
					tSnapDone = Date.now();
					await guest(a.vmid, ["touch", "/run/sbx-stand/snapshotted"]);
					await waitMark("thawed", 20_000);
				},
			};
			const t0 = Date.now();
			try {
				snap = await machines.snapshot(a.vmid, { hook, id: `s3${runId}` });
				snaps.push(snap);
			} catch (err) {
				ev("D", `S1 snapshot failed: ${(err as Error).message}`);
				verdict("D", false);
			}
			const r = testRun ? await testRun : undefined;
			if (snap)
				ev(
					"D",
					`S1 snapshot ${snap.id} of VM ${a.vmid} (${snap.disks.map((x) => x.lv).join(",")}) in ${Date.now() - t0} ms; freeze→thaw ${snap.freezeMs} ms (Quiesce incl. test start ${tFrozen} ms, thaw requested ${tSnapDone ? Date.now() - tSnapDone : "-"} ms before the end)`,
				);
			if (r)
				ev(
					"D",
					`quiesce+snapshot+thaw test: ${testOk(r, "TestStandQuiesce") ? "ok" : "FAILED"}\n${testTail(r)}`,
				);
			verdict("D", !!snap && !!r && testOk(r, "TestStandQuiesce"));
			if (container) {
				const st = (
					await guest(
						a.vmid,
						[
							"docker",
							"inspect",
							"-f",
							"{{.State.Status}} paused={{.State.Paused}}",
							container,
						],
						{ allowFail: true },
					)
				).stdout.trim();
				ev("D", `container after Thaw: ${st}`);
				verdict("D", st === "running paused=false");
			}

			const r2 = await standTest(a.vmid, "TestStandQuiesce", {
				env: { STAND_QUIESCE: "autothaw" },
			});
			ev(
				"D",
				`auto-thaw run (lease 10 s, no Thaw): ${testOk(r2, "TestStandQuiesce") ? "ok" : "FAILED"}\n${testTail(r2)}`,
			);
			verdict("D", testOk(r2, "TestStandQuiesce"));
			if (container) {
				const st = (
					await guest(
						a.vmid,
						[
							"docker",
							"inspect",
							"-f",
							"{{.State.Status}} paused={{.State.Paused}}",
							container,
						],
						{ allowFail: true },
					)
				).stdout.trim();
				ev("D", `container after the auto-thaw: ${st}`);
				verdict("D", st === "running paused=false");
			}
		}

		// --- F: grep the source disk.
		{
			const g = await rawGrep(a.vmid, [...fSecrets, control]);
			const counts = fSecrets.map((s) => g.count(s));
			ev(
				"F",
				`source VM ${a.vmid} raw ${g.disk}: secret matches env/file/cmd = ${counts.join("/")}, control marker matches ${g.count(control)}`,
			);
			verdict("F", counts.every((c) => c === 0) && g.count(control) > 0);
		}

		// --- E: fork the snapshot with a new smbios.
		if (!snap) {
			ev("E", "no snapshot from D");
		} else {
			const srcBefore = await facts(a.vmid);
			const smF = newSmbios();
			const f = await create("fork", smF, snap);
			const rf = await start(f.vmid);
			const ff = await facts(f.vmid);
			const srcAfter = await facts(a.vmid);
			const hex = smF.uuid.replaceAll("-", "");
			const fsck = await bash(
				f.vmid,
				`dmesg | grep -iE 'ext4|recover' | sed 's/^\\[[^]]*\\] //' | head -20`,
				{ allowFail: true },
			);
			const cloudInit = await bash(
				f.vmid,
				`cloud-init status 2>/dev/null | head -1; journalctl -b -u sbx-identity --no-pager -o cat | tail -5`,
				{ allowFail: true },
			);
			ev("E", `fork VM ${f.vmid} ip ${rf.ip} (source ${ra.ip})`);
			ev("E", `fork facts: ${JSON.stringify(ff)}`);
			ev("E", `source facts before fork: ${JSON.stringify(srcBefore)}`);
			ev("E", `source facts after fork:  ${JSON.stringify(srcAfter)}`);
			ev(
				"E",
				`fork kernel ext4 lines: ${fsck.stdout.trim().split("\n").join(" | ")}`,
			);
			ev(
				"E",
				`fork cloud-init / sbx-identity: ${cloudInit.stdout.trim().split("\n").join(" | ")}`,
			);
			const conds: [string, boolean][] = [
				[
					"machine id = new smbios uuid",
					ff.machine_id === smF.uuid && ff.smbios_uuid === smF.uuid,
				],
				[
					"/etc/machine-id = new id hex, changed",
					ff.etc_machine_id === hex &&
						ff.etc_machine_id !== srcBefore.etc_machine_id,
				],
				[
					"host keys changed",
					ff.host_keys_sha256 !== srcBefore.host_keys_sha256,
				],
				[
					"hostname sbx-<last12hex>",
					ff.hostname === `sbx-${hex.slice(-12)}` &&
						ff.etc_hostname === ff.hostname,
				],
				[
					"agent state empty (no claim, no commands)",
					ff.sandbox_id === "" && ff.commands === 0,
				],
				[
					"first event identity.reset seq 1 with the new id",
					ff.first_seq === 1 &&
						ff.first_type === "identity.reset" &&
						ff.first_machine_id === smF.uuid,
				],
				["ssh active", ff.ssh_active === "active"],
				["new IP", rf.ip !== ra.ip],
				[
					"source unaffected",
					srcAfter.machine_id === srcBefore.machine_id &&
						srcAfter.etc_machine_id === srcBefore.etc_machine_id &&
						srcAfter.hostname === srcBefore.hostname &&
						srcAfter.host_keys_sha256 === srcBefore.host_keys_sha256 &&
						srcAfter.sandbox_id === srcBefore.sandbox_id &&
						srcAfter.boot_id === srcBefore.boot_id &&
						srcAfter.first_seq === srcBefore.first_seq &&
						srcAfter.commands === srcBefore.commands,
				],
			];
			for (const [n, ok] of conds) ev("E", `${ok ? "ok  " : "FAIL"} ${n}`);
			verdict(
				"E",
				conds.every(([, ok]) => ok),
			);

			// F, second read: the fork's disk is the snapshot LV plus the fork's own writes.
			const g = await rawGrep(f.vmid, [...fSecrets, control]);
			const counts = fSecrets.map((s) => g.count(s));
			ev(
				"F",
				`fork VM ${f.vmid} (thin clone of snapshot ${snap.id}) raw ${g.disk}: secret matches = ${counts.join("/")}, control marker matches ${g.count(control)}`,
			);
			verdict("F", counts.every((c) => c === 0) && g.count(control) > 0);
		}

		// --- G: memory, idle.
		{
			const r = await standTest(a.vmid, "TestStandMemory");
			const line = r.stdout.split("\n").find((l) => l.startsWith("STAND-MEM "));
			if (line) {
				const m = JSON.parse(line.slice("STAND-MEM ".length)) as Record<
					string,
					Record<string, number>
				>;
				const mib = (v: number | undefined) => ((v ?? 0) / 1048576).toFixed(1);
				for (const [who, x] of Object.entries(m))
					ev(
						"G",
						`${who}: VmRSS ${mib(x.vm_rss)} MiB, RssAnon ${mib(x.rss_anon)} MiB, RssFile ${mib(x.rss_file)} MiB, private (smaps Private_*) ${mib(x.private)} MiB, Pss ${mib(x.pss)} MiB`,
					);
			}
			verdict("G", testOk(r, "TestStandMemory"));
			if (!testOk(r, "TestStandMemory")) ev("G", testTail(r));
		}
	} catch (err) {
		exitCode = 1;
		log(`aborted: ${redact((err as Error).stack ?? String(err), secrets)}`);
		cleanupLog.push(`aborted: ${redact((err as Error).message, secrets)}`);
	} finally {
		if (o.keep) {
			log(
				`--keep: left VMs ${created.map((c) => c.vmid).join(",")}, snapshots ${snaps.map((s) => s.id).join(",")}`,
			);
			cleanupLog.push("kept (--keep)");
		} else {
			// Fork first (it is a thin clone of the snapshot), then the snapshot, then the source.
			for (const c of [...created]
				.reverse()
				.filter((x) => x.owner.endsWith("-fork"))) {
				try {
					await machines.delete(c.vmid, { expectedOwner: c.owner });
					cleanupLog.push(`deleted VM ${c.vmid} (${c.owner})`);
				} catch (err) {
					cleanupLog.push(`VM ${c.vmid}: ${(err as Error).message}`);
				} finally {
					ram.release(c.vmid);
				}
			}
			for (const s of snaps) {
				try {
					await machines.deleteSnapshot(s);
					cleanupLog.push(
						`deleted snapshot ${s.id} (${s.disks.map((x) => x.lv).join(",")})`,
					);
				} catch (err) {
					cleanupLog.push(`snapshot ${s.id}: ${(err as Error).message}`);
				}
			}
			for (const c of created.filter((x) => !x.owner.endsWith("-fork"))) {
				try {
					await machines.delete(c.vmid, { expectedOwner: c.owner });
					cleanupLog.push(`deleted VM ${c.vmid} (${c.owner})`);
				} catch (err) {
					cleanupLog.push(`VM ${c.vmid}: ${(err as Error).message}`);
				} finally {
					ram.release(c.vmid);
				}
			}
		}
		rmSync(bundle.dir, { recursive: true, force: true });
	}

	// Verify nothing of ours is left and the rest of the host is as before.
	const guestsAfter = await allGuests();
	const pool = await api.get<{ vmid: number; pool?: string }[]>(
		"/cluster/resources",
		{
			type: "vm",
		},
	);
	const ourLeft = created.filter(
		(c) =>
			guestsAfter.qm.includes(c.vmid) || pool.some((p) => p.vmid === c.vmid),
	);
	const { lvs } = await node.call<{ lvs: { name: string; tags: string[] }[] }>(
		"lv.list",
		{
			tags: ["sbx"],
		},
	);
	const lvLeft = lvs.filter(
		(l) =>
			!l.tags.includes("sbx-tpl") &&
			(created.some((c) => l.name.startsWith(`vm-${c.vmid}-`)) ||
				snaps.some((s) => l.name.startsWith(`sbx-snap-${s.id}-`))),
	);
	const rows = ctx.store
		.list(cfg.clusterId)
		.filter((r) =>
			created.some((c) => c.vmid === r.vmid && r.purpose !== "template"),
		);
	cleanupLog.push(
		`guests before: qm ${guestsBefore.qm.join(",")} pct ${guestsBefore.pct.join(",")}`,
	);
	cleanupLog.push(
		`guests after:  qm ${guestsAfter.qm.join(",")} pct ${guestsAfter.pct.join(",")}`,
	);
	cleanupLog.push(
		`our VMs left: ${ourLeft.map((c) => c.vmid).join(",") || "none"}; our LVs left: ${lvLeft.map((l) => l.name).join(",") || "none"}; our allocator rows left: ${rows.map((r) => r.vmid).join(",") || "none"}`,
	);
	if (!o.keep && (ourLeft.length || lvLeft.length || rows.length)) exitCode = 1;
	if (
		!o.keep &&
		(guestsBefore.qm.join(",") !== guestsAfter.qm.join(",") ||
			guestsBefore.pct.join(",") !== guestsAfter.pct.join(","))
	)
		cleanupLog.push("WARNING: the guest list differs from before (see above)");

	const out = redact(
		{
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			pve: version.version,
			bundleSha256: bundleSha,
			created: created.map((c) => c.vmid),
			snapshots: snaps.map((s) => s.id),
			results,
			cleanup: cleanupLog,
		},
		secrets,
	);
	mkdirSync(o.outDir, { recursive: true });
	const stamp = startedAt.toISOString().replaceAll(":", "-").replace(".", "-");
	const jsonPath = join(o.outDir, `s3-${stamp}.json`);
	writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
	if (suiteLog)
		writeFileSync(join(o.outDir, `s3-${stamp}-suite.log`), suiteLog);
	for (const c of CHECKS) process.stdout.write(`${c}: ${results[c].status}\n`);
	for (const l of cleanupLog) process.stdout.write(`cleanup: ${l}\n`);
	process.stdout.write(`results: ${jsonPath}\n`);
	return exitCode !== 0 || CHECKS.some((c) => results[c].status === "FAIL")
		? 1
		: 0;
}
