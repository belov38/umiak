// `sbx mcp`: the MCP server over stdio (S11 §6.1, §8.8, §10.2). stdout
// carries only JSON-RPC: the runner's protocol mode keeps every error on
// stderr (even with --json), and logs go to stderr or --log-file. The
// server starts without a login (tools/list works) and every tool call then
// answers `not_logged_in`; the config is read again on the next call (also
// after an API 401 to a stored key), so `sbx login` in a terminal is
// enough. The process ends (exit 0) when the client closes stdin.

import {
	apiCallLogger,
	createLogger,
	MCP_VERSION,
	parseToolsets,
	runStdio,
	type Toolset,
} from "@sbx/mcp";
import { Sbx, SbxError } from "@sbx/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { sandboxIdOfUuid } from "../current.ts";
import {
	EXIT_OK,
	LOGIN_REQUIRED,
	NOT_LOGGED_IN,
	usageError,
} from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import { mcpCredentials } from "./mcp-auth.ts";

const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
];

/** CLI errors that mean "log in first". */
const LOGIN_CODES = new Set([NOT_LOGGED_IN, LOGIN_REQUIRED, "no_api_url"]);

/** A sandbox ref given to --sandbox: an id or a slug, no spaces. */
const SANDBOX_REF = /^\S{1,128}$/;

interface McpOptions {
	toolsets?: string;
	readOnly?: boolean;
	sandbox?: string;
	logLevel?: string;
	logFile?: string;
}

