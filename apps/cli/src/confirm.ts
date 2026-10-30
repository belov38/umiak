// Confirmation of a destructive command (`rm`, `snapshot rm`; S7 §5.12,
// §14.2): --yes, or a "y" typed in a terminal. Without a terminal and
// without --yes it is a usage error (exit 2) and nothing is deleted.

import type { Context } from "./context.ts";
import { CliError, EXIT_ERROR, usageError } from "./exit-codes.ts";
import { readLine } from "./io.ts";

export async function confirm(
	ctx: Context,
	yes: boolean,
	question: string,
): Promise<void> {
	if (yes) return;
	if (!ctx.interactive) {
		throw usageError(
			"not a terminal: confirm with --yes (the deletion cannot be undone)",
		);
	}
	ctx.out.prompt(`${question} [y/N] `);
	const answer = (await readLine(ctx.stdin)) ?? "";
	if (!/^y(es)?$/i.test(answer.trim())) {
		throw new CliError({
			code: "aborted",
			message: "not confirmed; nothing was deleted",
			retryable: false,
			exitCode: EXIT_ERROR,
		});
	}
}
