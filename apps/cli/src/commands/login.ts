// `umiak login` (S7 §7.6):
// - people: Keycloak device flow. `GET /v1/meta` gives `oidc {issuer,
//   clientId}`; the code and the link are printed (and the browser opened,
//   unless --no-browser or not in a terminal); then `GET /v1/me` with the
//   new access token;
// - automation: `--key-stdin` reads a team key from stdin (the only
//   non-empty line; format and CRC checked offline, else exit 2 before any
//   request) and checks it with `GET /v1/me`.
// The credentials go to the credential store, the profile (apiUrl, team,
// auth, issuer, store) to config.json, and the profile becomes current.
// Re-login into a profile replaces its old entry: the old secret is deleted
// when its entry name or its store differs from the new one, and an old
// Keycloak refresh token is revoked (best effort).
// Output: in JSON mode `{"event":"device_code",…}` (device flow) and last
// `{"event":"logged_in","profile","apiUrl","me"}`.

import { spawn } from "node:child_process";
import { isWellFormedApiKey } from "@umiak/auth/api-key";
import { Umiak } from "@umiak/sdk";
import type { Command } from "commander";
import { deviceLogin, revokeRefreshToken } from "../auth/device-grant.ts";
import { withFileLock } from "../auth/lock.ts";
import {
	credentialName,
	OIDC_CLIENT_ID,
	parseCredential,
	type StoredCredential,
} from "../auth/token.ts";
import { type Profile, readConfig, writeConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { CliError, usageError } from "../exit-codes.ts";
import { deadline, getJson } from "../http.ts";
import { readAll } from "../io.ts";
import type { Runner } from "../program.ts";
import { CLI_VERSION } from "./version.ts";
import { humanMe, type Me } from "./whoami.ts";

interface MetaOidc {
	oidc: { issuer: string; clientId: string; audience: string } | null;
}

/** GET /v1/me with this bearer (and team), without the stored credentials. */
async function meWith(
	ctx: Context,
	apiUrl: string,
	token: string,
	team: string | undefined,
): Promise<Me> {
	const umiak = new Umiak({
		baseUrl: apiUrl,
		apiKey: token,
		...(team === undefined ? {} : { team }),
		fetch: ctx.fetch as typeof fetch,
		userAgent: `umiak-cli/${CLI_VERSION}`,
		env: {},
	});
	return umiak.me();
}

/** The program that opens `url` in the browser (Windows: no cmd parsing of the URL). */
export function browserCommand(
	platform: NodeJS.Platform,
	url: string,
): [string, string[]] {
	if (platform === "darwin") return ["open", [url]];
	if (platform === "win32") {
		return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	}
	return ["xdg-open", [url]];
}

export function openBrowser(url: string): void {
	const [cmd, args] = browserCommand(process.platform, url);
	try {
		const p = spawn(cmd, args, { stdio: "ignore", detached: true });
		p.on("error", () => {});
		p.unref();
	} catch {
		// No browser: the link is printed anyway.
	}
}

async function deviceFlow(
	ctx: Context,
	apiUrl: string,
	browser: boolean,
): Promise<{ cred: StoredCredential; issuer: string }> {
	const meta = await getJson<MetaOidc>(ctx.fetch, `${apiUrl}/v1/meta`);
	if (meta.oidc === null) {
		throw new CliError({
			code: "oidc_unavailable",
			message: `${apiUrl} accepts only team keys; run: umiak login --key-stdin`,
			retryable: false,
		});
	}
	const issuer = meta.oidc.issuer.replace(/\/+$/, "");
	const clientId = meta.oidc.clientId || OIDC_CLIENT_ID;
	const t = await deviceLogin({
		issuer,
		clientId,
		fetch: ctx.fetch,
		onCode(c) {
			const link = c.verificationUriComplete ?? c.verificationUri;
			ctx.out.event("device_code", c);
			ctx.out.info(
				`To log in, open ${link}\nand confirm the code ${c.userCode} (valid ${Math.round(c.expiresIn / 60)} min).`,
			);
			if (browser && process.stderr.isTTY === true) openBrowser(link);
		},
	});
	return { cred: { kind: "oidc", issuer, clientId, ...t }, issuer };
}

/**
 * The team key of `--key-stdin`: the only non-empty line, well-formed
 * (format and CRC, S7 §7.2). Messages never quote the input: it is a secret.
 */
export function keyFromStdin(text: string): string {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "");
	const key = lines[0];
	if (key === undefined) throw usageError("--key-stdin: stdin is empty");
	if (lines.length > 1) {
		throw usageError(
			`--key-stdin: stdin must hold only the team key, found ${lines.length} non-empty lines`,
		);
	}
	if (!isWellFormedApiKey(key)) {
		throw usageError(
			"--key-stdin: stdin is not a well-formed team API key (umiak_ and 49 letters or digits with a valid checksum)",
		);
	}
	return key;
}

