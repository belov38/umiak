import { describe, expect, it } from "vitest";
import { replicateTemplate } from "../src/template-replication.ts";

describe("template replication", () => {
	it("refuses to publish without an immutable Umiak source", async () => {
		const api = { get: async () => ({ template: 0, tags: "foreign" }) };
		await expect(
			replicateTemplate({
				api,
				sourceNode: "a",
				targetNode: "b",
				sourceStorage: "local-lvm",
				targetStorage: "local-lvm",
				sourceVmid: 600,
				targetVmid: 601,
				id: "a".repeat(32),
				source: {},
				target: {},
				checkpoint: async () => {},
			} as never),
		).rejects.toThrow(/template/);
	});
});

it("copies a base once, verifies it before publication, and retries without rebuilding", async () => {
	const { createHash } = await import("node:crypto");
	const bytes = Buffer.alloc(512, 7);
	const stage = Buffer.alloc(512);
	let published = false;
	let converted = false;
	let created = false;
	let tagged = false;
	let writes = 0;
	const srcConfig = {
		template: 1,
		tags: "umiak-tpl",
		scsi0: "local-lvm:base-600-disk-0,discard=on",
	};
	const api = {
		async get(path: string) {
			if (path.includes("/a/")) return srcConfig;
			if (path.endsWith("/qemu")) return created ? [{ vmid: 601 }] : [];
			return {
				template: converted ? 1 : 0,
				name: `umiak-replica-${"a".repeat(32)}`,
				...(tagged ? { tags: `umiak-tpl;umiak-copy-${"a".repeat(32)}` } : {}),
			};
		},
		async post(path: string, params?: Record<string, unknown>) {
			if (path.endsWith("/qemu")) {
				// PVE refuses tags on create for a pool-scoped token (live 403).
				expect(params?.tags).toBeUndefined();
				created = true;
			}
			if (path.endsWith("/template")) {
				expect(published).toBe(true);
				converted = true;
			}
			return "task";
		},
		async put(_path: string, params: Record<string, unknown>) {
			if (params.tags !== undefined) {
				tagged = true;
				return;
			}
			expect(published).toBe(true);
		},
		async delete() {},
		async waitTask() {},
	};
	const reader = (
		data: Buffer,
		args: { offset: number; length: number; hashOnly?: boolean },
	) => {
		const b = data.subarray(args.offset, args.offset + args.length);
		return {
			sizeBytes: 512,
			sha256: createHash("sha256").update(b).digest("hex"),
			zero: b.every((v) => v === 0),
			...(!args.hashOnly ? { data: b.toString("base64") } : {}),
		};
	};
	const source = {
		close() {},
		async call<T>(op: string, args?: object): Promise<T> {
			if (op === "lv.list")
				return [{ name: "base-600-disk-0", sizeBytes: 512 }] as T;
			if (op === "lv.transferMap")
				return {
					sizeBytes: 512,
					next: 0,
					ranges: [{ offset: 0, length: 512 }],
				} as T;
			return reader(bytes, args as never) as T;
		},
	};
	const target = {
		close() {},
		async call<T>(op: string, args?: object): Promise<T> {
			const a = args as { data: string; offset: number; length: number };
			if (op === "lv.transferPrepare")
				return { name: `umiak-snap-${"a".repeat(32)}-scsi0` } as T;
			if (op === "lv.transferRead") return reader(stage, a) as T;
			if (op === "lv.transferWrite") {
				Buffer.from(a.data, "base64").copy(stage, a.offset);
				writes++;
				return {} as T;
			}
			if (op === "lv.transferPublish") {
				expect(stage.equals(bytes)).toBe(true);
				published = true;
			}
			return {} as T;
		},
	};
	const input = {
		api: api as never,
		source,
		target,
		sourceNode: "a",
		targetNode: "b",
		sourceStorage: "local-lvm",
		targetStorage: "local-lvm",
		sourceVmid: 600,
		targetVmid: 601,
		id: "a".repeat(32),
		checkpoint: async () => {},
	};
	const result = await replicateTemplate(input);
	expect(result.scsi0?.sha256).toMatch(/^[a-f0-9]{64}$/);
	expect(converted).toBe(true);
	expect(writes).toBe(1);
	await replicateTemplate(input);
	expect(writes).toBe(1);
});
