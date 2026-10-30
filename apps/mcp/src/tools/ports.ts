// Port tools (S11 8.5, 11.4): port_expose, port_list, port_unexpose. Calls go
// through the SDK's no-fetch sandbox handle, so only the scopes of the table
// are needed: ports:write for changes, sandboxes:read for the list.
import type { HostedPort } from "@sbx/sdk";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { fenceUntrusted } from "../output/fence.ts";
import { prune, toolText } from "../output/result.ts";
import { defineTool } from "../registry.ts";

/** Fence labels are constants: nothing from the sandbox goes into them. */
const LABEL_PORTS = "kind=ports";

const portShape = z
	.number()
	.int()
	.min(1)
	.max(65_535)
	.describe("TCP port in the sandbox, 1-65535 (not 22)");

type Access = "sso" | "token" | "public";

/** hostRewrite and appProtocol of a port, as the API accepts them back (unknown values are dropped). */
function keptSettings(p: HostedPort): {
	hostRewrite?: "preserve" | "localhost";
	appProtocol?: "http1" | "h2c";
} {
	const out: {
		hostRewrite?: "preserve" | "localhost";
		appProtocol?: "http1" | "h2c";
	} = {};
	const rewrite: string = p.hostRewrite;
	if (rewrite === "preserve" || rewrite === "localhost") {
		out.hostRewrite = rewrite;
	}
	const protocol: string = p.appProtocol;
	if (protocol === "http1" || protocol === "h2c") out.appProtocol = protocol;
	return out;
}

const SECRET_LINE =
	"url_with_token is a secret: give it to the user, do not store it";

function hostedView(p: HostedPort): Record<string, unknown> {
	return {
		port: p.port,
		url: p.url,
		access: p.access,
		blocked: p.blocked,
		block_reason: p.blockReason,
	};
}

