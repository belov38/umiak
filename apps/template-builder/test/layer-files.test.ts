import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyCapturedFiles } from "../src/layer-files.ts";
import type { GuestIo } from "../src/runner.ts";

it("streams regular guest inputs, checks each size/hash, and refuses path escapes or substitutions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-layer-copy-"));
	const body = Buffer.from("captured input");
	const file = {
		path: "inputs/fixture",
		sizeBytes: body.length,
		sha256: createHash("sha256").update(body).digest("hex"),
		mode: 0o644,
	};
	const reads: string[] = [];
	const io = {
		readFile: async (path: string, offset: number, count: number) => {
			reads.push(path);
			return body.subarray(offset, offset + count);
		},
	} as GuestIo;
	try {
		await copyCapturedFiles(
			io,
			"/var/lib/umiak-layer-capture",
			join(dir, "out"),
			[file],
		);
		expect(await readFile(join(dir, "out", file.path))).toEqual(body);
		expect(
			reads.every((p) => p === "/var/lib/umiak-layer-capture/inputs/fixture"),
		).toBe(true);
		for (const invalid of [
			{ ...file, path: "../outside" },
			{ ...file, path: "inputs/evil.img" },
			{ ...file, mode: 0o777 },
			{ ...file, sha256: "f".repeat(64) },
			{ ...file, sizeBytes: 1 },
		]) {
			await expect(
				copyCapturedFiles(
					io,
					"/var/lib/umiak-layer-capture",
					join(dir, "bad"),
					[invalid],
				),
			).rejects.toThrow();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
