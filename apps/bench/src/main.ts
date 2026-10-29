#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cleanup } from "./cleanup.ts";
import { makeContext } from "./context.ts";
import { preflight } from "./preflight.ts";
import { runS1 } from "./s1.ts";

const USAGE = `usage:
  sbx-bench preflight
  sbx-bench s1 [--runs 3] [--size 2g] [--parallel 1,2,4] [--clone-only 8] [--ram-cap 8g] [--no-baseline] [--keep]
  sbx-bench cleanup`;

export function parseSizeMb(v: string): number {
	const m = /^(\d+)([mg])?$/i.exec(v.trim());
	if (!m) throw new Error(`bad size ${v}`);
	return Number(m[1]) * (m[2]?.toLowerCase() === "m" ? 1 : 1024);
}

async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			runs: { type: "string", default: "3" },
			size: { type: "string", default: "2g" },
			parallel: { type: "string", default: "1,2,4" },
			"clone-only": { type: "string", default: "8" },
			"ram-cap": { type: "string", default: "8g" },
			"no-baseline": { type: "boolean", default: false },
			keep: { type: "boolean", default: false },
			out: { type: "string", default: "bench-results" },
		},
	});
	const cmd = positionals[0];
	if (!cmd || !["preflight", "s1", "cleanup"].includes(cmd)) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	// The bench measures contention itself, so the per-node clone limit is not applied here.
	const ctx = await makeContext({ cloneConcurrency: 64 });
	try {
		if (cmd === "preflight") {
			const { checks } = await preflight(ctx);
			for (const c of checks)
				process.stdout.write(
					`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}\n`,
				);
			return checks.every((c) => c.ok) ? 0 : 1;
		}
		if (cmd === "cleanup") {
			const report = await cleanup(ctx);
			process.stdout.write(
				`${report.length ? report.join("\n") : "nothing to clean"}\n`,
			);
			const { checks } = await preflight(ctx);
			const left = checks.filter(
				(c) => !c.ok && c.name.startsWith("no leftover"),
			);
			for (const c of left)
				process.stdout.write(`still left: ${c.name} ${c.detail ?? ""}\n`);
			return left.length === 0 ? 0 : 1;
		}
		return await runS1(ctx, {
			runs: Number(values.runs),
			size: { cores: 2, memoryMb: parseSizeMb(values.size) },
			parallel: values.parallel
				.split(",")
				.filter(Boolean)
				.map((x) => Number(x)),
			cloneOnly: Number(values["clone-only"]),
			ramCapMb: parseSizeMb(values["ram-cap"]),
			baseline: !values["no-baseline"],
			keep: values.keep,
			outDir: values.out,
		});
	} finally {
		ctx.close();
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(
				`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
			);
			process.exit(1);
		},
	);
}
