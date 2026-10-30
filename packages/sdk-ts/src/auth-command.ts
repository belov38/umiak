// Runs `sbx auth token --json` (Node and Bun only). Imported lazily by
// credentials.ts, so the core client has no Node-only imports.

import { execFile } from "node:child_process";
import { AUTH_COMMAND_FAILED, NO_CREDENTIALS, SbxError } from "./errors.ts";

const TIMEOUT_MS = 30_000;
/** `sbx` exit code for "no permission or not logged in" (S7 §14.3). */
const EXIT_NO_LOGIN = 4;

/** Returns stdout of the command; throws SbxError when it gives no token. */
export function runAuthCommand(
	cmd: readonly string[],
	env: Record<string, string | undefined>,
): Promise<string> {
	const [file, ...args] = cmd;
	if (file === undefined) {
		return Promise.reject(
			new SbxError({
				status: 0,
				code: AUTH_COMMAND_FAILED,
				message: "authCommand is empty",
				retryable: false,
			}),
		);
	}
	const shown = cmd.join(" ");
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				env,
				timeout: TIMEOUT_MS,
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
