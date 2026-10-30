// `sbx version`: versions of the CLI, the SDK and the runtime.

import { SDK_VERSION } from "@sbx/sdk";
import type { Command } from "commander";
import type { Runner } from "../program.ts";

export const CLI_VERSION = "0.1.0";

export interface VersionInfo {
	version: string;
	sdk: string;
	runtime: string;
	platform: string;
}

export function versionInfo(): VersionInfo {
	const bun = (globalThis as { Bun?: { version: string } }).Bun;
	return {
		version: CLI_VERSION,
		sdk: SDK_VERSION,
		runtime:
			bun === undefined
				? `node ${process.versions.node}`
				: `bun ${bun.version}`,
		platform: `${process.platform}-${process.arch}`,
	};
}

export function register(program: Command, run: Runner): void {
	program
		.command("version")
		.description("print the versions of sbx, the SDK and the runtime")
		.action(
			run(async (ctx) => {
				ctx.out.result(
					versionInfo(),
					(v) => `sbx ${v.version} (sdk ${v.sdk}, ${v.runtime}, ${v.platform})`,
				);
			}),
		);
}
