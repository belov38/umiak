import { register as registerDesktop } from "./commands/desktop.ts";
// The `sbx` program: commander tree, global options, and the runner that
// turns a command's result or error into output and an exit code.
//
// A command module exports `register(program, run)` and wraps its handler
// with `run(handler, meta)`:
//
//   program.command("whoami").description("…").action(
//     run(async (ctx) => { ctx.out.result(await ctx.sbx().me()); }),
//   );
//
// A handler returns an exit code, or anything else for 0; a thrown error is
// printed by Output.error and mapped by exitCodeOf.

import { Command, CommanderError } from "commander";
import type { SecretsBackend } from "./auth/keychain.ts";
import { register as registerAuthToken } from "./commands/auth-token.ts";
import { register as registerCatalog } from "./commands/catalog.ts";
import { register as registerCompletion } from "./commands/completion.ts";
import { register as registerCp } from "./commands/cp.ts";
import { register as registerCreate } from "./commands/create.ts";
import { register as registerCurrent } from "./commands/current.ts";
import { register as registerEnv } from "./commands/env.ts";
import { register as registerEnvSets } from "./commands/env-sets.ts";
import { register as registerExec } from "./commands/exec.ts";
import { register as registerExtend } from "./commands/extend.ts";
import { register as registerInfo } from "./commands/info.ts";
import { register as registerKeys } from "./commands/keys.ts";
import { register as registerKill } from "./commands/kill.ts";
import { register as registerLabel } from "./commands/label.ts";
import { register as registerLifecycle } from "./commands/lifecycle.ts";
import { register as registerList } from "./commands/list.ts";
import { register as registerLogin } from "./commands/login.ts";
import { register as registerLogout } from "./commands/logout.ts";
import { register as registerLogs } from "./commands/logs.ts";
import { register as registerMcp } from "./commands/mcp.ts";
import { register as registerPort } from "./commands/port.ts";
import { register as registerPs } from "./commands/ps.ts";
import { register as registerPush } from "./commands/push.ts";
import { register as registerRename } from "./commands/rename.ts";
import { register as registerRm } from "./commands/rm.ts";
import { register as registerRun } from "./commands/run.ts";
import { register as registerShell } from "./commands/shell.ts";
import { register as registerSnapshot } from "./commands/snapshot.ts";
import { register as registerSsh } from "./commands/ssh.ts";
import { register as registerSshCert } from "./commands/ssh-cert.ts";
import { register as registerSshConfig } from "./commands/ssh-config.ts";
import { register as registerSshKeys } from "./commands/ssh-keys.ts";
import {
	CLI_VERSION,
	register as registerVersion,
} from "./commands/version.ts";
import { register as registerWhoami } from "./commands/whoami.ts";
import type { Env } from "./config.ts";
import { Context } from "./context.ts";
import { EXIT_OK, EXIT_USAGE, exitCodeOf, usageError } from "./exit-codes.ts";
import {
	EXIT_BROKEN_PIPE,
	Output,
	OutputClosedError,
	outputMode,
	type Writer,
} from "./output.ts";
import type { GlobalOptions } from "./profile.ts";

export interface CommandMeta {
	/** stdout carries the command's data (errors go to stderr without --json). */
	rawData?: boolean;
	/** stdout carries a protocol (`sbx mcp`: JSON-RPC): errors go to stderr even with --json. */
	protocol?: boolean;
}

export type Handler = (
	ctx: Context,
	args: unknown[],
	opts: Record<string, unknown>,
) => Promise<unknown>;

/** Wraps a handler as a commander action. */
export type Runner = (
	fn: Handler,
	meta?: CommandMeta,
) => (...a: unknown[]) => Promise<void>;

export interface CliIo {
	argv: readonly string[];
	env: Env;
	stdout: Writer;
	stderr: Writer;
	stdin: NodeJS.ReadableStream;
	/** stdout is a terminal. */
	isTTY: boolean;
	/** stdin and stderr are a terminal: prompts (`rm`) can be answered. */
	interactive?: boolean;
	/** Keychain backend; default Bun.secrets. */
	secrets?: SecretsBackend | undefined;
}

/** Actions made by a Runner with `rawData`, so their command is marked. */
const rawActions = new WeakSet<object>();
/** Actions made by a Runner with `protocol`. */
const protocolActions = new WeakSet<object>();

/**
 * A command that knows whether its stdout is data (`rawData` of its
 * action): decided before its options are parsed, so even a usage error
 * of `sbx exec --bogus > f` keeps the data stream clean.
 */
class SbxCommand extends Command {
	rawData = false;
	protocol = false;

	override createCommand(name?: string): Command {
		return new SbxCommand(name);
	}

	override action(fn: Parameters<Command["action"]>[0]): this {
		if (rawActions.has(fn)) this.rawData = true;
		if (protocolActions.has(fn)) this.protocol = true;
		return super.action(fn);
	}
}

