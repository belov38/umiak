// SSH helpers of `umiak ssh`, `ssh-cert` and `ssh-config` (S7 §11.3, §14.1,
// S4 §9.2): an ed25519 key made by the system `ssh-keygen`, a short-lived
// certificate of it from `POST /v1/sandboxes/{sb}/ssh/certificate` (signed
// by the SSH login CA, principal = the sandbox id, about 10 min), and the
// known_hosts cache `<config dir>/known_hosts` with the gateway host keys of
// `/v1/meta` (`[host]:port` when the port is not 22).

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@umiak/sdk";
import { writePrivateFile } from "./config.ts";
import type { Context } from "./context.ts";
import { CliError } from "./exit-codes.ts";
import { getJson } from "./http.ts";
import { persistTenancy } from "./tenancy.ts";

export type SshCertificate = components["schemas"]["SshCertificate"];

/** A system tool (ssh, ssh-keygen) is not installed. */
export const TOOL_MISSING = "tool_missing";

export function knownHostsFile(ctx: Context): string {
	return join(ctx.paths.configDir, "known_hosts");
}

/** The host name of known_hosts: `host`, or `[host]:port` off port 22. */
export function knownHostsName(host: string, port: number): string {
	return port === 22 ? host : `[${host}]:${port}`;
}

function runKeygen(args: string[]): string {
	const r = spawnSync("ssh-keygen", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error !== undefined) {
		throw new CliError({
			code: TOOL_MISSING,
			message: `cannot run ssh-keygen (${r.error.message}): install OpenSSH`,
			retryable: false,
		});
	}
	if (r.status !== 0) {
		throw new CliError({
			code: "ssh_keygen_failed",
			message: `ssh-keygen failed: ${r.stderr.trim()}`,
			retryable: false,
		});
	}
	return r.stdout;
}

/** Makes a new ed25519 key pair at `file` and `file.pub` (no passphrase). */
export function sshKeygen(file: string, comment: string): void {
	runKeygen(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file]);
}

/**
 * Certifies `publicKey` (an OpenSSH line) for sandbox `sandbox` (ID or
 * slug) and writes the certificate to `<keyFile>-cert.pub` (0600).
 */
export async function certify(
	ctx: Context,
	sandbox: string,
	publicKey: string,
	keyFile: string,
	signal?: AbortSignal,
): Promise<SshCertificate> {
	const { data } = await ctx
		.umiak()
		.raw.POST("/v1/sandboxes/{sandbox}/ssh/certificate", {
			params: { path: { sandbox } },
			body: { publicKey: publicKey.trim() },
			...(signal === undefined ? {} : { signal }),
		});
	writePrivateFile(`${keyFile}-cert.pub`, `${data.certificate.trim()}\n`);
	return data;
}

/** The public key line of a private key file (`ssh-keygen -y`). */
export function publicKeyOf(keyFile: string): string {
	const r = runKeygen(["-y", "-f", keyFile]);
	return r.trim();
}

/**
 * Makes the private key `file` if there is none. The key is made under a
 * temporary name and linked into place, so concurrent first runs end with
 * one key (the loser drops its own). No `.pub` is kept: see publicKeyOf.
 */
export function ensureKey(file: string, comment: string): void {
	if (existsSync(file)) return;
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		sshKeygen(tmp, comment);
		try {
			linkSync(tmp, file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	} finally {
		rmSync(tmp, { force: true });
		rmSync(`${tmp}.pub`, { force: true });
	}
}

interface MetaSsh {
	tenancy?: "single" | "teams";
	ssh: { host: string; port: number; hostKeys: string[] };
}

/**
 * Rewrites the lines of the gateway in the known_hosts cache from
 * `/v1/meta`; other hosts' lines stay. If /v1/meta cannot be read, the
 * `fallback` lines (of a certificate answer) are used. Returns the file.
 */
export async function refreshKnownHosts(
	ctx: Context,
	fallback?: { host: string; port: number; knownHosts: string[] },
): Promise<string> {
	let name: string;
	let lines: string[];
	try {
		const meta = await getJson<MetaSsh>(
			ctx.fetch,
			`${ctx.apiUrl().replace(/\/+$/, "")}/v1/meta`,
		);
		await persistTenancy(ctx, meta);
		name = knownHostsName(meta.ssh.host, meta.ssh.port);
		lines = meta.ssh.hostKeys.map((k) => `${name} ${k}`);
	} catch (err) {
		if (fallback === undefined) throw err;
		name = knownHostsName(fallback.host, fallback.port);
		lines = fallback.knownHosts;
	}
	const file = knownHostsFile(ctx);
	let old: string[] = [];
	try {
		old = readFileSync(file, "utf8").split("\n");
	} catch {
		// No cache yet.
	}
	const kept = old.filter((l) => {
		if (l.trim() === "") return false;
		const hosts = l.split(/\s+/)[0]?.split(",") ?? [];
		return !hosts.includes(name);
	});
	mkdirSync(ctx.paths.configDir, { recursive: true, mode: 0o700 });
	writePrivateFile(file, `${[...kept, ...lines].join("\n")}\n`);
	return file;
}