export const portExpose = defineTool({
	name: "port_expose",
	title: "Publish a port",
	description:
		"Publishes a sandbox TCP port at a public URL. Default access sso (a signed-in platform user opens it). Use token when a program needs the URL; public only if the user asks. A repeat without access changes nothing; rotate_token=true issues a new token link.",
	toolset: "ports",
	scopes: ["ports:write", "sandboxes:read"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	sandboxArg: true,
	shape: {
		port: portShape,
		access: z
			.enum(["sso", "token", "public"])
			.optional()
			.describe(
				"sso (default for a new port), token (secret link), public (anyone)",
			),
		rotate_token: z
			.boolean()
			.optional()
			.describe(
				"Issue a new token link (default false); the old links stop working",
			),
	},
	async handler(args, ctx) {
		const sb = ctx.sbx().sandboxes.handle(args.sandbox);
		const notes: string[] = [];

		// PUT replaces the settings and a changed mode ends the issued links, so
		// the current port is always read first (a 403 names sandboxes:read).
		const existing = (await sb.ports.list(ctx.call)).hosted.find(
			(p) => p.port === args.port,
		);

		// The mode to write; none when the port stays as it is. A mode this server
		// does not know is left alone unless the model names one.
		const wanted: Access | undefined =
			args.access ?? (existing === undefined ? "sso" : undefined);
		const mode: string = wanted ?? existing?.access ?? "sso";
		if (args.rotate_token === true && mode !== "token") {
			throw new ToolError({
				code: "validation",
				message: `port ${args.port} is not in token mode, so there is no token to rotate`,
				hint: "pass access=token to switch it to token mode (that issues a token), or drop rotate_token.",
			});
		}

		let port: HostedPort | undefined = existing;
		let status = "unchanged";
		let urlWithToken: string | undefined;
		if (
			wanted !== undefined &&
			(existing === undefined || wanted !== existing.access)
		) {
			const written = await sb.ports.host(args.port, {
				...ctx.call,
				access: wanted,
				// PUT is a full replacement: keep what the port already has.
				...(existing === undefined ? {} : keptSettings(existing)),
			});
			port = written;
			status = existing === undefined ? "created" : "access_changed";
			urlWithToken = written.urlWithToken;
		}
		if (args.rotate_token === true && urlWithToken === undefined) {
			urlWithToken = (await sb.ports.rotateToken(args.port, ctx.call))
				.urlWithToken;
			status = status === "unchanged" ? "token_rotated" : status;
		}
		if (port === undefined) throw new Error("port_expose: no port data");

		const header: Record<string, unknown> = { ...hostedView(port), status };
		if (urlWithToken !== undefined) {
			header.url_with_token = urlWithToken;
			notes.push(SECRET_LINE);
		} else if (port.access === "token") {
			notes.push(
				"the token is shown only when it is issued; call again with rotate_token=true for a new link (old links stop working)",
			);
		}
		if (port.blocked) {
			notes.push("an operator blocked this port; the gateway refuses it");
		}
		return toolText(header, notes.length > 0 ? [notes.join("\n")] : []);
	},
});

interface PortRow {
	port: number;
	process?: string;
	addresses?: string[];
	published: boolean;
	access?: string;
	url?: string;
	blocked?: true;
}

export const portList = defineTool({
	name: "port_list",
	title: "List ports",
	description:
		"Lists the ports of a sandbox: what listens (process, addresses) and what is published (access, url). Use it when a published URL does not open. A server on 127.0.0.1 only is fine: the gateway reaches loopback.",
	toolset: "ports",
	scopes: ["sandboxes:read"],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: {},
	async handler(args, ctx) {
		const sb = ctx.sbx().sandboxes.handle(args.sandbox);
		const data = await sb.ports.list(ctx.call);

		const rows = new Map<number, PortRow>();
		for (const h of data.hosted) {
			rows.set(h.port, {
				port: h.port,
				published: true,
				access: h.access,
				url: h.url,
				...(h.blocked ? { blocked: true as const } : {}),
			});
		}
		for (const l of data.listening) {
			const row = rows.get(l.port) ?? { port: l.port, published: false };
			row.process ??= l.process;
			row.addresses = [...new Set([...(row.addresses ?? []), ...l.addresses])];
			rows.set(l.port, row);
		}
		const sorted = [...rows.values()].sort((a, b) => a.port - b.port);

		const notes: string[] = [];
		if (sorted.length === 0) notes.push("no port is published or listening");
		const idle = sorted.filter((r) => r.published && r.process === undefined);
		if (idle.length > 0) {
			notes.push(
				`published but nothing listens: ${idle.map((r) => r.port).join(", ")}; start the server in the sandbox`,
			);
		}
		if (data.listeningObservedAt === null) {
			notes.push(
				"listening is the last stored report (the sandbox is not ready or its agent is unreachable)",
			);
		}
		// Process names and addresses come from the sandbox: fenced.
		const table =
			sorted.length === 0
				? []
				: [
						fenceUntrusted([
							{
								label: LABEL_PORTS,
								text: sorted
									.map((r) => JSON.stringify(prune({ ...r })))
									.join("\n"),
							},
						]),
					];
		return toolText({ count: sorted.length }, [
			...(notes.length > 0 ? [notes.join("\n")] : []),
			...table,
		]);
	},
});

export const portUnexpose = defineTool({
	name: "port_unexpose",
	title: "Unpublish a port",
	description:
		"Stops publishing a port: its URL and tokens stop working at once. Nothing changes inside the sandbox. Safe to repeat.",
	toolset: "ports",
	scopes: ["ports:write"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: { port: portShape },
	async handler(args, ctx) {
		await ctx
			.sbx()
			.sandboxes.handle(args.sandbox)
			.ports.unhost(args.port, ctx.call);
		return toolText({ port: args.port, published: false });
	},
});

export const PORT_TOOLS = [portExpose, portList, portUnexpose];
