import { createHash } from "node:crypto";
import { PveApiError, type PveClient, QgaTimeoutError } from "./pve-api.ts";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GuestInterface {
	name: string;
	"hardware-address"?: string;
	"ip-addresses"?: {
		"ip-address-type": "ipv4" | "ipv6";
		"ip-address": string;
		prefix: number;
	}[];
}

/**
 * qemu-ga no longer knows a PID we started and have not read an exit status for: it restarted
 * (a restarted agent forgets all PIDs), or an exec-status call that timed out was answered later
 * and consumed the status (qemu-ga hands out the status of an exited process once). The exit code
 * and output are gone; the command did start.
 */
export class QgaExecStatusLostError extends Error {
	readonly vmid: number;
	readonly pid: number;
	constructor(vmid: number, pid: number, cause: unknown) {
		super(
			`exit status of guest PID ${pid} on VM ${vmid} was lost (qemu-ga restarted or a timed-out call consumed it)`,
			{ cause },
		);
		this.name = "QgaExecStatusLostError";
		this.vmid = vmid;
		this.pid = pid;
	}
}

/** Message of PveApi's client-side timeout on an exec-status poll. */
const CLIENT_TIMEOUT_RE = /^GET \S+\/agent\/exec-status: timeout$/;

/** Raw bytes per exec in fileWriteWindows. */
const WRITE_CHUNK_BYTES = 32 * 1024;

/**
 * Paths that reach PowerShell as one plain token: letters, digits and `_ . : \ / - + ~ =` only;
 * no spaces, quotes, `$ ; & , ( ) @ %` or backticks (the -Command string is parsed again), and no
 * leading `-` (it would read as a parameter).
 */
const SAFE_WINDOWS_PATH_RE = /^[A-Za-z0-9_.:\\/+=~][A-Za-z0-9_.:\\/+=~-]*$/;

/**
 * Body of the append script. The path is the trailing argument of `powershell -Command`, so it
 * lands in $p; stdin carries the chunk as base64 text.
 */
