import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { GuestIo } from "./runner.ts";
export interface PlatformToolRecord {
	id: "umiak-cli";
	name: "Umiak CLI";
	version: string;
	sha256: string;
	nodeInstalled: true;
	partOfSignedLayer: false;
	source: "installed-platform-release";
	durationS: number;
}
export function assertPlatformCliAsset(
	path: string | undefined,
): asserts path is string {
	try {
		if (!path) throw Error();
		const file = statSync(path);
		if (!file.isFile() || !file.size || file.size > 512 * 1024 ** 2)
			throw Error();
	} catch {
		throw Error(
			"Installed platform guest CLI asset is missing or invalid; repair this Umiak release before building a Linux template",
		);
	}
}
/** Preserve the installed release's existing trust boundary; this asset is never part of the public layer. */
export async function installPlatformCli(
	io: GuestIo,
	path: string,
): Promise<PlatformToolRecord> {
	assertPlatformCliAsset(path);
	const started = Date.now(),
		file = await open(path, "r"),
		hash = createHash("sha256");
	const must = async (cmd: string[], input?: string) => {
		const result = await io.exec(cmd, {
			...(input === undefined ? {} : { input }),
			timeoutMs: 120000,
		});
		if (result.exitCode !== 0)
			throw Error(
				`Installed platform CLI transfer failed: ${result.stderr.trim().slice(0, 500)}`,
			);
		return result.stdout;
	};
	const guest = "/var/lib/umiak-build/platform-umiak.tmp";
	try {
		const info = await file.stat();
		await must([
			"sh",
			"-c",
			'mkdir -p /var/lib/umiak-build; : > "$1"',
			"sh",
			guest,
		]);
		const buffer = Buffer.alloc(24 * 1024);
		let total = 0;
		for (;;) {
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > info.size)
				throw Error("Installed platform CLI asset changed during transfer");
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			await must(
				["sh", "-c", 'base64 -d >> "$1"', "sh", guest],
				chunk.toString("base64"),
			);
		}
		if (total !== info.size)
			throw Error("Installed platform CLI asset changed during transfer");
		const sha256 = hash.digest("hex");
		await must(["sha256sum", "--check", "--status"], `${sha256}  ${guest}\n`);
		await must(["install", "-m", "0755", guest, "/usr/local/bin/umiak"]);
		await must(["rm", "-f", guest]);
		const version = (await must(["/usr/local/bin/umiak", "--version"]))
			.split("\n")[0]
			?.trim();
		if (!version || version.length > 2048)
			throw Error("Installed platform CLI returned no valid version");
		return {
			id: "umiak-cli",
			name: "Umiak CLI",
			version,
			sha256,
			nodeInstalled: true,
			partOfSignedLayer: false,
			source: "installed-platform-release",
			durationS: (Date.now() - started) / 1000,
		};
	} finally {
		await file.close();
	}
}
