import { readFile, writeFile } from "node:fs/promises";
import type { DesktopActions } from "@umiak/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import { openBrowser } from "./login.ts";

type DesktopAction = DesktopActions["actions"][number];

// `umiak desktop ...` (S10 section 14.2). The top-level `screenshot`, `input`
// and `clipboard` of the first S10 pass stay as hidden aliases.

const ACCESS = ["token", "sso", "public"] as const;
type Access = (typeof ACCESS)[number];

function access(value: unknown): Access {
	if (!ACCESS.includes(value as Access))
		throw usageError("access must be token, sso or public");
	return value as Access;
}

function int(value: unknown, what: string): number {
	const n = Number(value);
	if (!Number.isInteger(n)) throw usageError(`${what} must be an integer`);
	return n;
}

async function readStdin(ctx: Context): Promise<string> {
	const parts: Buffer[] = [];
	for await (const chunk of ctx.stdin) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts).toString("utf8");
}

/** The short forms of `umiak desktop act`: click X Y, type TEXT, key ctrl+c, scroll DY. */
export function shortAction(words: string[]): DesktopAction {
	const [kind, ...rest] = words;
	switch (kind) {
		case "click":
			if (rest.length !== 2) throw usageError("usage: act <sb> click X Y");
			return { type: "click", x: int(rest[0], "X"), y: int(rest[1], "Y") };
		case "type":
			if (rest.length === 0) throw usageError("usage: act <sb> type TEXT");
			return { type: "type", text: rest.join(" ") };
		case "key": {
			const keys = (rest[0] ?? "").split("+").filter((k) => k !== "");
			if (rest.length !== 1 || keys.length === 0)
				throw usageError("usage: act <sb> key ctrl+c");
			return { type: "key", keys };
		}
		case "scroll":
			if (rest.length !== 1) throw usageError("usage: act <sb> scroll DY");
			return { type: "scroll", dy: int(rest[0], "DY") };
		default:
			throw usageError(
				"act takes --file <path|-> or one of: click X Y, type TEXT, key ctrl+c, scroll DY",
			);
	}
}

