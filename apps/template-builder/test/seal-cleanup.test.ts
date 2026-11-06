import { expect, it } from "vitest";
import type { GuestIo } from "../src/runner.ts";
import { sealGuest } from "../src/seal.ts";

it("uses discard without filling the logical disk in sparse CI/offline replay mode", async () => {
	const calls: string[][] = [];
	const io: GuestIo = {
		exec: async (cmd) => {
			calls.push(cmd);
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		ping: async () => true,
		readFile: async () => Buffer.alloc(0),
	};
	await sealGuest(io, { sparse: true });
	expect(calls.some((c) => c.join(" ").includes("dd if=/dev/zero"))).toBe(
		false,
	);
	expect(calls).toContainEqual(["fstrim", "-av"]);
	expect(calls).toContainEqual(["umiak-agent", "seal"]);
	expect(calls).toContainEqual(["update-initramfs", "-u", "-k", "all"]);
});
