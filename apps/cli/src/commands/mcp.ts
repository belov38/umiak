// `sbx mcp`: the MCP server over stdio belongs to S11 (S11 §6.1; S7 plan
// decision 12). Until then it says so and exits 1. stdout stays empty: an
// MCP client reads JSON-RPC there. S11 replaces this handler.

import type { Command } from "commander";
import { EXIT_ERROR } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("mcp")
		.description("MCP server over stdio (implemented by S11)")
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(
			run(
				async (ctx) => {
					ctx.out.info("sbx mcp: implemented by S11");
					return EXIT_ERROR;
				},
				{ rawData: true },
			),
		);
}
