// `sbx whoami`: GET /v1/me.

import type { components } from "@sbx/sdk";
import type { Command } from "commander";
import type { Runner } from "../program.ts";

export type Me = components["schemas"]["Me"];

/** One line: who, in which team, with which credential. */
export function humanMe(me: Me): string {
	const who =
		me.user === null
			? "team key"
			: `${me.user.email}${me.user.name ? ` (${me.user.name})` : ""}`;
	const role = me.team.role ? `, ${me.team.role}` : "";
	return `${who} in team ${me.team.name} (${me.team.id}${role}); auth: ${me.auth.kind}`;
}

export function register(program: Command, run: Runner): void {
	program
		.command("whoami")
		.description("show the caller: person or team key, team, scopes")
		.action(
			run(async (ctx) => {
				ctx.out.result(await ctx.sbx().me(), humanMe);
			}),
		);
}
