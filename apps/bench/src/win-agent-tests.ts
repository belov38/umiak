import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	createReadStream,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Machines,
	type Qga,
	type Smbios,
	s2SerialPayload,
} from "@umiak/pve";
import { makeIso } from "../../template-builder/src/seed.ts";
import { type Ctx, RamGuard } from "./context.ts";
import { table } from "./report.ts";
import { deleteWithRetry, machinesFor } from "./s5.ts";
import { checkHostRules, waitAgentReady } from "./s9.ts";
import { abortable, withAbortSignals } from "./signals.ts";

// umiak-bench s9 agent-tests (spec S9 section 18.3): the Windows test binaries of the guest agent
// (services/guest-agent/test/windows/build-tests.sh) go into an ISO that is attached to a fresh
// clone of the Windows template; the binaries are copied to C:\umiak-tests and run there as SYSTEM
// (what qemu-ga exec runs as). An ISO instead of QGA file writes: the binaries are about 100 MB.

/** Guest directory of the binaries (next to them the tests may write files). */
export const REMOTE_DIR = "C:\\umiak-tests";
export const ISO_LABEL = "UMIAKTESTS";
/** Passed to every binary as -test.timeout; the exec timeout is two minutes longer. */
export const TEST_TIMEOUT = "10m";
const EXEC_TIMEOUT_MS = 12 * 60_000;
const BOOT_TIMEOUT_MS = 10 * 60_000;
const COPY_TIMEOUT_MS = 2 * 60_000;
const SIZE = { cores: 2, memoryMb: 4096 };
const MEDIA_STORAGE = "local";
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
/** Name pattern the umiak-node media.* operations accept. */
export const ISO_NAME_RE = /^umiak-build-[a-z0-9-]{1,64}\.iso$/;
const BIN_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.test\.exe$/;
/** Joliet (what Windows reads) keeps at most 64 characters of a name. */
const JOLIET_NAME_MAX = 64;

export interface AgentTestsOptions {
	template: number;
	/** Local directory with the *.test.exe files. */
	dir: string;
	/** Passed on as -test.run. */
	run?: string;
	keep: boolean;
	ramCapMb: number;
}

/** What the runner needs from Proxmox and the node; the real ones are in realIso(). */
export interface IsoOps {
	make(files: Map<string, Buffer>, path: string, label: string): void;
	/** Uploads the file as local:iso/<name>. */
	upload(name: string, path: string): Promise<void>;
	remove(name: string): Promise<void>;
	/** Attaches local:iso/<name> as ide2 cdrom of a stopped VM. */
	attach(vmid: number, name: string): Promise<void>;
}

export interface AgentTestsDeps {
	machines: Pick<Machines, "create" | "start" | "delete"> & {
		qga: Pick<Qga, "ping" | "exec">;
	};
	ram: Pick<RamGuard, "reserve" | "release">;
	iso: IsoOps;
	files?: {
		list(dir: string): string[];
		read(path: string): Buffer;
	};
	out?: (text: string) => void;
	log?: (text: string) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
	bootTimeoutMs?: number;
	/** Aborts the run; the clone and the ISO are still removed. */
	signal?: AbortSignal;
}

export interface BinaryResult {
	name: string;
	exitCode: number | null;
	ms: number;
	error?: string;
}

const realFiles = {
	list: (dir: string) => readdirSync(dir),
	read: (path: string) => readFileSync(path),
};

const powershell = (script: string): string[] => [
	"powershell",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	script,
];

/** yyyymmddhhmmss in UTC. */
export function stamp(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace(/\.\d+Z$/, "")
		.replace(/[-:T]/g, "");
}

/** Copies the ISO content to REMOTE_DIR and lists what arrived; retried while the CD is not there. */
const COPY_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`$v = Get-Volume -FileSystemLabel ${ISO_LABEL}`,
	`New-Item -ItemType Directory -Force -Path ${REMOTE_DIR} | Out-Null`,
	`Copy-Item -Path ($v.DriveLetter + ':\\*') -Destination ${REMOTE_DIR} -Force`,
	// Files from a CD are read-only.
	`Get-ChildItem -LiteralPath ${REMOTE_DIR} -File | ForEach-Object { $_.IsReadOnly = $false }`,
	`Get-ChildItem -LiteralPath ${REMOTE_DIR} -File -Name`,
].join("; ");

