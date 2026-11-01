// Published ports (S7 §11.2, §14.2):
// - `umiak port [<sb>] <port> [--token|--sso|--public] [--host-rewrite m]
//   [--app-protocol p]`: publishes the port (PUT; defaults token, preserve,
//   http1) and prints its URL, with `?_token=` when this call issued a token
//   (a new port in token mode, or a switch to it);
// - `umiak ports [<sb>]`: hosted and listening ports;
// - `umiak unport [<sb>] <port>`: unpublishes;
// - `umiak port-token [<sb>] <port>`: a new token (the old one stops at once);
//   prints the URL with it.
// With one positional, the sandbox is the current one.

import type { HostOptions, SandboxPorts } from "@umiak/sdk";
import type { Command } from "commander";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

/** `[<sb>] <port>` → the sandbox argument and the port number. */
function sbAndPort(args: unknown[]): { sb: string | undefined; port: number } {
	const [a, b] = args as [string, string | undefined];
	const [sb, raw] = b === undefined ? [undefined, a] : [a, b];
	const port = Number(raw);
	if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
		throw usageError(`the port must be 1-65535, not ${JSON.stringify(raw)}`);
	}
	return { sb, port };
}

function portsText(p: SandboxPorts): string {
	const hosted =
		p.hosted.length === 0
			? "no published ports"
			: table(
					["PORT", "ACCESS", "URL"],
					p.hosted.map((h) => [
						String(h.port),
						h.blocked ? `${h.access} (blocked)` : h.access,
						h.url,
					]),
				);
	if (p.listening.length === 0) return hosted;
	const listening = table(
		["LISTENING", "PROCESS", "ADDRESSES"],
		p.listening.map((l) => [
			String(l.port),
			l.process ?? null,
			(l.addresses ?? []).join(","),
		]),
	);
	return `${hosted}\n\n${listening}`;
}

export function register(program: Command, run: Runner): void {
	program
		.command("port")
		.description("publish a port of a sandbox and print its URL")
		.argument(
			"<sb-or-port>",
			"sandbox ID or slug, or the port (current sandbox)",
		)
		.argument("[port]", "port number")
		.option("--token", "access with a token in the URL (the default)")
		.option("--sso", "access for members of the team (login)")
		.option("--public", "access for anyone")
		.option(
			"--host-rewrite <mode>",
			"preserve (default) or localhost: the Host header the app sees",
		)
		.option("--app-protocol <p>", "http1 (default) or h2c")
		.action(
			run(async (ctx, args, opts) => {
				const { sb: ref, port } = sbAndPort(args);
				const modes = (["token", "sso", "public"] as const).filter(
					(m) => opts[m] === true,
				);
				if (modes.length > 1) {
					throw usageError("give one of --token, --sso and --public");
				}
				const o: HostOptions = {};
				if (modes[0] !== undefined) o.access = modes[0];
				if (opts.hostRewrite !== undefined) {
					o.hostRewrite = opts.hostRewrite as "preserve" | "localhost";
				}
				if (opts.appProtocol !== undefined) {
					o.appProtocol = opts.appProtocol as "http1" | "h2c";
				}
				const sb = await useSandbox(ctx, ref);
				const p = await sb.ports.host(port, o);
				ctx.out.result(p, (v) => v.urlWithToken ?? v.url);
			}),
		);

	program
		.command("ports")
		.description("list the published and listening ports of a sandbox")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.action(
			run(async (ctx, args) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				ctx.out.result(await sb.ports.list(), portsText);
			}),
		);

	program
		.command("unport")
		.description("unpublish a port of a sandbox")
		.argument(
			"<sb-or-port>",
			"sandbox ID or slug, or the port (current sandbox)",
		)
		.argument("[port]", "port number")
		.action(
			run(async (ctx, args) => {
				const { sb: ref, port } = sbAndPort(args);
				const sb = await useSandbox(ctx, ref);
				await sb.ports.unhost(port);
				ctx.out.result({ port, hosted: false }, () => "");
			}),
		);

	program
		.command("port-token")
		.description("issue a new token of a published port and print its URL")
		.argument(
			"<sb-or-port>",
			"sandbox ID or slug, or the port (current sandbox)",
		)
		.argument("[port]", "port number")
		.action(
			run(async (ctx, args) => {
				const { sb: ref, port } = sbAndPort(args);
				const sb = await useSandbox(ctx, ref);
				const t = await sb.ports.rotateToken(port);
				ctx.out.result(t, (v) => v.urlWithToken);
			}),
		);
}
