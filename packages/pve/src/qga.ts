import type { PveClient } from "./pve-api.ts";

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
			const st = await this.#api.get<{
				exited: number;
				exitcode?: number;
				"out-data"?: string;
				"err-data"?: string;
			}>(this.#path(vmid, "exec-status"), { pid });
			if (st.exited)
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
