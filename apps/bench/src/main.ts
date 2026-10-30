#!/usr/bin/env node
import { parseArgs } from "node:util";
import { cleanup } from "./cleanup.ts";
import { makeContext } from "./context.ts";
import { preflight } from "./preflight.ts";
import { runS1 } from "./s1.ts";
import { runS3 } from "./s3.ts";
import { runS5 } from "./s5.ts";
import { runS9 } from "./s9.ts";
import { runAgentTests } from "./win-agent-tests.ts";

const USAGE = `usage:
  sbx-bench preflight
  sbx-bench s1 [--runs 3] [--size 2g] [--parallel 1,2,4] [--clone-only 8] [--ram-cap 8g] [--no-baseline] [--keep]
  sbx-bench s3 [--skip-suite] [--keep]
  sbx-bench s5 --template <vmid> [--baseline 599] [--runs 5] [--ram-cap 8g] [--keep]
  sbx-bench s9 --template <vmid> [--runs 3] [--ram-cap 8g] [--connect-url <wss>] [--dev-cp-ssh <host>] [--keep]
  sbx-bench s9 agent-tests --vmid <running clone> --dir <test binaries>
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
			runs: { type: "string" },
			size: { type: "string", default: "2g" },
			parallel: { type: "string", default: "1,2,4" },
			"clone-only": { type: "string", default: "8" },
			"ram-cap": { type: "string", default: "8g" },
			"no-baseline": { type: "boolean", default: false },
			keep: { type: "boolean", default: false },
			"skip-suite": { type: "boolean", default: false },
			out: { type: "string", default: "bench-results" },
			template: { type: "string" },
			baseline: { type: "string" },
			vmid: { type: "string" },
			dir: { type: "string" },
			"connect-url": { type: "string" },
			"dev-cp-ssh": { type: "string" },
		},
	});
	const cmd = positionals[0];
	if (!cmd || !["preflight", "s1", "s3", "s5", "s9", "cleanup"].includes(cmd)) {
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
		const vmid = (v: string | undefined, name: string) => {
			if (v === undefined) return undefined;
			if (!/^\d+$/.test(v)) throw new Error(`--${name}: not a VMID: ${v}`);
			return Number(v);
		};
		if (cmd === "s9") {
			if (positionals[1] === "agent-tests") {
				const target = vmid(values.vmid, "vmid");
				if (target === undefined || values.dir === undefined) {
					process.stderr.write(`--vmid and --dir are required\n${USAGE}\n`);
					return 2;
				}
				return await runAgentTests(
					{ qga: ctx.machines.qga },
					{ vmid: target, dir: values.dir },
				);
			}
			const template = vmid(values.template, "template");
			if (template === undefined) {
				process.stderr.write(`--template is required\n${USAGE}\n`);
				return 2;
			}
			return await runS9(ctx, {
				template,
				runs: Number(values.runs ?? "3"),
				...(values["connect-url"] !== undefined
					? { connectUrl: values["connect-url"] }
					: {}),
				...(values["dev-cp-ssh"] !== undefined
					? { devCpSsh: values["dev-cp-ssh"] }
					: {}),
				keep: values.keep,
				outDir: values.out,
				ramCapMb: parseSizeMb(values["ram-cap"]),
			});
		}
		if (cmd === "s5") {
			const template = vmid(values.template, "template");
			if (template === undefined) {
				process.stderr.write(`--template is required\n${USAGE}\n`);
				return 2;
			}
			const baseline = vmid(values.baseline, "baseline");
			return await runS5(ctx, {
				template,
				...(baseline !== undefined ? { baseline } : {}),
				runs: Number(values.runs ?? "5"),
				ramCapMb: parseSizeMb(values["ram-cap"]),
				keep: values.keep,
				outDir: values.out,
			});
		}
		if (cmd === "s3")
			return await runS3(ctx, {
				keep: values.keep,
				outDir: values.out,
				skipSuite: values["skip-suite"],
			});
		return await runS1(ctx, {
			runs: Number(values.runs ?? "3"),
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