/**
 * Builds the ISO, creates a clone of the template with it, runs every `*.test.exe` in the clone
 * as SYSTEM. Returns 0 when all passed, else 1. The clone and the ISO are removed at the end
 * unless keep is set.
 */
export async function runAgentTests(
	deps: AgentTestsDeps,
	o: AgentTestsOptions,
): Promise<number> {
	const { machines, ram, iso } = deps;
	const files = deps.files ?? realFiles;
	const out = deps.out ?? ((s: string) => process.stdout.write(s));
	const log =
		deps.log ??
		((s: string) =>
			process.stderr.write(
				`[${new Date().toISOString().slice(11, 19)}] ${s}\n`,
			));
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? 2000;
	const { signal } = deps;

	const bins = files
		.list(o.dir)
		.filter((f) => f.endsWith(".test.exe"))
		.sort();
	if (bins.length === 0) throw new Error(`no *.test.exe files in ${o.dir}`);
	for (const b of bins) {
		if (!BIN_NAME_RE.test(b))
			throw new Error(`unsupported test binary name ${JSON.stringify(b)}`);
		if (b.length > JOLIET_NAME_MAX)
			throw new Error(
				`${b}: longer than ${JOLIET_NAME_MAX} characters (Joliet)`,
			);
	}
	const isoName = `umiak-build-agenttests-${stamp(now())}.iso`;
	if (!ISO_NAME_RE.test(isoName)) throw new Error(`bad ISO name ${isoName}`);

	const results: BinaryResult[] = [];
	const id = randomUUID();
	// Same identity as a bench machine; no tunnel family, the agent does not connect anywhere.
	const smbios: Smbios = {
		uuid: id,
		serial: s2SerialPayload(id, randomBytes(32)),
	};
	const tmp = mkdtempSync(join(tmpdir(), "umiak-agent-tests-"));
	const isoPath = join(tmp, isoName);
	let isoUploaded = false;
	let vmid: number | undefined;
	let reserved = false;
	let failure: unknown;
	try {
		const content = new Map<string, Buffer>();
		for (const b of bins) content.set(b, files.read(join(o.dir, b)));
		signal?.throwIfAborted();
		iso.make(content, isoPath, ISO_LABEL);
		log(`uploading ${MEDIA_STORAGE}:iso/${isoName}`);
		// Recorded first: a failed upload may still leave a file behind.
		isoUploaded = true;
		await iso.upload(isoName, isoPath);

		signal?.throwIfAborted();
		log("create a clone of the template");
		vmid = (await machines.create({ size: SIZE, smbios })).vmid;
		await iso.attach(vmid, isoName);
		signal?.throwIfAborted();
		await ram.reserve(vmid, SIZE.memoryMb);
		reserved = true;
		log(`VM ${vmid}: start`);
		await machines.start(vmid);
		await waitAgentReady({
			qga: machines.qga,
			vmid,
			want: { machineId: id },
			label: `VM ${vmid}`,
			now,
			sleep,
			pollMs,
			timeoutMs: deps.bootTimeoutMs ?? BOOT_TIMEOUT_MS,
			...(signal !== undefined ? { signal } : {}),
		});

		log(`VM ${vmid}: copy the binaries to ${REMOTE_DIR}`);
		const copyDeadline = now() + COPY_TIMEOUT_MS;
		let have: string[] = [];
		for (;;) {
			signal?.throwIfAborted();
			const r = await machines.qga
				.exec(vmid, powershell(COPY_SCRIPT))
				.catch((err: unknown) => ({
					exitCode: -1,
					stdout: "",
					stderr: String(err),
				}));
			if (r.exitCode === 0) {
				have = r.stdout.split(/\r?\n/).map((l) => l.trim());
				const lower = new Set(have.map((n) => n.toLowerCase()));
				const missing = bins.filter((b) => !lower.has(b.toLowerCase()));
				if (missing.length === 0) break;
				if (now() >= copyDeadline)
					throw new Error(`not copied to ${REMOTE_DIR}: ${missing.join(", ")}`);
			} else if (now() >= copyDeadline)
				throw new Error(
					`copy from the ${ISO_LABEL} CD failed: exit ${r.exitCode}: ${(r.stderr || r.stdout).trim()}`,
				);
			await sleep(pollMs);
		}

		for (const name of bins) {
			signal?.throwIfAborted();
			const t0 = now();
			const cmd = [
				`${REMOTE_DIR}\\${name}`,
				"-test.v",
				"-test.timeout",
				TEST_TIMEOUT,
				...(o.run !== undefined ? ["-test.run", o.run] : []),
			];
			log(`${name}: run`);
			try {
				// QGA returns the output when the process ends; it is printed right then.
				// Raced with the abort signal: a test may run for minutes.
				const r = await abortable(
					machines.qga.exec(vmid, cmd, { timeoutMs: EXEC_TIMEOUT_MS }),
					signal,
				);
				out(`=== ${name} (exit ${r.exitCode})\n${r.stdout}`);
				if (r.stderr.trim() !== "") out(`--- stderr\n${r.stderr}`);
				results.push({ name, exitCode: r.exitCode, ms: now() - t0 });
			} catch (err) {
				signal?.throwIfAborted();
				const error = err instanceof Error ? err.message : String(err);
				out(`=== ${name}: ${error}\n`);
				results.push({ name, exitCode: null, ms: now() - t0, error });
			}
		}
	} catch (err) {
		failure = err;
	}

	// Cleanup after success and failure alike; the failure of the run is reported first.
	const problems: string[] = [];
	const attempt = async (what: string, fn: () => Promise<unknown>) => {
		try {
			await fn();
		} catch (err) {
			problems.push(
				`${what}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};
	if (o.keep) {
		log(
			`kept VM ${vmid ?? "-"} and ${MEDIA_STORAGE}:iso/${isoName} for debugging`,
		);
	} else {
		if (vmid !== undefined) {
			const v = vmid;
			await attempt(`delete VM ${v}`, () => deleteWithRetry(machines, v));
		}
		if (isoUploaded)
			await attempt(`remove ${isoName}`, () => iso.remove(isoName));
	}
	if (reserved && vmid !== undefined) ram.release(vmid);
	rmSync(tmp, { recursive: true, force: true });
	for (const p of problems) log(`cleanup: ${p}`);
	if (failure !== undefined) throw failure;

	out(
		`\n${table(
			["binary", "result", "seconds"],
			results.map((r) => [
				r.name,
				r.exitCode === 0
					? "ok"
					: r.exitCode === null
						? "ERROR"
						: `FAIL (exit ${r.exitCode})`,
				(r.ms / 1000).toFixed(1),
			]),
		)}\n`,
	);
	if (problems.length > 0)
		throw new Error(`cleanup failed: ${problems.join("; ")}`);
	return results.every((r) => r.exitCode === 0) ? 0 : 1;
}

async function fileSha256(path: string): Promise<string> {
	const h = createHash("sha256");
	for await (const chunk of createReadStream(path)) h.update(chunk);
	return h.digest("hex");
}

/** Proxmox and umiak-node side of the ISO, the same calls as the template builder makes. */
export function realIso(ctx: Ctx): IsoOps {
	const { api, node, cfg } = ctx;
	return {
		// Same tool and Joliet/Rock Ridge options as the template builder's ISOs.
		make: (files, path, label) => makeIso(files, path, label),
		async upload(name, path) {
			const sha256 = await fileSha256(path);
			const upid = await api.upload<string>(
				`/nodes/${cfg.node}/storage/${MEDIA_STORAGE}/upload`,
				{ content: "iso", "checksum-algorithm": "sha256", checksum: sha256 },
				{ name, path, size: statSync(path).size },
			);
			await api.waitTask(cfg.node, upid, { timeoutMs: UPLOAD_TIMEOUT_MS });
		},
		async remove(name) {
			await node.call("media.remove", { names: [name] });
		},
		async attach(vmid, name) {
			await api.put(`/nodes/${cfg.node}/qemu/${vmid}/config`, {
				ide2: `${MEDIA_STORAGE}:iso/${name},media=cdrom`,
			});
		},
	};
}

export function runAgentTestsOn(
	ctx: Ctx,
	o: AgentTestsOptions,
): Promise<number> {
	checkHostRules(ctx.cfg, o.template);
	return withAbortSignals((signal) =>
		runAgentTests(
			{
				machines: machinesFor(ctx, o.template),
				ram: new RamGuard(ctx, o.ramCapMb),
				iso: realIso(ctx),
				signal,
			},
			o,
		),
	);
}