async function login(
	ctx: Context,
	opts: { browser?: boolean; keyStdin?: boolean },
): Promise<void> {
	const r = ctx.resolved;
	if (r.apiUrl === undefined) {
		throw usageError("no API URL: pass --api-url <url> or set UMIAK_API_URL");
	}
	const apiUrl = r.apiUrl;
	let cred: StoredCredential;
	let profile: Profile;
	if (opts.keyStdin === true) {
		const key = keyFromStdin(await readAll(ctx.stdin));
		cred = { kind: "key", token: key };
		profile = { apiUrl, auth: "key" };
	} else {
		const f = await deviceFlow(ctx, apiUrl, opts.browser !== false);
		cred = f.cred;
		profile = { apiUrl, auth: "oidc", issuer: f.issuer };
	}
	const token = cred.kind === "key" ? cred.token : cred.accessToken;
	const me = await meWith(ctx, apiUrl, token, r.team);
	if (r.team !== undefined) profile.team = r.team;

	const name = r.profileName;
	const old = r.profile;
	const store = ctx.store(profile);
	const oldEntry = old === undefined ? undefined : credentialName(name, old);
	const oldStore = old === undefined ? undefined : ctx.storeOf(old);
	const oldCred =
		oldEntry === undefined || oldStore === undefined
			? null
			: parseCredential(await oldStore.get(oldEntry).catch(() => null));
	await withFileLock(ctx.paths.lock, async () => {
		const entry = credentialName(name, profile);
		await store.set(entry, JSON.stringify(cred));
		profile.credentialStore = store.kind;
		// An unknown old store (config of an older CLI) under the same name
		// is the entry just written: leave it.
		const otherStore =
			old?.credentialStore !== undefined && old.credentialStore !== store.kind;
		if (
			oldEntry !== undefined &&
			oldStore !== undefined &&
			(oldEntry !== entry || otherStore)
		) {
			await oldStore.delete(oldEntry).catch(() => {});
		}
		const config = readConfig(ctx.paths);
		config.profiles[name] = profile;
		config.current = name;
		writeConfig(ctx.paths, config);
	});
	ctx.reload();
	if (
		oldCred?.kind === "oidc" &&
		!(cred.kind === "oidc" && cred.refreshToken === oldCred.refreshToken)
	) {
		const limit = deadline(10_000);
		await revokeRefreshToken({
			issuer: oldCred.issuer,
			clientId: oldCred.clientId,
			refreshToken: oldCred.refreshToken,
			fetch: ctx.fetch,
			signal: limit.signal,
		})
			.finally(() => limit.clear())
			.catch((err: unknown) => {
				ctx.out.warn(
					`could not revoke the previous refresh token at Keycloak: ${(err as Error).message}`,
				);
			});
	}
	if (store.kind === "file") {
		ctx.out.warn(
			`credentials are stored in ${ctx.paths.credentials} (mode 0600), not in the OS keychain`,
		);
	}
	ctx.out.event(
		"logged_in",
		{ profile: name, apiUrl, me },
		(v) =>
			`Logged in to ${v.apiUrl} as ${humanMe(v.me)} (profile ${v.profile}).`,
	);
}

export function register(program: Command, run: Runner): void {
	program
		.command("login")
		.description(
			"log in: Keycloak device flow for people, or a team key from stdin (--key-stdin)",
		)
		.option("--no-browser", "only print the login link, do not open a browser")
		.option("--key-stdin", "read a team API key (umiak_…) from stdin")
		.action(
			run(async (ctx, _args, opts) => {
				await login(ctx, opts as { browser?: boolean; keyStdin?: boolean });
			}),
		);
}
