// `umiak templates`, `umiak sizes`, `umiak limits` (S7 §13): the catalog and the
// team's quota, as the API returns them.

import type { Command } from "commander";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";
import { deploymentTenancy, presentAccount } from "../tenancy.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("templates")
		.description("list the templates")
		.action(
			run(async (ctx) => {
				const { data } = await ctx.umiak().raw.GET("/v1/templates");
				ctx.out.result(data, (v) =>
					table(
						["SLUG", "NAME", "OS", "DEFAULT SIZE", "SIZES", "VERSION"],
						v.data.map((t) => [
							t.slug,
							t.name,
							t.os,
							t.defaultSize,
							t.allowedSizes.join(","),
							t.version,
						]),
					),
				);
			}),
		);

	program
		.command("sizes")
		.description("list the sizes")
		.action(
			run(async (ctx) => {
				const { data } = await ctx.umiak().raw.GET("/v1/sizes");
				ctx.out.result(data, (v) =>
					table(
						["SLUG", "VCPU", "MEMORY MB"],
						v.data.map((s) => [s.slug, String(s.vcpu), String(s.memoryMb)]),
					),
				);
			}),
		);

	program
		.command("limits")
		.description("show the quota of the team, its usage and what it can create")
		.action(
			run(async (ctx) => {
				const tenancy = await deploymentTenancy(ctx);
				const { data } = await ctx.umiak().raw.GET("/v1/limits");
				ctx.out.result(presentAccount(data, tenancy), (v) =>
					[
						`can create: ${v.canCreate ? "yes" : "no"}`,
						table(
							["", "ACTIVE SANDBOXES", "RAM MB", "SAVED SNAPSHOTS"],
							(["quota", "usage", "remaining"] as const).map((k) => {
								const q =
									k === "quota"
										? [
												v.quota.maxActiveSandboxes,
												v.quota.maxRamMb,
												v.quota.maxSavedSnapshots,
											]
										: [v[k].activeSandboxes, v[k].ramMb, v[k].savedSnapshots];
								return [k, ...q.map(String)];
							}),
						),
					].join("\n"),
				);
			}),
		);
}
