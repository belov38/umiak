// `sbx auth token [--json]` (S7 §7.6): the bearer of the current profile for
// the SDK and MCP, refreshed when due, or exit 4. Without --json only the
// token is printed (stdout is data); --json prints
// {kind: "oidc" | "key", token, expiresAt, apiUrl, team}.

import type { Command } from "commander";
import type { Runner } from "../program.ts";

export interface AuthTokenJson {
	kind: "oidc" | "key";
	token: string;
	expiresAt: string | null;
	apiUrl: string;
	team: string | null;
}

export function register(program: Command, run: Runner): void {
	const auth = program
		.command("auth")
		.description("credentials of the CLI for other tools");
	auth
		.command("token")
		.description(
			"print the bearer of the profile (refreshed when due); --json adds kind, expiry, apiUrl and team",
		)
		.action(
			run(
				async (ctx) => {
					const apiUrl = ctx.apiUrl();
					const b = await ctx.bearer();
					if (ctx.out.jsonFlag) {
						const v: AuthTokenJson = {
							kind: b.kind,
							token: b.token,
							expiresAt: b.expiresAt,
							apiUrl,
							team: ctx.resolved.team ?? null,
						};
						ctx.out.result(v);
					} else {
						await ctx.out.data(`${b.token}\n`);
					}
				},
				{ rawData: true },
			),
		);
}
