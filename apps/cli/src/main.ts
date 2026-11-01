#!/usr/bin/env bun
// Entry point of `umiak` (Bun). UMIAK_TTY=1|0 overrides the terminal checks of
// stdout and of the prompts (stdin and stderr) (tests).

import { runCli } from "./program.ts";

function stdoutIsTTY(): boolean {
	const v = process.env.UMIAK_TTY;
	if (v === "1") return true;
	if (v === "0") return false;
	return process.stdout.isTTY === true;
}

function interactive(): boolean {
	const v = process.env.UMIAK_TTY;
	if (v === "1") return true;
	if (v === "0") return false;
	return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

process.exitCode = await runCli({
	argv: process.argv.slice(2),
	env: process.env,
	stdout: process.stdout,
	stderr: process.stderr,
	stdin: process.stdin,
	isTTY: stdoutIsTTY(),
	interactive: interactive(),
});