function appendScript(mode: "Create" | "Append", printHash: boolean): string {
	return [
		"& { param([string]$p)",
		"$b = [Convert]::FromBase64String([Console]::In.ReadToEnd());",
		`$f = [IO.File]::Open($p, [IO.FileMode]::${mode}, [IO.FileAccess]::Write);`,
		"try { $f.Write($b, 0, $b.Length) } finally { $f.Dispose() };",
		...(printHash
			? [
					"(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant()",
				]
			: []),
		"}",
	].join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** QEMU guest agent through the Proxmox API. */
export class Qga {
	readonly #api: PveClient;
	readonly #node: string;

	constructor(api: PveClient, node: string) {
		this.#api = api;
		this.#node = node;
	}

	#path(vmid: number, cmd: string): string {
		return `/nodes/${this.#node}/qemu/${vmid}/agent/${cmd}`;
	}

	async ping(vmid: number): Promise<boolean> {
		try {
			await this.#api.post(this.#path(vmid, "ping"));
			return true;
		} catch {
			return false;
		}
	}

	async fsfreezeFreeze(vmid: number): Promise<void> {
		await this.#api.post(this.#path(vmid, "fsfreeze-freeze"));
	}

	async fsfreezeThaw(vmid: number): Promise<void> {
		await this.#api.post(this.#path(vmid, "fsfreeze-thaw"));
	}

	async fsfreezeStatus(vmid: number): Promise<"thawed" | "frozen"> {
		const r = await this.#api.get<{ result?: string } | string>(
			this.#path(vmid, "fsfreeze-status"),
		);
		const state = typeof r === "string" ? r : r?.result;
		if (state !== "thawed" && state !== "frozen")
			throw new Error(
				`unexpected fsfreeze-status for VM ${vmid}: ${JSON.stringify(state)}`,
			);
		return state;
	}

	/** Guest shutdown through the agent (guest-shutdown); the VM stops by itself. */
	async shutdown(vmid: number): Promise<void> {
		await this.#api.post(this.#path(vmid, "shutdown"));
	}

	/**
	 * Writes a file on a Windows guest. agent/file-write has no append mode, so the data goes in
	 * chunks as base64 on the stdin of a PowerShell append script; the first chunk creates or
	 * truncates the file. The guest prints the sha256 after the last chunk and it must match.
	 */
	async fileWriteWindows(
		vmid: number,
		path: string,
		data: Buffer,
	): Promise<void> {
		if (!SAFE_WINDOWS_PATH_RE.test(path))
			throw new Error(
				`unsupported Windows path ${JSON.stringify(path)}: spaces, quotes and shell metacharacters are not allowed`,
			);
		const chunks = Math.max(1, Math.ceil(data.length / WRITE_CHUNK_BYTES));
		for (let i = 0; i < chunks; i++) {
			const last = i === chunks - 1;
			const chunk = data.subarray(
				i * WRITE_CHUNK_BYTES,
				(i + 1) * WRITE_CHUNK_BYTES,
			);
			const r = await this.exec(
				vmid,
				[
					"powershell",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					appendScript(i === 0 ? "Create" : "Append", last),
					path,
				],
				// An empty chunk still needs a non-empty input-data for PVE; whitespace is valid base64.
				{ input: chunk.length > 0 ? chunk.toString("base64") : "\n" },
			);
			if (r.exitCode !== 0)
				throw new Error(
					`writing ${path} on VM ${vmid} failed at chunk ${i + 1}/${chunks}: exit ${r.exitCode}: ${r.stderr.trim()}`,
				);
			if (last) {
				const want = createHash("sha256").update(data).digest("hex");
				const got = r.stdout.trim().toLowerCase();
				if (got !== want)
					throw new Error(
						`sha256 mismatch for ${path} on VM ${vmid}: guest ${got || "(none)"}, local ${want}`,
					);
			}
		}
	}

	async interfaces(vmid: number): Promise<GuestInterface[]> {
		const r = await this.#api.get<{ result: GuestInterface[] }>(
			this.#path(vmid, "network-get-interfaces"),
		);
		return r.result ?? [];
	}

	async exec(
		vmid: number,
		command: string[],
		opts: { timeoutMs?: number; input?: string } = {},
	): Promise<ExecResult> {
		const params: Record<string, string | readonly string[]> = { command };
		if (opts.input !== undefined) params["input-data"] = opts.input;
		const { pid } = await this.#api.post<{ pid: number }>(
			this.#path(vmid, "exec"),
			params,
		);
		const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
		for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
			let st:
				| {
						exited: number;
						exitcode?: number;
						"out-data"?: string;
						"err-data"?: string;
				  }
				| undefined;
			try {
				st = await this.#api.get(this.#path(vmid, "exec-status"), { pid });
			} catch (err) {
				// Polling on after a timeout or while the agent restarts is harmless: the status of a
				// running process is not consumed, and a lost one shows up as a missing PID. PveApi
				// giving up on an answer (plain Error, see pve-api.ts) counts as a timeout too.
				if (!(err instanceof PveApiError)) {
					if (!(err instanceof Error) || !CLIENT_TIMEOUT_RE.test(err.message))
						throw err;
				} else if (/PID \S+ does not exist/.test(err.message)) {
					// \S+: qemu-ga for Windows prints "PID lld does not exist" (format unexpanded).
					throw new QgaExecStatusLostError(vmid, pid, err);
				} else if (
					!(err instanceof QgaTimeoutError) &&
					!/guest agent is not running/i.test(err.message)
				) {
					throw err;
				}
			}
			if (st?.exited)
				return {
					exitCode: st.exitcode ?? -1,
					stdout: st["out-data"] ?? "",
					stderr: st["err-data"] ?? "",
				};
			if (Date.now() > deadline)
				throw new Error(
					`guest exec on VM ${vmid} timed out: ${command.join(" ")}`,
				);
			await sleep(delay);
		}
	}

	/** Runs a bash snippet in the guest. */
	bash(vmid: number, script: string, timeoutMs = 30_000): Promise<ExecResult> {
		return this.exec(vmid, ["bash", "-c", script], { timeoutMs });
	}
}
