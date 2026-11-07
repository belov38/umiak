import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
/** Guest path of the CLI on the build seed (see renderOfflineSeed). */
export const SEED_CLI_PATH = "build/umiak";
const CLI_SEED_DIR = "/mnt/umiak-cli-seed";

/**
 * Preserve the installed release's existing trust boundary; this asset is never part of the public layer.
 * The bytes travel on the build seed disk (label cidata): pushing ~110 MB through QGA exec input took
 * about 30 minutes. The guest copy must match the hash of the installed release asset.
 */
export async function installPlatformCli(
	io: GuestIo,
	path: string,
): Promise<PlatformToolRecord> {
	assertPlatformCliAsset(path);
	const started = Date.now();
	const sha256 = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	const must = async (cmd: string[], input?: string) => {
		const result = await io.exec(cmd, {
			...(input === undefined ? {} : { input }),
			timeoutMs: 120000,
		});
		if (result.exitCode !== 0)
			throw Error(
				`Installed platform CLI install failed: ${result.stderr.trim().slice(0, 500)}`,
			);
		return result.stdout;
	};
	await must([
		"sh",
		"-c",
		'mkdir -p "$1" && (mountpoint -q "$1" || mount -o ro LABEL=cidata "$1")',
		"sh",
		CLI_SEED_DIR,
	]);
	try {
		const source = `${CLI_SEED_DIR}/${SEED_CLI_PATH}`;
		await must(["sha256sum", "--check", "--status"], `${sha256}  ${source}\n`);
		await must(["install", "-m", "0755", source, "/usr/local/bin/umiak"]);
	} finally {
		await io.exec(["umount", CLI_SEED_DIR]);
	}
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
}
