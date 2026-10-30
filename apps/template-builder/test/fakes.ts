import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExecResult, PveApiError, type UploadFile } from "@sbx/pve";
import { FakePve } from "@sbx/pve/testing";
import { FAIL_STEP_SCRIPT } from "../src/build.ts";
import type { GuestIo } from "../src/runner.ts";

// Fakes for the build: Proxmox with storage content, upload, resize and template; a guest that
// runs build steps as far as the runner can see.

type P = Record<string, unknown> | undefined;

export interface StorageFile {
	volid: string;
	content: "iso" | "import";
	size: number;
}

/** Result of a QGA exec in BuildPve.agentExec; "running" never exits. */
export type AgentExecResult =
	| { exitcode: number; out?: string; err?: string }
	| "running";

const FIRMWARE_ORDER = ["efidisk0", "scsi0", "tpmstate0"];

/** FakePve plus what a template build needs. */
export class BuildPve extends FakePve {
	storage: StorageFile[] = [];
	/** GET /nodes/<node>/capabilities/qemu/machines. */
	machineTypes: { id: string; type: string; version?: string }[] = [
		{ id: "pc-i440fx-11.0+pve2", type: "i440fx", version: "11.0+pve2" },
		{ id: "pc-q35-9.2+pve1", type: "q35", version: "9.2+pve1" },
		{ id: "pc-q35-11.0", type: "q35", version: "11.0" },
		{ id: "pc-q35-11.0+pve2", type: "q35", version: "11.0+pve2" },
		{ id: "pc-q35-10.2+pve3", type: "q35", version: "10.2+pve3" },
		{ id: "pc-q35-11.0+pve1", type: "q35", version: "11.0+pve1" },
	];
	/**
	 * When set, answers agent/exec and agent/exec-status of running VMs (Qga.exec); the result
	 * of a "running" exec can be replaced later through `execResults`.
	 */
	agentExec?: (
		vmid: number,
		command: string[],
		input: string | undefined,
	) => AgentExecResult;
	execResults = new Map<number, AgentExecResult>();
	#pid = 100;
	uploads: {
		path: string;
		fields: Record<string, string>;
		file: UploadFile;
	}[] = [];
	/** Runs before every request; may throw to fail it. */
	before?: (method: string, path: string, params: P) => void;
	#upid = 1000;

