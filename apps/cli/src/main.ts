#!/usr/bin/env bun
// Entry point of `sbx` (Bun). SBX_TTY=1|0 overrides the terminal check of
// stdout (tests).

import { runCli } from "./program.ts";

function stdoutIsTTY(): boolean {
	const v = process.env.SBX_TTY;
	if (v === "1") return true;
	if (v === "0") return false;
	return process.stdout.isTTY === true;
}

process.exitCode = await runCli({
	argv: process.argv.slice(2),
	env: process.env,
	stdout: process.stdout,
	stderr: process.stderr,
	stdin: process.stdin,
	isTTY: stdoutIsTTY(),
});
