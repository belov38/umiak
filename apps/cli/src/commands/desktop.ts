import { readFile, writeFile } from "node:fs/promises";
import type { DesktopActions } from "@sbx/sdk";
import type { Command } from "commander";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("desktop")
		.description("print a one-time desktop URL or change access")
		.argument("[sb]", "sandbox ID or slug")
		.option("--access <mode>", "token, sso or public")
		.option("--end-streams", "disconnect viewers and revoke cookies")
		.action(
			run(async (ctx, args, opts) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				if (opts.endStreams) {
					await sb.desktop.endStreams();
					ctx.out.result({ ended: true });
					return;
				}
				if (opts.access !== undefined) {
					if (!["token", "sso", "public"].includes(String(opts.access)))
						throw usageError("access must be token, sso or public");
					ctx.out.result(
						await sb.desktop.setAccess(
							opts.access as "token" | "sso" | "public",
						),
					);
					return;
				}
				ctx.out.result(await sb.desktop.link(), (result) => result.url);
			}),
		);
	program
		.command("screenshot")
		.description("capture the desktop as PNG")
		.argument("[sb]", "sandbox ID or slug")
		.option("-o, --output <path>", "write PNG to a file; - means stdout", "-")
		.action(
			run(
				async (ctx, args, opts) => {
					const sb = await useSandbox(ctx, args[0] as string | undefined);
					const shot = await sb.desktop.screenshot({ format: "png" });
					const path = String(opts.output);
					if (path === "-") await ctx.out.data(shot.bytes);
					else {
						await writeFile(path, shot.bytes);
						ctx.out.result({ path, screen: shot.screen, image: shot.image });
					}
				},
				{ rawData: true },
			),
		);
	program
		.command("input")
		.description("execute desktop actions from a JSON file")
		.argument("<sb>", "sandbox ID or slug")
		.requiredOption(
			"--file <path>",
			"JSON object with actions and optional coordinateSpace/screenshot",
		)
		.action(
			run(async (ctx, args, opts) => {
				const sb = await useSandbox(ctx, args[0] as string);
				let body: DesktopActions;
				try {
					body = JSON.parse(
						await readFile(String(opts.file), "utf8"),
					) as DesktopActions;
				} catch {
					throw usageError("input file must be valid JSON");
				}
				ctx.out.result(await sb.desktop.act(body));
			}),
		);
	program
		.command("clipboard")
		.description("read or set desktop clipboard text")
		.argument("[sb]", "sandbox ID or slug")
		.option("--text <text>", "set UTF-8 text")
		.action(
			run(async (ctx, args, opts) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				if (opts.text !== undefined) {
					await sb.desktop.clipboardSet(String(opts.text));
					ctx.out.result({ written: true });
				} else
					ctx.out.result(
						await sb.desktop.clipboardGet(),
						(result) => result.text,
					);
			}),
		);
}