	#record(method: string, path: string, params: P): void {
		this.calls.push({ method, path, params });
		this.log.push(`api:${method} ${path}`);
		const f = this.fail[`${method} ${path}`];
		if (f) throw f;
	}

	#vmid(path: string): number {
		return Number(/\/qemu\/(\d+)/.exec(path)?.[1]);
	}

	/** Requests this class answers itself; undefined: FakePve handles them. */
	#own(
		method: string,
		path: string,
		params: P,
	): { value: unknown } | undefined {
		this.before?.(method, path, params);
		const n = `/nodes/${this.node}`;
		if (method === "GET" && path === `${n}/storage/local/content`) {
			this.#record(method, path, params);
			return {
				value: this.storage.filter((s) => s.content === params?.content),
			};
		}
		if (method === "GET" && path === `${n}/capabilities/qemu/machines`) {
			this.#record(method, path, params);
			return { value: this.machineTypes };
		}
		const m = /^\/nodes\/[^/]+\/qemu\/\d+(\/.*)$/.exec(path);
		const sub = m?.[1];
		if (sub === undefined) return undefined;
		const vm = this.vms.get(this.#vmid(path));
		const key = `${method} ${sub}`;
		if (
			this.agentExec &&
			(key === "POST /agent/exec" || key === "GET /agent/exec-status")
		) {
			this.#record(method, path, params);
			if (!this.agentUp || vm?.status !== "running")
				throw new PveApiError(500, "QEMU guest agent is not running");
			if (key === "POST /agent/exec") {
				const pid = ++this.#pid;
				const command = params?.command as string[];
				const input = params?.["input-data"] as string | undefined;
				this.execResults.set(
					pid,
					this.agentExec(this.#vmid(path), command, input),
				);
				return { value: { pid } };
			}
			const pid = Number(params?.pid);
			const r = this.execResults.get(pid);
			if (r === undefined)
				throw new PveApiError(500, `PID ${pid} does not exist`);
			if (r === "running") return { value: { exited: 0 } };
			this.execResults.delete(pid);
			return {
				value: {
					exited: 1,
					exitcode: r.exitcode,
					"out-data": r.out ?? "",
					"err-data": r.err ?? "",
				},
			};
		}
		if (key === "PUT /resize") {
			this.#record(method, path, params);
			if (!vm) throw new PveApiError(500, "VM does not exist");
			vm.config.scsi0 = `${vm.config.scsi0},size=${String(params?.size)}`;
			return { value: `UPID:pve:${++this.#upid}` };
		}
		if (key === "POST /template") {
			this.#record(method, path, params);
			if (!vm) throw new PveApiError(500, "VM does not exist");
			vm.config.template = "1";
			const id = this.#vmid(path);
			for (const [k, v] of Object.entries(vm.config))
				vm.config[k] = v.replaceAll(`:vm-${id}-disk-`, `:base-${id}-disk-`);
			return { value: `UPID:pve:${++this.#upid}` };
		}
		if (key === "GET /firewall/rules") {
			this.#record(method, path, params);
			return {
				value: (vm?.firewall.rules ?? []).map((r, pos) => ({ ...r, pos })),
			};
		}
		if (key === "GET /firewall/ipset") {
			this.#record(method, path, params);
			return {
				value: Object.keys(vm?.firewall.ipsets ?? {}).map((name) => ({ name })),
			};
		}
		const rule = /^DELETE \/firewall\/rules\/(\d+)$/.exec(key);
		if (rule && vm) {
			this.#record(method, path, params);
			vm.firewall.rules.splice(Number(rule[1]), 1);
			return { value: null };
		}
		const set = /^DELETE \/firewall\/ipset\/([\w-]+)$/.exec(key);
		if (set?.[1] && vm) {
			this.#record(method, path, params);
			delete vm.firewall.ipsets[set[1]];
			return { value: null };
		}
		if (key === "PUT /unlink") {
			this.#record(method, path, params);
			if (!vm) throw new PveApiError(500, "VM does not exist");
			for (const k of String(params?.idlist).split(",")) delete vm.config[k];
			return { value: null };
		}
		if (key === "PUT /config" && params?.delete !== undefined) {
			this.#record(method, path, params);
			if (!vm) throw new PveApiError(500, "VM does not exist");
			for (const k of String(params.delete).split(",")) delete vm.config[k];
			for (const [k, v] of Object.entries(params))
				if (k !== "delete") vm.config[k] = String(v);
			return { value: null };
		}
		if (key === "POST /agent/shutdown") {
			this.#record(method, path, params);
			if (vm) vm.status = "stopped";
			return { value: { result: {} } };
		}
		return undefined;
	}

	override get<T>(path: string, params?: P) {
		const r = this.#own("GET", path, params);
		return r ? Promise.resolve(r.value as T) : super.get<T>(path, params);
	}
	override post<T>(path: string, params?: P) {
		try {
			const r = this.#own("POST", path, params);
			if (r) return Promise.resolve(r.value as T);
		} catch (err) {
			return Promise.reject(err);
		}
		const created = super.post<T>(path, params);
		if (path !== `/nodes/${this.node}/qemu`) return created;
		return created.then((v) => {
			this.#allocate(Number(params?.vmid));
			return v;
		});
	}

	/**
	 * New volumes of a create (`<storage>:<GiB>,...`, not import-from) become
	 * vm-<vmid>-disk-<k>, k in efidisk0, scsi0, tpmstate0 order.
	 */
	#allocate(vmid: number): void {
		const vm = this.vms.get(vmid);
		if (!vm) return;
		let k = 0;
		for (const slot of FIRMWARE_ORDER) {
			const v = vm.config[slot];
			const alloc = v && /^([^:,]+):\d+(,.*)?$/.exec(v);
			if (!alloc || v.includes("import-from")) continue;
			vm.config[slot] = `${alloc[1]}:vm-${vmid}-disk-${k++}${alloc[2] ?? ""}`;
		}
	}
	override put<T>(path: string, params?: P) {
		try {
			const r = this.#own("PUT", path, params);
			return r ? Promise.resolve(r.value as T) : super.put<T>(path, params);
		} catch (err) {
			return Promise.reject(err);
		}
	}
	override delete<T>(path: string, params?: P) {
		try {
			const r = this.#own("DELETE", path, params);
			if (r) return Promise.resolve(r.value as T);
		} catch (err) {
			return Promise.reject(err);
		}
		return super.delete<T>(path, params);
	}

	async upload<T>(
		path: string,
		fields: Record<string, string>,
		file: UploadFile,
	): Promise<T> {
		this.before?.("UPLOAD", path, fields);
		this.#record("UPLOAD", path, { ...fields, filename: file.name });
		this.uploads.push({ path, fields, file });
		const content = fields.content as "iso" | "import";
		const volid = `local:${content}/${file.name}`;
		this.storage = this.storage.filter((s) => s.volid !== volid);
		this.storage.push({ volid, content, size: file.size });
		return `UPID:pve:${++this.#upid}` as T;
	}
}

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