export function register(program: Command, run: Runner): void {
	const desktop = program
		.command("desktop")
		.description("desktop of a sandbox: link, screenshot, input, clipboard");

	desktop
		.command("open", { isDefault: true })
		.description(
			"open the desktop in the browser (owner mode: signed-in session; corporate: single-use link, 10 minutes)",
		)
		.argument("[sb]", "sandbox ID or slug")
		.option("--fps <n>", "30 or 60")
		.option("--bitrate <kbps>", "1000..20000")
		.option("--transport <t>", "auto, webrtc or websocket")
		.option("--print", "only print the link")
		// Kept from the first S10 pass; `desktop access` and `desktop end-streams` replace them.
		.addOption(hiddenOption(program, "--access <mode>"))
		.addOption(hiddenOption(program, "--end-streams"))
		.action(
			run(async (ctx, args, opts) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				if (opts.endStreams) {
					await sb.desktop.endStreams();
					ctx.out.result({ ended: true });
					return;
				}
				if (opts.access !== undefined) {
					ctx.out.result(await sb.desktop.setAccess(access(opts.access)));
					return;
				}
				const fps = opts.fps === undefined ? undefined : int(opts.fps, "fps");
				if (fps !== undefined && fps !== 30 && fps !== 60)
					throw usageError("fps must be 30 or 60");
				const transport = opts.transport as string | undefined;
				if (
					transport !== undefined &&
					!["auto", "webrtc", "websocket"].includes(transport)
				)
					throw usageError("transport must be auto, webrtc or websocket");
				const link = await sb.desktop.link({
					...(fps !== undefined ? { fps } : {}),
					...(opts.bitrate !== undefined
						? { bitrateKbps: int(opts.bitrate, "bitrate") }
						: {}),
					...(transport !== undefined
						? { transport: transport as "auto" | "webrtc" | "websocket" }
						: {}),
				});
				if (!opts.print && !ctx.out.json) openBrowser(link.url);
				ctx.out.result(link, (result) => result.url);
			}),
		);

	const screenshot = (cmd: Command) =>
		cmd
			.description("capture the desktop as PNG or JPEG")
			.argument("[sb]", "sandbox ID or slug")
			.option(
				"-o, --output <path>",
				"write the image to a file; - means stdout",
				"-",
			)
			.option("--max-width <n>", "scale down to at most this width")
			.option("--max-height <n>", "scale down to at most this height")
			.option("--jpeg", "JPEG instead of PNG")
			.option("--quality <n>", "JPEG quality 1..100")
			.action(
				run(
					async (ctx, args, opts) => {
						const sb = await useSandbox(ctx, args[0] as string | undefined);
						const shot = await sb.desktop.screenshot({
							format: opts.jpeg ? "jpeg" : "png",
							...(opts.quality !== undefined
								? { quality: int(opts.quality, "quality") }
								: {}),
							...(opts.maxWidth !== undefined
								? { maxWidth: int(opts.maxWidth, "max-width") }
								: {}),
							...(opts.maxHeight !== undefined
								? { maxHeight: int(opts.maxHeight, "max-height") }
								: {}),
						});
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
	screenshot(desktop.command("screenshot"));
	screenshot(program.command("screenshot", { hidden: true }));

	const act = async (
		ctx: Context,
		ref: string,
		file: string | undefined,
		words: string[],
	) => {
		const sb = await useSandbox(ctx, ref);
		let body: DesktopActions;
		if (file !== undefined) {
			if (words.length) throw usageError("use either --file or a short form");
			try {
				body = JSON.parse(
					file === "-" ? await readStdin(ctx) : await readFile(file, "utf8"),
				) as DesktopActions;
			} catch {
				throw usageError("the actions must be valid JSON");
			}
		} else body = { actions: [shortAction(words)] };
		ctx.out.result(await sb.desktop.act(body));
	};
	desktop
		.command("act")
		.description(
			"run desktop actions from JSON, or one short form: click X Y, type TEXT, key ctrl+c, scroll DY",
		)
		.argument("<sb>", "sandbox ID or slug")
		.argument("[action...]", "short form")
		// Spec 14.2 named it --json; the global --json is the output format.
		.option(
			"-f, --file <path|->",
			"JSON object with actions and optional coordinateSpace/screenshot; - reads stdin",
		)
		.action(
			run(async (ctx, args, opts) =>
				act(
					ctx,
					args[0] as string,
					opts.file as string | undefined,
					(args[1] as string[] | undefined) ?? [],
				),
			),
		);
	program
		.command("input", { hidden: true })
		.argument("<sb>", "sandbox ID or slug")
		.requiredOption("--file <path>", "JSON actions")
		.action(
			run(async (ctx, args, opts) =>
				act(ctx, args[0] as string, String(opts.file), []),
			),
		);

	const clipboard = async (
		ctx: Context,
		ref: string | undefined,
		text: string | undefined,
	) => {
		const sb = await useSandbox(ctx, ref);
		if (text !== undefined) {
			await sb.desktop.clipboardSet(text);
			ctx.out.result({ written: true });
		} else
			ctx.out.result(await sb.desktop.clipboardGet(), (result) => result.text);
	};
	desktop
		.command("clipboard")
		.description("read (get) or set desktop clipboard text")
		.argument("<sb>", "sandbox ID or slug")
		.argument("[op]", "get (default) or set")
		.argument("[text...]", "the text to set")
		.action(
			run(async (ctx, args) => {
				const op = (args[1] as string | undefined) ?? "get";
				const text = ((args[2] as string[] | undefined) ?? []).join(" ");
				if (op === "get" && text === "")
					return clipboard(ctx, args[0] as string, undefined);
				if (op === "set") return clipboard(ctx, args[0] as string, text);
				throw usageError("usage: desktop clipboard <sb> [get|set TEXT]");
			}),
		);
	program
		.command("clipboard", { hidden: true })
		.argument("[sb]", "sandbox ID or slug")
		.option("--text <text>", "set UTF-8 text")
		.action(
			run(async (ctx, args, opts) =>
				clipboard(
					ctx,
					args[0] as string | undefined,
					opts.text === undefined ? undefined : String(opts.text),
				),
			),
		);

	desktop
		.command("access")
		.description("set desktop access: token, sso or public")
		.argument("<sb>", "sandbox ID or slug")
		.argument("<mode>", "token, sso or public")
		.action(
			run(async (ctx, args) => {
				const sb = await useSandbox(ctx, args[0] as string);
				ctx.out.result(await sb.desktop.setAccess(access(args[1])));
			}),
		);
	desktop
		.command("end-streams")
		.description("disconnect all viewers and revoke desktop cookies")
		.argument("[sb]", "sandbox ID or slug")
		.action(
			run(async (ctx, args) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				await sb.desktop.endStreams();
				ctx.out.result({ ended: true });
			}),
		);
}

function hiddenOption(program: Command, flags: string) {
	return program.createOption(flags).hideHelp();
}