/** Builds the command tree; `run` wraps the handlers. */
export function buildProgram(io: CliIo, run: Runner): Command {
	const program = new SbxCommand("sbx")
		.description("sbx: VM sandboxes for AI agents")
		.version(CLI_VERSION, "-V, --version", "print the CLI version")
		.option("--json", "print JSON (the default when stdout is not a terminal)")
		.option(
			"--human",
			"print text for a person, even when stdout is not a terminal",
		)
		.option("--profile <name>", "profile of config.json (env SBX_PROFILE)")
		.option("--api-url <url>", "API URL (env SBX_API_URL)")
		.option("--team <team>", "team (team_…) to act in (env SBX_TEAM)")
		.option(
			"--cacert <file>",
			"PEM file of a private CA for HTTPS; trusted: Node's bundled roots plus this file, not the OS store (env SBX_CA_FILE)",
		)
		.option(
			"--credential-store <store>",
			"keychain, file or auto (env SBX_CREDENTIAL_STORE)",
		)
		.showSuggestionAfterError(true)
		.configureHelp({ showGlobalOptions: true })
		.configureOutput({
			writeOut: (s) => void io.stdout.write(s),
			writeErr: (s) => void io.stderr.write(s),
			// Usage errors are printed by Output (JSON in JSON mode).
			outputError: () => {},
		});
	program.exitOverride();
	registerLogin(program, run);
	registerLogout(program, run);
	registerWhoami(program, run);
	registerAuthToken(program, run);
	registerCreate(program, run);
	registerList(program, run);
	registerInfo(program, run);
	registerLifecycle(program, run);
	registerRm(program, run);
	registerCurrent(program, run);
	registerRename(program, run);
	registerExtend(program, run);
	registerLabel(program, run);
	registerEnv(program, run);
	registerExec(program, run);
	registerLogs(program, run);
	registerKill(program, run);
	registerPs(program, run);
	registerShell(program, run);
	registerSsh(program, run);
	registerSshConfig(program, run);
	registerSshCert(program, run);
	registerSshKeys(program, run);
	registerCp(program, run);
	registerPush(program, run);
	registerPort(program, run);
	registerDesktop(program, run);
	registerRun(program, run);
	registerSnapshot(program, run);
	registerCatalog(program, run);
	registerKeys(program, run);
	registerEnvSets(program, run);
	registerVersion(program, run);
	registerCompletion(program, run);
	registerMcp(program, run);
	for (const c of allCommands(program)) c.exitOverride();
	return program;
}

export function allCommands(c: Command): Command[] {
	return [c, ...c.commands.flatMap(allCommands)];
}

/** Runs `sbx` with these arguments; resolves to the exit code. */
export async function runCli(io: CliIo): Promise<number> {
	const mode = outputMode(io.argv, io.env);
	const out = new Output({
		stdout: io.stdout,
		stderr: io.stderr,
		isTTY: io.isTTY,
		...mode,
	});
	let code = EXIT_OK;
	const run: Runner = (fn, meta = {}) => {
		const action = async (...a: unknown[]) => {
			const cmd = a.at(-1) as Command;
			const opts = (a.at(-2) ?? {}) as Record<string, unknown>;
			out.rawData = meta.rawData === true;
			out.protocol = meta.protocol === true;
			try {
				const ctx = new Context({
					out,
					env: io.env,
					globals: cmd.optsWithGlobals<GlobalOptions>(),
					stdin: io.stdin,
					interactive: io.interactive === true,
					argv: io.argv,
					...("secrets" in io ? { secrets: io.secrets } : {}),
				});
				const r = await fn(ctx, a.slice(0, -2), opts);
				code = typeof r === "number" ? r : EXIT_OK;
			} catch (err) {
				if (err instanceof OutputClosedError) {
					// The reader of stdout left (`| head`): quiet, like SIGPIPE.
					code = EXIT_BROKEN_PIPE;
					return;
				}
				out.error(err);
				code = exitCodeOf(err);
			}
		};
		if (meta.rawData === true) rawActions.add(action);
		if (meta.protocol === true) protocolActions.add(action);
		return action;
	};
	const program = buildProgram(io, run);
	// Before a subcommand parses its options (a usage error comes from there).
	for (const c of allCommands(program)) {
		c.hook("preSubcommand", (_parent, sub) => {
			out.rawData = sub instanceof SbxCommand && sub.rawData;
			out.protocol = sub instanceof SbxCommand && sub.protocol;
		});
	}
	try {
		await program.parseAsync([...io.argv], { from: "user" });
	} catch (err) {
		if (!(err instanceof CommanderError)) {
			out.error(err);
			return exitCodeOf(err);
		}
		if (
			err.code === "commander.helpDisplayed" ||
			err.code === "commander.version"
		) {
			return EXIT_OK;
		}
		if (err.code === "commander.help") {
			return EXIT_USAGE;
		}
		out.error(usageError(err.message.replace(/^error: /, "")));
		return EXIT_USAGE;
	}
	return code;
}
