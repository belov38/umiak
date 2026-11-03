// `umiak whoami`: GET /v1/me.

import type { components } from "@umiak/sdk";
import type { Command } from "commander";
import type { Runner } from "../program.ts";
import { deploymentTenancy, presentAccount } from "../tenancy.ts";

export type Me = components["schemas"]["Me"];

/** One line: who, in which team, with which credential. */
export function humanMe(me: Omit<Me, "team"> & { team?: Me["team"] }): string {
	const who =
		me.user === null
			? me.team
				? "team key"
				: "API key"
			: `${me.user.email}${me.user.name ? ` (${me.user.name})` : ""}`;
	if (!me.team)
		return `${who}; auth: ${me.auth.kind === "team_key" ? "API key" : me.auth.kind}`;
	const role = me.team.role ? `, ${me.team.role}` : "";
	return `${who} in team ${me.team.name} (${me.team.id}${role}); auth: ${me.auth.kind}`;
}

export function register(program: Command, run: Runner): void {
	program
		.command("whoami")
		.description("show the caller: person or team key, team, scopes")
		.action(
			run(async (ctx) => {
				const tenancy = await deploymentTenancy(ctx);
				ctx.out.result(
					presentAccount(await ctx.umiak().me(), tenancy),
					humanMe,
				);
			}),
		);
}
