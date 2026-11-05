import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { type NodeOps, stageOfflineLayer } from "../src/node-client.ts";

const args = {
	jobId: "a".repeat(24),
	vmid: 598,
	manifest: { fixture: true },
	signature: "fixture",
	platform: "0.1.0",
	agent: "0.1.0",
	channel: "stable" as const,
	slug: "linux" as const,
};
const digest = createHash("sha256")
	.update(JSON.stringify(args.manifest))
	.digest("hex");
const receipt = {
	jobId: args.jobId,
	vmid: 598,
	manifestSha256: digest,
	mediaName: `umiak-layer-${args.jobId}.raw`,
	mediaIdentity: "1:2",
	mediaSha256: "b".repeat(64),
	mediaBytes: 64 * 1024 ** 2,
	verified: true,
};
it("requires a receipt for the exact layer/job/VMID and a guarded media filename", async () => {
	const calls: string[] = [];
	const node = {
		call: async (op: string) => {
			calls.push(op);
			return op === "layer.prepare"
				? { manifestSha256: digest, missing: [] }
				: receipt;
		},
		close() {},
	} as NodeOps;
	expect(await stageOfflineLayer(node, args)).toEqual(receipt);
	expect(calls).toEqual(["layer.prepare", "layer.stage"]);
	for (const wrong of [
		{ vmid: 599 },
		{ mediaName: "../foreign.raw" },
		{ verified: false },
		{ manifestSha256: "c".repeat(64) },
	]) {
		const bad = {
			call: async (op: string) =>
				op === "layer.prepare"
					? { manifestSha256: digest, missing: [] }
					: { ...receipt, ...wrong },
			close() {},
		} as NodeOps;
		await expect(stageOfflineLayer(bad, args)).rejects.toThrow();
	}
});
