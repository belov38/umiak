// `umiak keys list|create|rotate|rm` (S7 §7.2, §13): team API keys. create and
// rotate need an owner logged in with owner (`umiak login`): a team key
// cannot issue keys, so they stop before any request (`user_required`,
// exit 4). The secret is printed only by create and rotate.

import type { components } from "@umiak/sdk";
import type { Command } from "commander";
import { collect, parseDuration } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, usageError } from "../exit-codes.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

type KeySecret = components["schemas"]["ApiKeySecret"];
type Preset = "read-only" | "ci" | "full";
type Scope = NonNullable<
	components["schemas"]["CreateApiKeyRequest"]["scopes"]
>[number];

async function requirePerson(ctx: Context, what: string): Promise<void> {
	await ctx.bearer();
	if (ctx.resolved.profile?.auth === "owner") return;
	throw new CliError({
		code: "user_required",
		message: `${what} needs an owner logged in with owner (run: umiak login); a team key cannot issue keys`,
		retryable: false,
	});
}

function secretText(v: KeySecret): string {
	return [
		`Key ${v.apiKey.name} (${v.apiKey.id}), expires ${v.apiKey.expiresAt}`,
		`Secret (shown only now): ${v.secret}`,
	].join("\n");
}

export function register(program: Command, run: Runner): void {
	const keys = program.command("keys").description("team API keys");

	keys
		.command("list")
		.alias("ls")
		.description("list the keys of the team (revoked ones too)")
		.action(
			run(async (ctx) => {
				const { data } = await ctx.umiak().raw.GET("/v1/api-keys");
				ctx.out.result(data, (v) =>
					table(
						[
							"ID",
							"NAME",
							"PREFIX",
							"SCOPES",
							"EXPIRES",
							"LAST USED",
							"REVOKED",
						],
						v.data.map((k) => [
							k.id,
							k.name,
							`umiak_${k.prefix}…${k.last4}`,
							k.scopes.join(","),
							k.expiresAt,
							k.lastUsedAt,
							k.revokedAt,
						]),
					),
				);
			}),
		);

	keys
		.command("create")
		.description("issue a team key (owner, owner pairing)")
		.argument("<name>", "name of the key")
		.option("--preset <preset>", "read-only, ci or full")
		.option(
			"--scope <scope>",
			"a scope instead of a preset (repeatable)",
			collect,
		)
		.option("--expires <duration>", "lifetime (default 90d, at most 365d)")
		.action(
			run(async (ctx, args, opts) => {
				await requirePerson(ctx, "keys create");
				const preset = opts.preset as string | undefined;
				const scopes = opts.scope as string[] | undefined;
				if ((preset === undefined) === (scopes === undefined)) {
					throw usageError("pass either --preset or --scope");
				}
				const body: components["schemas"]["CreateApiKeyRequest"] = {
					name: args[0] as string,
				};
				if (preset !== undefined) body.preset = preset as Preset;
				if (scopes !== undefined) body.scopes = scopes as Scope[];
				if (opts.expires !== undefined) {
					body.expiresInSeconds = parseDuration(
						opts.expires as string,
						"--expires",
					);
				}
				const { data } = await ctx.umiak().raw.POST("/v1/api-keys", { body });
				ctx.out.result(data, secretText);
			}),
		);

	keys
		.command("rotate")
		.description("a new secret for a key; the old one stops working at once")
		.argument("<key>", "key ID (key_…)")
		.action(
			run(async (ctx, args) => {
				await requirePerson(ctx, "keys rotate");
				const { data } = await ctx
					.umiak()
					.raw.POST("/v1/api-keys/{key}/rotate", {
						params: { path: { key: args[0] as string } },
					});
				ctx.out.result(data, secretText);
			}),
		);

	keys
		.command("rm")
		.description("revoke keys")
		.argument("<key...>", "key IDs (key_…)")
		.action(
			run(async (ctx, args) => {
				for (const id of args[0] as string[]) {
					await ctx.umiak().raw.DELETE("/v1/api-keys/{key}", {
						params: { path: { key: id } },
					});
					ctx.out.result({ id, revoked: true }, (v) => `Revoked ${v.id}`);
				}
			}),
		);
}