interface Settings {
	toolsets?: Toolset[];
	readOnly: boolean;
	pinnedSandbox?: string;
	logLevel: string;
	logFile?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

/** Flags and env of the command; usage error (exit 2) on a bad value. */
function settingsOf(ctx: Context, o: McpOptions): Settings {
	const logLevel = o.logLevel ?? "info";
	const s: Settings = {
		readOnly:
			o.readOnly === true ||
			["1", "true"].includes(ctx.env.SBX_MCP_READ_ONLY ?? ""),
		logLevel,
	};
	const csv = o.toolsets ?? nonEmpty(ctx.env.SBX_MCP_TOOLSETS);
	if (csv !== undefined) {
		try {
			s.toolsets = parseToolsets(csv);
		} catch (err) {
			throw usageError(`--toolsets: ${(err as Error).message}`);
		}
	}
	if (o.sandbox !== undefined) s.pinnedSandbox = pinnedSandbox(ctx, o.sandbox);
	if (!LOG_LEVELS.includes(logLevel)) {
		throw usageError(
			`--log-level: unknown level ${JSON.stringify(logLevel)}; valid: ${LOG_LEVELS.join(", ")}`,
		);
	}
	if (o.logFile !== undefined) s.logFile = o.logFile;
	return s;
}

/** `self` is the sandbox this runs in (SBX_SANDBOX_ID, S7 §14.2). */
function pinnedSandbox(ctx: Context, ref: string): string {
	if (ref === "self") {
		const uuid = nonEmpty(ctx.env.SBX_SANDBOX_ID);
		if (uuid === undefined) {
			throw usageError(
				"--sandbox self: SBX_SANDBOX_ID is not set (it is set inside a sandbox); pass the sandbox ID or slug instead",
			);
		}
		const id = sandboxIdOfUuid(uuid);
		if (id === null) {
			throw usageError(
				`--sandbox self: SBX_SANDBOX_ID ${JSON.stringify(uuid)} is not a sandbox UUID`,
			);
		}
		return id;
	}
	if (!SANDBOX_REF.test(ref)) {
		throw usageError("--sandbox: expected a sandbox ID (sb_…) or slug");
	}
	return ref;
}

/**
 * A CLI login error as the tools report it: code not_logged_in (its hint
 * says to run `sbx login` in a terminal), the CLI's own reason as the
 * message (which profile, which API).
 */
function notLoggedIn(err: SbxError): SbxError {
	return new SbxError({
		status: 0,
		code: NOT_LOGGED_IN,
		message: err.message,
		retryable: false,
	});
}

/** The hint of an API 401 that a new token does not fix. */
export function unauthorizedHint(env: Record<string, string | undefined>) {
	return nonEmpty(env.SBX_API_KEY) === undefined
		? "run `sbx login` in a terminal, then retry."
		: "the API rejected SBX_API_KEY: fix SBX_API_KEY in the MCP client config and restart the MCP server.";
}

/**
 * The SDK client of the server, made on first use; without a login every
 * call fails with not_logged_in and the config is read again next time.
 */
function sbxFactory(
	ctx: Context,
	log: ReturnType<typeof createLogger>,
): () => Sbx {
	let sbx: Sbx | undefined;
	// Read the config and the credential store again on the next call.
	const forget = () => {
		ctx.reload();
		sbx = undefined;
	};
	const creds = mcpCredentials((force) => ctx.bearer(force), ctx.fetch, {
		// A revoked or expired key: a new `sbx login` must be picked up.
		onRejected: forget,
	});
	const loginError = (err: unknown): unknown => {
		if (!(err instanceof SbxError) || !LOGIN_CODES.has(err.code)) return err;
		forget();
		return notLoggedIn(err);
	};
	return () => {
		if (sbx !== undefined) return sbx;
		let baseUrl: string;
		let team: string | undefined;
		try {
			baseUrl = ctx.apiUrl();
			team = ctx.resolved.team;
		} catch (err) {
			throw loginError(err);
		}
		sbx = new Sbx({
			baseUrl,
			...(team === undefined ? {} : { team }),
			tokenProvider: async (o) => {
				try {
					return await creds.tokenProvider(o);
				} catch (err) {
					throw loginError(err);
				}
			},
			fetch: apiCallLogger(creds.fetch, log) as typeof fetch,
			userAgent: `sbx-mcp/${MCP_VERSION} (stdio)`,
			// Everything is resolved here; the SDK must not read SBX_* itself.
			env: {},
		});
		return sbx;
	};
}

async function serve(ctx: Context, o: McpOptions): Promise<number> {
	const s = settingsOf(ctx, o);
	const log = createLogger({
		level: s.logLevel,
		...(s.logFile === undefined ? {} : { destination: s.logFile }),
	});
	const server = await runStdio({
		sbx: sbxFactory(ctx, log),
		...(s.toolsets === undefined ? {} : { toolsets: s.toolsets }),
		readOnly: s.readOnly,
		unauthorizedHint: unauthorizedHint(ctx.env),
		...(s.pinnedSandbox === undefined
			? {}
			: { pinnedSandbox: s.pinnedSandbox }),
		log,
	});
	log.debug(
		{
			toolsets: s.toolsets ?? "all",
			readOnly: s.readOnly,
			sandbox: s.pinnedSandbox ?? null,
		},
		"sbx mcp serving on stdio",
	);
	await server.closed;
	log.debug("stdin closed, exiting");
	return EXIT_OK;
}

export function register(program: Command, run: Runner): void {
	program
		.command("mcp")
		.description(
			"MCP server over stdio for AI agents (Claude Code, Codex, Cursor, …)",
		)
		.option(
			"--toolsets <list>",
			"only these toolsets: core, files, ports, snapshots, desktop, comma separated (env SBX_MCP_TOOLSETS; default all)",
		)
		.option(
			"--read-only",
			"only tools that change nothing (env SBX_MCP_READ_ONLY=1)",
		)
		.option(
			"--sandbox <sb>",
			"bind every tool to one sandbox: ID, slug, or self (SBX_SANDBOX_ID inside a sandbox)",
		)
		.option(
			"--log-level <level>",
			"fatal, error, warn, info, debug (API calls), trace or silent",
			"info",
		)
		.option("--log-file <path>", "write logs to this file instead of stderr")
		.action(
			run(async (ctx, _args, opts) => serve(ctx, opts as McpOptions), {
				rawData: true,
				protocol: true,
			}),
		);
}