export const FAKE_PACKAGES =
	"ii \tbash\t5.2.37-1\nii \tcurl\t8.14.1-1\nrc \told\t1.0\n";

/**
 * Guest of the build VM: steps finish at once with rc 0 (or `failRc[step]`), a reboot changes
 * the boot id, file writes through `sh -c 'cat > ...'` land in `files`.
 */
export class FakeGuest implements GuestIo {
	calls: { cmd: string[]; input?: string }[] = [];
	files = new Map<string, string>();
	failRc: Record<string, string> = {};
	/** Scripts systemd-run started, in order. */
	started: { step: string; script: string }[] = [];
	packages = FAKE_PACKAGES;
	tools =
		'{"node":{"direct":"v24.11.0","login":"v24.11.0"},"sbx":{"direct":"missing","login":"missing"}}';
	/** Called when systemd-run starts a step. */
	onStep?: (step: string) => void;
	/** Exit status of `sbx-agent seal`. */
	sealExit = 0;
	/** Exit status of the random seed stop and removal. */
	randomSeedExit = 0;
	log: string[];
	#bootId = 1;

	constructor(log: string[]) {
		this.log = log;
	}

	async exec(
		cmd: string[],
		o?: { input?: string; timeoutMs?: number },
	): Promise<ExecResult> {
		this.calls.push(o?.input === undefined ? { cmd } : { cmd, input: o.input });
		const [c0, c1] = cmd;
		if (c0 === "systemd-run") {
			const step = String(cmd[1]).replace("--unit=sbx-build-", "");
			const script = String(cmd.at(-1));
			this.started.push({ step, script });
			this.log.push(`guest:step ${step}`);
			this.onStep?.(step);
			return ok();
		}
		if (c0 === "systemctl" && c1 === "show")
			return ok("LoadState=not-found\nActiveState=inactive\n");
		if (c0 === "systemctl" && c1 === "reboot") {
			this.#bootId++;
			this.log.push("guest:reboot");
			return ok();
		}
		if (c0 === "systemctl" && c1 === "--version")
			return ok("systemd 259 (259.1-1ubuntu1)\n+PAM +AUDIT\n");
		if (c0 === "cat" && c1 === "/proc/sys/kernel/random/boot_id")
			return ok(`boot-${this.#bootId}\n`);
		if (c0 === "uname") return ok("7.0.0-10-generic\n");
		if (c0 === "dpkg-query") {
			this.log.push("guest:dpkg-query");
			return ok(this.packages);
		}
		if (c0 === "sbx-agent" && c1 === "seal") {
			this.log.push("guest:seal");
			return this.sealExit === 0
				? ok("sealed\n")
				: { exitCode: this.sealExit, stdout: "", stderr: "seal failed" };
		}
		if (c0 === "bash" && c1 === "-s") {
			this.log.push("guest:verify-tools");
			return ok(`TOOLS ${this.tools}\n`);
		}
		if (c0 === "sh" && c1 === "-c" && String(cmd[2]).includes("cat >")) {
			const path = String(cmd.at(-1));
			const append = String(cmd[2]).includes("cat >>");
			this.files.set(
				path,
				(append ? (this.files.get(path) ?? "") : "") + (o?.input ?? ""),
			);
			this.log.push(`guest:write ${path}`);
			return ok();
		}
		if (c0 === "sh" && c1 === "-c" && String(cmd[2]).includes("mv -f")) {
			const [from, to] = [String(cmd.at(-2)), String(cmd.at(-1))];
			this.files.set(to, this.files.get(from) ?? "");
			this.files.delete(from);
			this.log.push(`guest:mv ${to}`);
			return ok();
		}
		if (c0 === "bash" && c1 === "-c") {
			const s = String(cmd[2]);
			if (s.includes("rm -rf /var/log/sbx-build"))
				this.log.push("guest:rm-build-logs");
			if (s.includes("journalctl --relinquish-var"))
				this.log.push("guest:drop-journal");
			if (s.includes("/dev/zero")) this.log.push("guest:zero-fill");
			if (s.includes("fstrim")) this.log.push("guest:fstrim");
			if (s.includes("systemd-random-seed")) {
				this.log.push("guest:random-seed");
				if (this.randomSeedExit !== 0)
					return {
						exitCode: this.randomSeedExit,
						stdout: "",
						stderr: "still active",
					};
			}
		}
		if (c0 === "update-initramfs") this.log.push("guest:initrd");
		if (c0 === "fstrim") this.log.push("guest:fstrim");
		if (c0 === "sync") this.log.push("guest:sync");
		return ok();
	}

