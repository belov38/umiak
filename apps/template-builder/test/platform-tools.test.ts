import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	assertPlatformCliAsset,
	installPlatformCli,
} from "../src/platform-tools.ts";

it("transfers the installed release CLI as bounded binary QGA stdin and records exact provenance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "umiak-platform-cli-"));
	try {
		const payload = Buffer.alloc(100000);
		for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
		const file = join(directory, "umiak-linux-x64");
		await writeFile(file, payload);
		const chunks: Buffer[] = [];
		const record = await installPlatformCli(
			{
				exec: async (cmd, o) => {
					if (cmd.includes('base64 -d >> "$1"')) {
						expect(Buffer.byteLength(o?.input || "")).toBeLessThanOrEqual(
							32768,
						);
						chunks.push(Buffer.from(o?.input || "", "base64"));
					}
					if (cmd[0] === "sha256sum")
						expect(o?.input).toContain(
							createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
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
		expect(Buffer.concat(chunks)).toEqual(payload);
		expect(record).toMatchObject({
			id: "umiak-cli",
			sha256: createHash("sha256").update(payload).digest("hex"),
			version: "umiak 0.4.0-edge.20261106.1",
			nodeInstalled: true,
			partOfSignedLayer: false,
			source: "installed-platform-release",
		});
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
