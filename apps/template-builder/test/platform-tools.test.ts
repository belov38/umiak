import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderOfflineSeed } from "../src/offline-seed.ts";
import {
	assertPlatformCliAsset,
	installPlatformCli,
	SEED_CLI_PATH,
} from "../src/platform-tools.ts";

it("installs the CLI from the build seed after checking the installed release hash", async () => {
	const directory = await mkdtemp(join(tmpdir(), "umiak-platform-cli-"));
	try {
		const payload = Buffer.alloc(100000);
		for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
		const file = join(directory, "umiak-linux-x64");
		await writeFile(file, payload);
		const sha = createHash("sha256").update(payload).digest("hex");
		const commands: string[][] = [];
		const record = await installPlatformCli(
			{
				exec: async (cmd, o) => {
					commands.push(cmd);
					// No bulk transfer through QGA: inputs stay tiny.
					expect(Buffer.byteLength(o?.input || "")).toBeLessThan(512);
					if (cmd[0] === "sha256sum")
						expect(o?.input).toBe(
							`${sha}  /mnt/umiak-cli-seed/${SEED_CLI_PATH}\n`,
						);
					return {
						exitCode: 0,
						stdout:
							cmd[0] === "/usr/local/bin/umiak"
								? "umiak 0.4.0-edge.20261106.1\n"
								: "",
						stderr: "",
					};
				},
				readFile: async () => Buffer.alloc(0),
				ping: async () => true,
			},
			file,
		);
		expect(commands[0]?.join(" ")).toContain("LABEL=cidata");
		expect(commands.some((c) => c[0] === "umount")).toBe(true);
		expect(record).toMatchObject({
			id: "umiak-cli",
			sha256: sha,
			version: "umiak 0.4.0-edge.20261106.1",
			nodeInstalled: true,
			partOfSignedLayer: false,
			source: "installed-platform-release",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("puts the installed CLI on the offline seed only when given", async () => {
	const directory = await mkdtemp(join(tmpdir(), "umiak-platform-cli-"));
	try {
		const file = join(directory, "umiak-linux-x64");
		await writeFile(file, "cli-bytes");
		expect(renderOfflineSeed("a".repeat(24), file).get(SEED_CLI_PATH)).toEqual(
			Buffer.from("cli-bytes"),
		);
		expect(renderOfflineSeed("a".repeat(24)).has(SEED_CLI_PATH)).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("fails clearly for a missing platform asset instead of using vendor failure tolerance", () => {
	expect(() => assertPlatformCliAsset("/missing/umiak-linux-x64")).toThrow(
		/installed platform.*CLI asset.*missing/i,
	);
	expect(() => assertPlatformCliAsset(undefined)).toThrow(
		/installed platform.*CLI asset.*missing/i,
	);
});