	async readFile(path: string, offset: number): Promise<Buffer> {
		const m = /^\/var\/log\/sbx-build\/(.+)\.(rc|log)$/.exec(path);
		if (!m) return Buffer.alloc(0);
		const [, step = "", kind] = m;
		const run = this.started.findLast((s) => s.step === step);
		if (!run) return Buffer.alloc(0);
		if (kind === "rc") {
			const rc =
				this.failRc[step] ?? (run.script === FAIL_STEP_SCRIPT ? "1" : "0");
			return Buffer.from(`${rc}\n`);
		}
		const text = Buffer.from(`running ${run.script}\nend of ${step}\n`);
		return text.subarray(offset);
	}

	async ping(): Promise<boolean> {
		return true;
	}

	/** Commands as single strings, for assertions. */
	commands(): string[] {
		return this.calls.map((c) => c.cmd.join(" "));
	}
}

export interface GuestFilesRequest {
	/** Empty when the read asks for no exit file. */
	exit: string;
	log: string;
	offset: number;
	count: number;
}

/** The request of a readGuestFiles exec (src/windows/runner.ts), undefined for other commands. */
export function guestFilesRequest(
	cmd: string[],
): GuestFilesRequest | undefined {
	if (cmd[0] !== "powershell.exe" || !cmd.includes("-EncodedCommand"))
		return undefined;
	const text = Buffer.from(String(cmd.at(-1)), "base64").toString("utf16le");
	const str = (name: string) =>
		new RegExp(`^\\$${name} = '((?:[^']|'')*)'$`, "m")
			.exec(text)?.[1]
			?.replaceAll("''", "'");
	const num = (name: string) =>
		new RegExp(`^\\$${name} = (\\d+)$`, "m").exec(text)?.[1];
	const exit = str("exitPath");
	const log = str("logPath");
	const offset = num("offset");
	const count = num("count");
	if (
		exit === undefined ||
		log === undefined ||
		offset === undefined ||
		count === undefined
	)
		return undefined;
	return { exit, log, offset: Number(offset), count: Number(count) };
}

/** What the readGuestFiles script prints; `undefined` content = missing file. */
export function guestFilesAnswer(
	r: GuestFilesRequest,
	exit: string | Buffer | undefined,
	log: Buffer | undefined,
): ExecResult {
	const data = log?.subarray(r.offset, r.offset + r.count) ?? Buffer.alloc(0);
	return ok(
		JSON.stringify({
			exit: r.exit === "" || exit === undefined ? null : exit.toString(),
			size: log?.length ?? 0,
			data: data.toString("base64"),
		}),
	);
}

