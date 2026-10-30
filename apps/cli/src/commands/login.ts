// `sbx login` (S7 §7.6):
// - people: Keycloak device flow. `GET /v1/meta` gives `oidc {issuer,
//   clientId}`; the code and the link are printed (and the browser opened,
//   unless --no-browser or not in a terminal); then `GET /v1/me` with the
//   new access token;
// - automation: `--key-stdin` reads a team key from stdin and checks it with
//   `GET /v1/me`.
// The credentials go to the credential store, the profile (apiUrl, team,
// auth, issuer, store) to config.json, and the profile becomes current.
// Output: in JSON mode `{"event":"device_code",…}` (device flow) and last
// `{"event":"logged_in","profile","apiUrl","me"}`.

import { spawn } from "node:child_process";
import { Sbx } from "@sbx/sdk";
import type { Command } from "commander";
import { deviceLogin } from "../auth/device-grant.ts";
import { withFileLock } from "../auth/lock.ts";
import {
	credentialName,
	OIDC_CLIENT_ID,
	type StoredCredential,
} from "../auth/token.ts";
import { type Profile, readConfig, writeConfig } from "../config.ts";
import type { Context } from "../context.ts";
import { CliError, usageError } from "../exit-codes.ts";
import { getJson } from "../http.ts";
import type { Runner } from "../program.ts";
import { CLI_VERSION } from "./version.ts";
import { humanMe, type Me } from "./whoami.ts";

interface MetaOidc {
	oidc: { issuer: string; clientId: string; audience: string } | null;
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of stream) {
		chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** GET /v1/me with this bearer (and team), without the stored credentials. */
async function meWith(
	ctx: Context,
	apiUrl: string,
	token: string,
	team: string | undefined,
): Promise<Me> {
	const sbx = new Sbx({
		baseUrl: apiUrl,
		apiKey: token,
		...(team === undefined ? {} : { team }),
		fetch: ctx.fetch as typeof fetch,
		userAgent: `sbx-cli/${CLI_VERSION}`,
		env: {},
	});
	return sbx.me();
}

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
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
			message: `${apiUrl} accepts only team keys; run: sbx login --key-stdin`,
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

async function login(
	ctx: Context,
	opts: { browser?: boolean; keyStdin?: boolean },
): Promise<void> {
	const r = ctx.resolved;
	if (r.apiUrl === undefined) {
		throw usageError("no API URL: pass --api-url <url> or set SBX_API_URL");
	}
	const apiUrl = r.apiUrl;
	let cred: StoredCredential;
	let profile: Profile;
	if (opts.keyStdin === true) {
		const key = (await readAll(ctx.stdin)).trim();
		if (key === "") throw usageError("--key-stdin: stdin is empty");
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
	await withFileLock(ctx.paths.lock, async () => {
		if (
			old !== undefined &&
			credentialName(name, old) !== credentialName(name, profile)
		) {
			await ctx
				.store(old)
				.delete(credentialName(name, old))
				.catch(() => {});
		}
		await store.set(credentialName(name, profile), JSON.stringify(cred));
		profile.credentialStore = store.kind;
		const config = readConfig(ctx.paths);
		config.profiles[name] = profile;
		config.current = name;
		writeConfig(ctx.paths, config);
	});
	ctx.reload();
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
		.option("--key-stdin", "read a team API key (sbx_…) from stdin")
		.action(
			run(async (ctx, _args, opts) => {
				await login(ctx, opts as { browser?: boolean; keyStdin?: boolean });
			}),
		);
}
