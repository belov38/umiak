import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { isWellFormedApiKey } from "@umiak/auth/api-key";
import { Umiak } from "@umiak/sdk";
import type { Command } from "commander";
import { withFileLock } from "../auth/lock.ts";
import { ownerLogin } from "../auth/owner-login.ts";
import { credentialName, type StoredCredential } from "../auth/token.ts";
import {
	type Profile,
	readConfig,
	writeConfig,
	writePrivateFile,
} from "../config.ts";
import type { Context } from "../context.ts";
import { usageError } from "../exit-codes.ts";
import { getJson } from "../http.ts";
import { readAll } from "../io.ts";
import type { Runner } from "../program.ts";
import { presentAccount, tenancyCache, tenancyOf } from "../tenancy.ts";
import { CLI_VERSION } from "./version.ts";
import { humanMe, type Me } from "./whoami.ts";

interface LoginMeta {
	tenancy?: "single" | "teams";
	authMode?: "owner";
}

/** GET /v1/me with this bearer (and team), without the stored credentials. */
async function meWith(
	ctx: Context,
	apiUrl: string,
	token: string | undefined,
	team: string | undefined,
): Promise<Me> {
	const umiak = new Umiak({
		baseUrl: apiUrl,
		...(token === undefined ? { session: true } : { apiKey: token }),
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

/** Literal local/private addresses, including tailnet addresses need no public-HTTP warning. */
function localLoginHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (isIP(host) === 4) {
		const [a = 0, b = 0] = host.split(".").map(Number);
		return (
			a === 127 ||
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	return (
		isIP(host) === 6 &&
		(host === "::1" || /^(fc|fd)/.test(host) || /^fe[89ab]/.test(host))
	);
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
	let url: URL;
	try {
		url = new URL(apiUrl);
	} catch {
		throw usageError("API URL must be an HTTP or HTTPS URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw usageError("API URL must be an HTTP or HTTPS URL");
	if (url.protocol === "http:" && !localLoginHost(url.hostname)) {
		ctx.out.warn(
			"HTTP login sends credentials and traffic unencrypted; use HTTPS outside a trusted local network or tailnet.",
		);
	}
	let cred: StoredCredential | undefined;
	let profile: Profile;
	let meta: LoginMeta;
	if (opts.keyStdin === true) {
		const key = keyFromStdin(await readAll(ctx.stdin));
		meta = await getJson<LoginMeta>(ctx.fetch, `${apiUrl}/v1/meta`).catch(
			() => ({}),
		);
		cred = { kind: "key", token: key };
		profile = { apiUrl, auth: "key" };
	} else {
		meta = await getJson<LoginMeta>(ctx.fetch, `${apiUrl}/v1/meta`);
		{
			const token = await ownerLogin({
				apiUrl,
				fetch: ctx.fetch,
				onCode(code) {
					ctx.out.event("pairing_code", code);
					ctx.out.info(
						`Open ${code.verificationUri} in the claimed owner browser. Enter pairing code ${code.code ?? code.id}.`,
					);
					if (opts.browser !== false && process.stderr.isTTY === true)
						openBrowser(code.verificationUri);
				},
			});
			cred = { kind: "key", token };
			profile = { apiUrl, auth: "owner" };
		}
	}
	Object.assign(profile, tenancyCache(meta));
	const token = cred?.token;
	const me = await meWith(ctx, apiUrl, token, r.team);
	const ca = ctx.globals.cacert ?? ctx.env.UMIAK_CA_FILE;
	if (ca !== undefined && ca !== "") {
		const path = join(
			ctx.paths.configDir,
			`ca-${encodeURIComponent(r.profileName)}.pem`,
		);
		writePrivateFile(path, readFileSync(ca, "utf8"));
		profile.caFile = path;
	} else if (r.profile?.caFile !== undefined) {
		profile.caFile = r.profile.caFile;
	}
	if (r.team !== undefined) profile.team = r.team;

	const name = r.profileName;
	const old = r.profile;
	const store = ctx.store(profile);
	const oldEntry = old === undefined ? undefined : credentialName(name, old);
	const oldStore = old === undefined ? undefined : ctx.storeOf(old);
	await withFileLock(ctx.paths.lock, async () => {
		const entry = credentialName(name, profile);
		if (cred !== undefined) {
			await store.set(entry, JSON.stringify(cred));
			profile.credentialStore = store.kind;
		}
		// An unknown old store (config of an older CLI) under the same name
		// is the entry just written: leave it.
		const otherStore =
			old?.credentialStore !== undefined && old.credentialStore !== store.kind;
		if (
			oldEntry !== undefined &&
			oldStore !== undefined &&
			(cred === undefined || oldEntry !== entry || otherStore)
		) {
			await oldStore.delete(oldEntry).catch(() => {});
		}
		const config = readConfig(ctx.paths);
		config.profiles[name] = profile;
		config.current = name;
		writeConfig(ctx.paths, config);
	});
	ctx.reload();
	if (cred !== undefined && store.kind === "file") {
		ctx.out.warn(
			`credentials are stored in ${ctx.paths.credentials} (mode 0600), not in the OS keychain`,
		);
	}
	ctx.out.event(
		"logged_in",
		{ profile: name, apiUrl, me: presentAccount(me, tenancyOf(meta)) },
		(v) =>
			`Logged in to ${v.apiUrl} as ${humanMe(v.me)} (profile ${v.profile}).`,
	);
}

export function register(program: Command, run: Runner): void {
	program
		.command("login")
		.description(
			"log in: owner browser pairing, or a team key from stdin (--key-stdin)",
		)
		.option("--no-browser", "only print the login link, do not open a browser")
		.option("--key-stdin", "read a team API key (umiak_…) from stdin")
		.action(
			run(async (ctx, _args, opts) => {
				await login(ctx, opts as { browser?: boolean; keyStdin?: boolean });
			}),
		);
}