/** What the facts script of the Windows build reports by default. */
export const FAKE_WIN_FACTS = {
	editionId: "Professional",
	build: "26300",
	ubr: 9457,
	displayVersion: "26H1",
	openssh: "9.8.3.1",
	tools: { pwsh: "PowerShell 7.6.9", node: "v26.13.0", gh: null },
	provisioned: ["Microsoft.WindowsStore", "Microsoft.WindowsCalculator"],
};

/**
 * Windows guest of the build VM as runWindowsStep and the Windows stages see it: steps finish at
 * once with exit 0 (or `failRc[step]`), a reboot changes the boot time, `alive()` decides ping.
 */
export class FakeWinGuest implements GuestIo {
	calls: { cmd: string[]; input?: string }[] = [];
	failRc: Record<string, string> = {};
	/** Steps whose scheduled task was started, in order. */
	started: string[] = [];
	facts: unknown = FAKE_WIN_FACTS;
	sealExit = 0;
	/** Content of C:\Windows\System32\Sysprep\Panther\setuperr.log. */
	setupErr = "";
	/** Exit codes of the next removals of C:\sbx-build (then 0). */
	rmBuildDirExits: number[] = [];
	onStep?: (step: string) => void;
	alive: () => boolean = () => true;
	log: string[];
	#boot = 1;

	constructor(log: string[]) {
		this.log = log;
	}

	async exec(
		cmd: string[],
		o?: { input?: string; timeoutMs?: number },
	): Promise<ExecResult> {
		this.calls.push(o?.input === undefined ? { cmd } : { cmd, input: o.input });
		const [c0, c1] = cmd;
		const script = String(cmd.at(-1));
		if (c0 === "schtasks.exe") {
			const task = String(cmd.at(c1 === "/delete" ? 4 : 3));
			const step = task.replace(/^sbx-build-/, "");
			if (c1 === "/run") {
				this.started.push(step);
				this.log.push(`guest:step ${step}`);
				this.onStep?.(step);
			}
			if (c1 === "/query") {
				if (!this.started.includes(step))
					return { exitCode: 1, stdout: "", stderr: "ERROR: not found" };
				return ok(`"\\${task}","N/A","Ready"\r\n`);
			}
			return ok();
		}
		if (c0 === "powershell.exe" && script.includes("Get-Volume"))
			return ok("D\r\n");
		if (c0 === "powershell.exe" && script.includes("LastBootUpTime"))
			return ok(`2026-10-31T10:00:0${this.#boot}.0000000+00:00\r\n`);
		if (c0 === "shutdown.exe") {
			this.#boot++;
			this.log.push("guest:reboot");
			return ok();
		}
		const read = guestFilesRequest(cmd);
		if (read) return this.#readFiles(read);
		if (c0 === "powershell.exe" && cmd.includes("-EncodedCommand")) {
			const text = Buffer.from(script, "base64").toString("utf16le");
			if (text.includes("CurrentVersion")) {
				this.log.push("guest:facts");
				return ok(`noise\r\nFACTS ${JSON.stringify(this.facts)}\r\n`);
			}
			if (text.includes("C:\\sbx-build")) {
				this.log.push("guest:rm-sbx-build");
				const code = this.rmBuildDirExits.shift() ?? 0;
				return code === 0
					? ok()
					: { exitCode: code, stdout: "", stderr: "file in use" };
			}
			if (text.includes("sbx-template")) {
				this.log.push("guest:mkdir-sbx-template");
				return ok();
			}
		}
		if (c0?.endsWith("sbx-agent.exe") && c1 === "seal") {
			this.log.push("guest:seal");
			return this.sealExit === 0
				? ok("sealed\r\n")
				: { exitCode: this.sealExit, stdout: "", stderr: "seal failed" };
		}
		return ok();
	}

