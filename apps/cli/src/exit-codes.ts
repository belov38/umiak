// Exit codes of `sbx` (S7 §14.3), the same in a terminal and in JSON mode.
// `exec` and `run` exit with the command's own code instead (128 + n for a
// signal, 124 for timed_out, 125 for lost or failed_to_start; Task 21).

import {
	type ExitEvent,
	SbxError,
	type SbxErrorInit,
	UNEXPECTED_RESPONSE,
} from "@sbx/sdk";

export const EXIT_OK = 0;
/** An API or CLI error. */
export const EXIT_ERROR = 1;
/** Wrong arguments. */
export const EXIT_USAGE = 2;
/** Not found. */
export const EXIT_NOT_FOUND = 3;
/** No permission, or not logged in. */
export const EXIT_NO_AUTH = 4;
/** A temporary error (retryable) after the retries ran out. */
export const EXIT_TEMPORARY = 75;

/** Codes of the CLI itself (no API answer; `requestId: null`). */
export const USAGE = "usage";
/** No credentials for the profile: `sbx login` or SBX_API_KEY. */
export const NOT_LOGGED_IN = "not_logged_in";
/** Keycloak refused the refresh token (`invalid_grant`): log in again. */
export const LOGIN_REQUIRED = "login_required";
/** The device code expired or the person denied the login. */
export const LOGIN_FAILED = "login_failed";
/** No current sandbox in this shell, or it was deleted. */
export const NO_CURRENT_SANDBOX = "no_current_sandbox";
export const NOT_IMPLEMENTED = "not_implemented";

/** Exit code of `exec`/`run` for a command that timed out (like timeout(1)). */
export const EXIT_TIMED_OUT = 124;
/** Exit code of `exec`/`run` for a command lost or never started. */
export const EXIT_LOST = 125;

const NO_AUTH_CODES = new Set([
	NOT_LOGGED_IN,
	"user_required",
	LOGIN_REQUIRED,
	LOGIN_FAILED,
	"no_credentials",
	"no_api_url",
	"unauthorized",
	"token_expired",
	"api_key_expired",
	"forbidden",
	"team_forbidden",
	"path_forbidden",
	"origin_forbidden",
]);

export interface CliErrorInit extends Omit<SbxErrorInit, "status"> {
	status?: number;
	/** Overrides the exit code derived from the code. */
	exitCode?: number;
}

/**
 * An error of the CLI. It is an SbxError, so it passes through the SDK
 * unchanged when thrown from a tokenProvider.
 */
export class CliError extends SbxError {
	readonly exitCode: number | undefined;
	constructor(init: CliErrorInit) {
		super({ status: 0, ...init });
		this.name = "CliError";
		this.exitCode = init.exitCode;
	}
}

export function usageError(message: string): CliError {
	return new CliError({
		code: USAGE,
		message,
		retryable: false,
		exitCode: EXIT_USAGE,
	});
}

/** The exit code for an error (S7 §14.3). */
export function exitCodeOf(err: unknown): number {
	if (err instanceof CliError && err.exitCode !== undefined)
		return err.exitCode;
	if (!(err instanceof SbxError)) return EXIT_ERROR;
	if (err.code === USAGE || err.code === "validation") return EXIT_USAGE;
	if (NO_AUTH_CODES.has(err.code) || err.status === 401) return EXIT_NO_AUTH;
	if (err.status === 403 && err.code !== "quota_exceeded") return EXIT_NO_AUTH;
	if (
		err.status === 404 ||
		err.code === "not_found" ||
		err.code === NO_CURRENT_SANDBOX ||
		err.code.endsWith("_not_found")
	) {
		return EXIT_NOT_FOUND;
	}
	if (err.retryable) return EXIT_TEMPORARY;
	// A proxy's 502/503/504/429 without the API envelope is temporary too.
	if (
		err.code === UNEXPECTED_RESPONSE &&
		[429, 502, 503, 504].includes(err.status)
	) {
		return EXIT_TEMPORARY;
	}
	return EXIT_ERROR;
}

/**
 * Linux signal numbers (the guest's, whatever OS runs the CLI: macOS has
 * SIGUSR1 = 30, Linux 10). Windows guests report the same names.
 */
const LINUX_SIGNALS: Readonly<Record<string, number>> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
	SIGSTKFLT: 16,
	SIGCHLD: 17,
	SIGCONT: 18,
	SIGSTOP: 19,
	SIGTSTP: 20,
	SIGTTIN: 21,
	SIGTTOU: 22,
	SIGURG: 23,
	SIGXCPU: 24,
	SIGXFSZ: 25,
	SIGVTALRM: 26,
	SIGPROF: 27,
	SIGWINCH: 28,
	SIGIO: 29,
	SIGPWR: 30,
	SIGSYS: 31,
};

/**
 * The exit code of `exec`/`run` for the command's exit (S7 §14.3): its own
 * code; 128 + n (Linux numbering) for a signal; an unknown signal name keeps
 * the agent's code when it is one of a signal (> 128), else 137 (SIGKILL);
 * 124 timed out; 125 lost or failed to start.
 */
export function commandExitCode(exit: ExitEvent): number {
	switch (exit.status) {
		case "exited":
			return exit.exitCode ?? EXIT_ERROR;
		case "killed": {
			const name = exit.signal?.toUpperCase();
			const n =
				name === undefined
					? undefined
					: LINUX_SIGNALS[name.startsWith("SIG") ? name : `SIG${name}`];
			if (n !== undefined) return 128 + n;
			return exit.exitCode !== null && exit.exitCode > 128
				? exit.exitCode
				: 128 + 9;
		}
		case "timed_out":
			return EXIT_TIMED_OUT;
		case "lost":
		case "failed_to_start":
			return EXIT_LOST;
		default:
			return exit.exitCode ?? EXIT_ERROR;
	}
}
