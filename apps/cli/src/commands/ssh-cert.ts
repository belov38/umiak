// `umiak ssh-cert [<sb>] [--ensure]` (S7 §11.3, §14.2): the key and
// certificate that `umiak ssh-config` points ssh at, in
// `<config dir>/ssh/<sb_id>/`: `id_ed25519` (made once with ssh-keygen under
// a temporary name and linked into place, so concurrent first runs agree),
// `id_ed25519-cert.pub` and `cert.json` (its validity, so --ensure needs no
// request while it is fresh).
// - Without --ensure: always a new certificate.
// - --ensure: a new one only if there is none or less than 2 min are left.
//   This is the `Match exec` of ssh-config, run by ssh on every connection,
//   so it does not change the current sandbox.
// Prints {identityFile, certificateFile, principal, validBefore, renewed};
// text: the certificate file.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { readJsonFile, writePrivateFile } from "../config.ts";
import type { Context } from "../context.ts";
import { sandboxRef, writeCurrent } from "../current.ts";
import type { Runner } from "../program.ts";
import { certify, ensureKey, publicKeyOf, refreshKnownHosts } from "../ssh.ts";

/** --ensure renews a certificate with less than this left. */
export const RENEW_BEFORE_MS = 2 * 60_000;

export interface CertFiles {
	identityFile: string;
	certificateFile: string;
	principal: string;
	validBefore: string;
	renewed: boolean;
}

/** The directory of the ssh-config key and certificate of a sandbox. */
export function certDir(ctx: Context, sandboxId: string): string {
	return join(ctx.paths.configDir, "ssh", sandboxId);
}

interface CertMeta {
	sandboxId: string;
	principal: string;
	validBefore: string;
}

async function ensureCert(
	ctx: Context,
	ref: { ref: string; explicit: boolean },
	ensure: boolean,
): Promise<CertFiles> {
	// An id needs no lookup (ssh-config writes ids); a slug is read once.
	const id = ref.ref.startsWith("sb_")
		? ref.ref
		: (await ctx.umiak().sandboxes.get(ref.ref)).id;
	if (ref.explicit && !ensure) writeCurrent(ctx, id);
	const dir = certDir(ctx, id);
	const key = join(dir, "id_ed25519");
	const files = { identityFile: key, certificateFile: `${key}-cert.pub` };
	const metaFile = join(dir, "cert.json");
	if (ensure && existsSync(files.certificateFile)) {
		const m = readJsonFile(metaFile) as CertMeta | undefined;
		const left = m === undefined ? 0 : Date.parse(m.validBefore) - Date.now();
		if (m !== undefined && left > RENEW_BEFORE_MS) {
			return {
				...files,
				principal: m.principal,
				validBefore: m.validBefore,
				renewed: false,
			};
		}
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	ensureKey(key, `umiak-${id}`);
	const cert = await certify(ctx, id, publicKeyOf(key), key);
	const meta: CertMeta = {
		sandboxId: id,
		principal: cert.principal,
		validBefore: cert.validBefore,
	};
	writePrivateFile(metaFile, `${JSON.stringify(meta)}\n`);
	await refreshKnownHosts(ctx, cert);
	return {
		...files,
		principal: cert.principal,
		validBefore: cert.validBefore,
		renewed: true,
	};
}

export function register(program: Command, run: Runner): void {
	program
		.command("ssh-cert")
		.description(
			"get the SSH certificate used by umiak ssh-config (new, or with --ensure only when due)",
		)
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.option(
			"--ensure",
			"keep a certificate with more than 2 minutes left (no request)",
		)
		.action(
			run(async (ctx, args, opts) => {
				const r = sandboxRef(ctx, args[0] as string | undefined);
				const files = await ensureCert(ctx, r, opts.ensure === true);
				ctx.out.result(files, (v) => v.certificateFile);
			}),
		);
}