	#readFiles(r: GuestFilesRequest): ExecResult {
		if (r.log.endsWith("\\setuperr.log"))
			return guestFilesAnswer(r, undefined, Buffer.from(this.setupErr));
		const m = /^C:\\sbx-build\\logs\\(.+)\.log$/.exec(r.log);
		const step = m?.[1] ?? "";
		if (!m || !this.started.includes(step))
			return guestFilesAnswer(r, undefined, undefined);
		return guestFilesAnswer(
			r,
			`${this.failRc[step] ?? "0"}\r\n`,
			Buffer.from(`running ${step}\nend of ${step}\n`),
		);
	}

	async readFile(path: string): Promise<Buffer> {
		// QGA file-read leaves handles open on Windows when it times out.
		throw new Error(`file-read is not used on Windows: ${path}`);
	}

	async ping(): Promise<boolean> {
		return this.alive();
	}

	commands(): string[] {
		return this.calls.map((c) => c.cmd.join(" "));
	}
}

/**
 * QGA side of Qga.fileWriteWindows: files written through the PowerShell append script, with the
 * sha256 printed after the last chunk.
 */
export class FakeWinFiles {
	files = new Map<string, Buffer>();

	/** The result for a matching exec, undefined for any other command. */
	handle(
		command: string[],
		input: string | undefined,
	): AgentExecResult | undefined {
		const script = String(command[4] ?? "");
		if (command[0] !== "powershell" || !script.includes("FromBase64String"))
			return undefined;
		const path = String(command.at(-1));
		const data = Buffer.from((input ?? "").trim(), "base64");
		const prev = script.includes("FileMode]::Append")
			? (this.files.get(path) ?? Buffer.alloc(0))
			: Buffer.alloc(0);
		const next = Buffer.concat([prev, data]);
		this.files.set(path, next);
		return {
			exitcode: 0,
			out: script.includes("Get-FileHash")
				? `${createHash("sha256").update(next).digest("hex").toUpperCase()}\r\n`
				: "",
		};
	}
}

// Signed agent packages (format of services/guest-agent/internal/update, as agent-package.ts reads it)

function tarEntry(name: string, data: Buffer, type = "0"): Buffer[] {
	const hdr = Buffer.alloc(512);
	hdr.write(name, 0, 100, "utf8");
	hdr.write("0000644\0", 100);
	hdr.write("0000000\0", 108);
	hdr.write("0000000\0", 116);
	hdr.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	hdr.write("00000000000\0", 136);
	hdr.write("        ", 148);
	hdr.write(type, 156);
	hdr.write("ustar\x0000", 257, "latin1");
	let sum = 0;
	for (const b of hdr) sum += b;
	hdr.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return [hdr, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

/** Writes a signed agent package and its update keys file into `dir`. */
export function writeAgentPackage(
	dir: string,
	o: { os: string; arch?: string; version?: string },
): { tar: string; keys: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(
		publicKey.export({ format: "jwk" }).x as string,
		"base64url",
	);
	const keyLine = `ed25519 ${raw.toString("base64")} test`;
	const binary = o.os === "windows" ? "sbx-agent.exe" : "sbx-agent";
	const files: Record<string, Buffer> = {
		[binary]: Buffer.from("agent binary"),
		"trust/tunnel-ca.pem": Buffer.from("ca"),
		"trust/update-keys.pub": Buffer.from(`${keyLine}\n`),
	};
	const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
	const manifest = Buffer.from(
		`${JSON.stringify({
			format: "sbx-agent-manifest/v1",
			version: o.version ?? "0.4.0-test",
			os: o.os,
			arch: o.arch ?? "amd64",
			files: Object.fromEntries(
				Object.entries(files).map(([n, d]) => [n, sha(d)]),
			),
		})}\n`,
	);
	const sig = sign(null, manifest, privateKey as KeyObject);
	const tar = Buffer.concat([
		...tarEntry("trust/", Buffer.alloc(0), "5"),
		...Object.entries(files).flatMap(([n, d]) => tarEntry(n, d)),
		...tarEntry("manifest.json", manifest),
		...tarEntry("manifest.sig", sig),
		Buffer.alloc(1024),
	]);
	const tarPath = join(dir, `sbx-agent-${o.os}.tar`);
	const keysPath = join(dir, `update-keys-${o.os}.pub`);
	writeFileSync(tarPath, tar);
	writeFileSync(keysPath, `${keyLine}\n`);
	return { tar: tarPath, keys: keysPath };
}
