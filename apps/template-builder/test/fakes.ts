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

/** FakePve plus what a template build needs. */
export class BuildPve extends FakePve {
	storage: StorageFile[] = [];
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
		const m = /^\/nodes\/[^/]+\/qemu\/\d+(\/.*)$/.exec(path);
		const sub = m?.[1];
		if (sub === undefined) return undefined;
		const vm = this.vms.get(this.#vmid(path));
		const key = `${method} ${sub}`;
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
			return { value: `UPID:pve:${++this.#upid}` };
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
			return r ? Promise.resolve(r.value as T) : super.post<T>(path, params);
		} catch (err) {
			return Promise.reject(err);
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
			this.before?.("DELETE", path, params);
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
