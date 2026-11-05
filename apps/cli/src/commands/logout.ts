import { Umiak } from "@umiak/sdk";
import type { Command } from "commander";
import { withFileLock } from "../auth/lock.ts";
import { credentialName, parseCredential } from "../auth/token.ts";
import type { Context } from "../context.ts";
import type { Runner } from "../program.ts";
import { CLI_VERSION } from "./version.ts";

export interface LogoutResult {
	profile: string;
	/** Credentials were found and erased. */
	loggedOut: boolean;
	/** The refresh token or the key was revoked. */
	revoked: boolean;
}

async function logout(ctx: Context, revokeKey: boolean): Promise<LogoutResult> {
	const r = ctx.resolved;
	const p = r.profile;
	if (p === undefined) {
		return { profile: r.profileName, loggedOut: false, revoked: false };
	}
	const name = credentialName(r.profileName, p);
	const store = ctx.store(p);
	const cred = parseCredential(await store.get(name));
	let revoked = false;
	if (cred?.kind === "key" && p.auth === "owner") {
		const res = await ctx.fetch(
			new Request(`${p.apiUrl}/owner/logout`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${cred.token}`,
					"content-type": "application/json",
				},
				body: "{}",
				redirect: "error",
			}),
		);
		if (!res.ok) throw new Error(`Owner logout failed: HTTP ${res.status}`);
		revoked = true;
	} else if (cred?.kind === "key" && revokeKey) {
		// A failure stops here: the key stays stored, so the revoke can be repeated.
		const umiak = new Umiak({
			baseUrl: p.apiUrl,
			apiKey: cred.token,
			fetch: ctx.fetch as typeof fetch,
			userAgent: `umiak-cli/${CLI_VERSION}`,
			env: {},
		});
		await umiak.raw.DELETE("/v1/api-keys/self");
		revoked = true;
	}
	await withFileLock(ctx.paths.lock, () => store.delete(name));
	return { profile: r.profileName, loggedOut: cred !== null, revoked };
}

export function register(program: Command, run: Runner): void {
	program
		.command("logout")
		.description("log out: erase the stored credentials of the profile")
		.option(
			"--revoke",
			"for a team key: also revoke the key itself (DELETE /v1/api-keys/self)",
		)
		.action(
			run(async (ctx, _args, opts) => {
				const res = await logout(ctx, opts.revoke === true);
				ctx.out.result(res, (v) =>
					v.loggedOut
						? `Logged out of profile ${v.profile}${v.revoked ? " (revoked)" : ""}.`
						: `Profile ${v.profile} was not logged in.`,
				);
			}),
		);
}
