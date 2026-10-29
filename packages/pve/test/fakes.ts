import type { NodeOps } from "../src/node-client.ts";
import { NodeOpsError } from "../src/node-client.ts";

export interface Call {
	op: string;
	args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

/** In-memory sbx-node: a list of LVs with tags plus a call log. */
export class FakeNode implements NodeOps {
	calls: Call[] = [];
	log: string[];
	lvs: { name: string; tags: string[] }[] = [];
	usage = {
		dataPercent: 10,
		metadataPercent: 5,
		ourLvCount: 0,
		ourLvUsedBytes: 0,
		autoextendThreshold: 100,
	};
	leases: { mac: string; ip: string }[] = [];
	ethers: { mac: string; ip: string }[] = [];
	vmfiles: string[] = [];
	fail: Record<string, Error> = {};
	handlers: Record<string, Handler> = {};

	constructor(log: string[] = []) {
		this.log = log;
	}

	async call<T>(op: string, args: object = {}): Promise<T> {
		const a = args as Record<string, unknown>;
		this.calls.push({ op, args: a });
		this.log.push(`node:${op}`);
		const f = this.fail[op];
		if (f) throw f;
		const h = this.handlers[op];
		if (h) return h(a) as T;
		switch (op) {
			case "pool.usage":
				return this.usage as T;
			case "lv.snapshot": {
				const items = a.items as { name: string; tags: string[] }[];
				for (const it of items) this.lvs.push({ name: it.name, tags: it.tags });
				return { created: items.map((i) => i.name) } as T;
			}
			case "lv.list": {
				const tags = (a.tags as string[] | undefined) ?? [];
				return {
					lvs: this.lvs.filter((l) => tags.every((t) => l.tags.includes(t))),
				} as T;
			}
			case "lv.remove": {
				const names = a.names as string[];
				this.lvs = this.lvs.filter((l) => !names.includes(l.name));
				return { removed: names, missing: [] } as T;
			}
			case "dhcp.leases":
				return { leases: this.leases, ethers: this.ethers } as T;
			case "dhcp.release": {
				const mac = String(a.mac).toLowerCase();
				this.leases = this.leases.filter((l) => l.mac !== mac);
				this.ethers = this.ethers.filter((l) => l.mac !== mac);
				return { released: true } as T;
			}
			case "inventory":
				return { vmfiles: this.vmfiles } as T;
			default:
				throw new NodeOpsError(op, "bad_request", "unknown op in fake");
		}
	}

	close(): void {}

	ops(): string[] {
		return this.calls.map((c) => c.op);
	}
}

/** Manually advanced clock. */
export class FakeClock {
	t = 1_000_000;
	now = () => this.t;
	advance(ms: number) {
		this.t += ms;
	}
}
