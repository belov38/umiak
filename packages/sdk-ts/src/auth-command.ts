// Runs `sbx auth token --json` (Node and Bun only). The child_process module
// is taken from `process.getBuiltinModule` at call time, not imported, so the
// SDK has no `node:` import a browser bundler would try to resolve. In a
// browser (or any runtime without getBuiltinModule) there is no `sbx`:
// pass apiKey, accessToken or tokenProvider explicitly.

import type * as ChildProcess from "node:child_process";
import { AUTH_COMMAND_FAILED, NO_CREDENTIALS, SbxError } from "./errors.ts";
import { builtinModule } from "./node.ts";

const TIMEOUT_MS = 30_000;
/** `sbx` exit code for "no permission or not logged in" (S7 §14.3). */
const EXIT_NO_LOGIN = 4;

/** Whether `sbx auth token` can be run here (a runtime with child_process). */
export function canRunAuthCommand(): boolean {
	return builtinModule<typeof ChildProcess>("node:child_process") !== undefined;
}

/** Returns stdout of the command; throws SbxError when it gives no token. */
export function runAuthCommand(
	cmd: readonly string[],
	env: Record<string, string | undefined>,
	timeoutMs = TIMEOUT_MS,
): Promise<string> {
	const [file, ...args] = cmd;
	const cp = builtinModule<typeof ChildProcess>("node:child_process");
	if (file === undefined || cp === undefined) {
		return Promise.reject(
			new SbxError({
				status: 0,
				code: file === undefined ? AUTH_COMMAND_FAILED : NO_CREDENTIALS,
				message:
					file === undefined
						? "authCommand is empty"
						: "no credentials: this runtime cannot run `sbx`; pass apiKey, accessToken or tokenProvider",
				retryable: false,
			}),
		);
	}
	const shown = cmd.join(" ");
	return new Promise((resolve, reject) => {
		cp.execFile(
			file,
			args,
			{
				env,
				timeout: timeoutMs,
				// A command that ignores SIGTERM must not outlive the timeout.
				killSignal: "SIGKILL",
				maxBuffer: 1 << 20,
				windowsHide: true,
				encoding: "utf8",
			},
			(err, stdout, stderr) => {
				if (!err) {
					resolve(stdout);
					return;
				}
				const said = stderr.trim();
				if (err.code === "ENOENT") {
					reject(
						new SbxError({
							status: 0,
							code: NO_CREDENTIALS,
							message: `no credentials: no explicit credentials, no SBX_API_KEY or SBX_ACCESS_TOKEN, and \`${file}\` is not in PATH`,
							retryable: false,
						}),
					);
					return;
				}
				if (err.killed) {
					reject(
						new SbxError({
							status: 0,
							code: AUTH_COMMAND_FAILED,
							message: `\`${shown}\` timed out after ${timeoutMs} ms`,
							retryable: false,
							cause: err,
						}),
					);
					return;
				}
				const noLogin = err.code === EXIT_NO_LOGIN;
				reject(
					new SbxError({
						status: 0,
						code: noLogin ? NO_CREDENTIALS : AUTH_COMMAND_FAILED,
						message: noLogin
							? `no credentials: \`${shown}\` exited 4${said ? `: ${said}` : ""}; run \`sbx login\``
							: `\`${shown}\` failed: ${said || err.message}`,
						retryable: false,
						cause: err,
					}),
				);
			},
		);
	});
}
