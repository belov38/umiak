#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	BuildFailedError,
	type BuildOptions,
	buildTemplate,
	type ConnectOptions,
	guardApi,
	registerCommand,
	topologySnippet,
} from "./build.ts";
import { cleanup } from "./cleanup.ts";
import {
	type Ctx,
	imageCacheDir,
	machinesFor,
	makeContext,
	RAM_CAP_MB,
	RamGuard,
	registryDir,
} from "./context.ts";
import { devCpRegistrar } from "./devcp.ts";
import {
	defaultDownloadFetch,
	fetchBaseImage,
	fetchVirtioWin,
} from "./image.ts";
import type { Manifest, VerifyResult } from "./manifest.ts";
import { preflight } from "./preflight.ts";
import { loadRecipe, loadVersions } from "./recipe.ts";
import { FileRegistry } from "./registry.ts";
import { pveGuestIo } from "./runner.ts";
import { makeIso } from "./seed.ts";
import { fileSha256, MEDIA_STORAGE, TASK_TIMEOUT_MS } from "./stages.ts";
import { defaultSecretFiles, verifyTemplate } from "./verify.ts";
import { formatRecipeVersions, updateVersionsFile } from "./versions-update.ts";

const USAGE = `usage:
  sbx-tpl preflight [<slug>] [--node <node>]
  sbx-tpl versions <slug> [--update]
  sbx-tpl build <slug> --agent-package <tar> [--node <node>] [--sbx-cli <file>] [--api-url <url>]
                [--tunnel-url <wss-url>] [--ssh-user-ca <file>] [--refresh] [--keep-on-failure]
                [--no-verify] [--fail-step <step>] [--connect-url <wss-url> --dev-cp-ssh <user@host>]
                windows: [--iso <file>] [--iso-sha256 <hex> | --accept-iso-sha256] [--edition <name>]
                [--product-key-file <file>]
  sbx-tpl iso upload <file> [--node <node>]
  sbx-tpl verify <buildId> [--connect-url <wss-url> --dev-cp-ssh <user@host>]
  sbx-tpl list [<slug>]
  sbx-tpl show <buildId> [--field <name>]
  sbx-tpl show --active-vmid <slug>
  sbx-tpl cleanup [--node <node>]`;

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const TEMPLATES_DIR = join(REPO_ROOT, "infra/templates");
const UBUNTU_KEY_FILE = join(TEMPLATES_DIR, "keys/ubuntu-cloud-images.asc");
const UPDATE_KEYS_FILE = join(
	REPO_ROOT,
	"services/guest-agent/packaging/trust/update-keys.pub",
);
const LOG_DIR = join(REPO_ROOT, "build-logs");

class UsageError extends Error {}

const out = (s: string) =>
	process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);

/**
 * First SIGINT/SIGTERM aborts `signal` (the command fails at its next call and cleans up); a
 * second one exits at once with `lastWords()`.
 */
function trapSignals(lastWords: () => string): {
	signal: AbortSignal;
	exitCode: () => number;
	release: () => void;
} {
	const ac = new AbortController();
	let exitCode = 130;
	const onSignal = (sig: NodeJS.Signals) => {
		if (!ac.signal.aborted) {
			// 128 + signal number, as a shell reports it.
			exitCode = sig === "SIGTERM" ? 143 : 130;
			out(
				`\n[sbx-tpl] ${sig}: rolling back; send it again to exit without cleanup`,
			);
			ac.abort(new Error(`interrupted by ${sig}`));
			return;
		}
		out(`\n[sbx-tpl] ${lastWords()}`);
		process.exit(exitCode);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return {
		signal: ac.signal,
		exitCode: () => exitCode,
		release() {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		},
	};
}

/** `verifyTemplate` with the clients of `ctx`; guest calls stop once `signal` is aborted. */
function runVerify(
	ctx: Ctx,
	ramGuard: RamGuard,
	m: Manifest,
	o: { connect?: ConnectOptions; signal?: AbortSignal },
): Promise<VerifyResult> {
	if (m.pveVmid === null)
		throw new Error(`build ${m.buildId} has no template VM`);
	if (m.os === "windows") return verifyWindowsPending();
	const { cfg, api } = ctx;
	const recipe = loadRecipe(TEMPLATES_DIR, m.templateSlug);
	const ioApi = o.signal ? guardApi(api, o.signal) : api;
	return verifyTemplate(
		{
			machines: machinesFor(ctx, m.pveVmid),
			io: (vmid) => pveGuestIo(ioApi, cfg.node, vmid),
			node: ctx.node,
			ramGuard,
			verifyScript: readFileSync(
				join(TEMPLATES_DIR, recipe.verify, "verify.sh"),
				"utf8",
			),
			secretFiles: defaultSecretFiles(cfg),
			log: (msg) => out(`[sbx-tpl] ${msg}`),
		},
		m,
		{
			...(o.connect !== undefined
				? {
						connect: {
							url: o.connect.url,
							registrar: devCpRegistrar({ ctSsh: o.connect.ctSsh }),
						},
					}
				: {}),
			...(o.signal !== undefined ? { signal: o.signal } : {}),
		},
	);
}

/** The windows verify profile is not written yet: a windows build needs --no-verify until then. */
async function verifyWindowsPending(): Promise<VerifyResult> {
	throw new Error("windows verify not implemented (build with --no-verify)");
}

/**
 * `sbx-tpl iso upload <file>`: the user's Windows ISO into local:iso under its own name, through
 * the PVE API (spec S9 section 6.1). An ISO of that name is never replaced.
 */
async function cmdIsoUpload(
	file: string,
	nodeOver: { node?: string },
): Promise<number> {
	const name = basename(file);
	if (!/^[A-Za-z0-9._()+-]+\.iso$/.test(name) || name.startsWith("sbx-"))
		throw new UsageError(
			`${name}: expected an .iso file name of letters, digits and ._()+- (sbx-* names are the builder's)`,
		);
	if (!existsSync(file)) throw new Error(`${file} not found`);
	const size = statSync(file).size;
	const ctx = await makeContext(nodeOver);
	try {
		const { cfg, api } = ctx;
		const volid = `${MEDIA_STORAGE}:iso/${name}`;
		const have = (
			await api.get<{ volid: string; size?: number }[]>(
				`/nodes/${cfg.node}/storage/${MEDIA_STORAGE}/content`,
				{ content: "iso" },
			)
		).find((f) => f.volid === volid);
		if (have?.size === size) {
			out(`${volid} is present (${size} bytes)`);
			return 0;
		}
		if (have)
			throw new Error(
				`${volid} exists with ${have.size} bytes, this file has ${size}: remove it in the Proxmox web UI first`,
			);
		out(`hashing ${file}`);
		const sha256 = await fileSha256(file);
		out(`uploading ${name} (${size} bytes, sha256 ${sha256})`);
		const upid = await api.upload<string>(
			`/nodes/${cfg.node}/storage/${MEDIA_STORAGE}/upload`,
			{ content: "iso", "checksum-algorithm": "sha256", checksum: sha256 },
			{ name, path: file, size },
		);
		await api.waitTask(cfg.node, upid, { timeoutMs: TASK_TIMEOUT_MS });
		out(
			`${volid}: uploaded; pin it in versions.toml [iso]: file = "${name}", sha256 = "${sha256}"`,
		);
		return 0;
	} finally {
		ctx.close();
	}
}

function gitCommit(): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
	const head = git("rev-parse", "HEAD");
	return git("status", "--porcelain").length > 0 ? `${head}-dirty` : head;
}

function connectOption(v: {
	"connect-url"?: string | undefined;
	"dev-cp-ssh"?: string | undefined;
}): { connect?: ConnectOptions } {
	const url = v["connect-url"];
	const ctSsh = v["dev-cp-ssh"];
	if (url === undefined && ctSsh === undefined) return {};
	if (url === undefined || ctSsh === undefined)
		throw new UsageError("--connect-url and --dev-cp-ssh go together");
	return { connect: { url, ctSsh } };
}

/** A manifest field by dotted path; strings print raw, everything else as JSON. */
function field(m: Manifest, path: string): string {
	let v: unknown = m;
	for (const k of path.split(".")) {
		if (typeof v !== "object" || v === null || !(k in v))
			throw new Error(`field ${path} not found`);
		v = (v as Record<string, unknown>)[k];
	}
	return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function printBuilds(builds: Manifest[]): void {
	if (builds.length === 0) {
		out("no builds");
		return;
	}
	for (const b of builds)
		out(
			[
				b.buildId,
				b.templateSlug,
				b.version,
				b.status.padEnd(8),
				String(b.pveVmid ?? "-").padStart(4),
				b.startedAt,
				b.durationS === null ? "-" : `${b.durationS}s`,
				b.error
					? `${b.error.stage}${b.error.step ? `/${b.error.step}` : ""}`
					: "",
			].join("  "),
		);
}

async function cmdBuild(
	slug: string,
	v: Record<string, string | boolean | undefined>,
	registry: FileRegistry,
): Promise<number> {
	const str = (k: string) =>
		typeof v[k] === "string" ? (v[k] as string) : undefined;
	const agentPackage = str("agent-package");
	if (!agentPackage) throw new UsageError("--agent-package is required");
	const noVerify = v["no-verify"] === true;
	if (v.refresh === true) {
		const { file, changes } = await updateVersionsFile({
			templatesDir: TEMPLATES_DIR,
			slug,
		});
		out(`${file}: ${changes.length > 0 ? changes.join("; ") : "no changes"}`);
	}
	const ctx = await makeContext(
		str("node") !== undefined ? { node: str("node") as string } : {},
	);
	// First signal: fail the build at the next call and roll back. Second: exit at once.
	let buildId: string | undefined;
	const interrupt = trapSignals(
		() =>
			`exiting without cleanup${buildId ? ` (build ${buildId})` : ""}; run sbx-tpl cleanup (build VM, seed, lease) and, if verify had started, sbx-bench cleanup (verify clones and snapshot)`,
	);
	try {
		const { cfg, api } = ctx;
		const ramGuard = new RamGuard({
			api,
			node: cfg.node,
			pool: cfg.pool,
			capMb: RAM_CAP_MB,
		});
		const opt = (flag: string, key: keyof BuildOptions) =>
			str(flag) !== undefined ? { [key]: str(flag) } : {};
		const opts: BuildOptions = {
			slug,
			node: cfg.node,
			storage: cfg.storage,
			pool: cfg.pool,
			vnet: cfg.vnet,
			agentPackage,
			keepOnFailure: v["keep-on-failure"] === true,
			noVerify,
			templatesDir: TEMPLATES_DIR,
			updateKeysFile: UPDATE_KEYS_FILE,
			gitCommit: gitCommit(),
			logDir: LOG_DIR,
			...opt("sbx-cli", "sbxCli"),
			...opt("api-url", "apiUrl"),
			...opt("tunnel-url", "tunnelUrl"),
			...opt("ssh-user-ca", "sshUserCa"),
			...opt("fail-step", "failStep"),
			...opt("iso", "iso"),
			...opt("iso-sha256", "isoSha256"),
			...opt("edition", "edition"),
			...opt("product-key-file", "productKeyFile"),
			...(v["accept-iso-sha256"] === true ? { acceptIsoSha256: true } : {}),
			...connectOption(v as Record<string, string | undefined>),
		};
		const m = await buildTemplate(
			{
				api,
				signal: interrupt.signal,
				onStart: (mf) => {
					buildId = mf.buildId;
				},
				node: ctx.node,
				allocator: ctx.allocator,
				registry,
				fetchImage: (base) =>
					fetchBaseImage({
						fetch: defaultDownloadFetch,
						cacheDir: imageCacheDir(),
						base,
						keyFile: UBUNTU_KEY_FILE,
					}),
				fetchVirtioWin: (virtioWin) =>
					fetchVirtioWin({
						fetch: defaultDownloadFetch,
						cacheDir: imageCacheDir(),
						virtioWin,
					}),
				// Guarded so a long exec stops polling on an interrupt.
				io: (vmid) =>
					pveGuestIo(guardApi(api, interrupt.signal), cfg.node, vmid),
				makeIso: (files, path, label) => makeIso(files, path, label),
				verify: (mf, o) => runVerify(ctx, ramGuard, mf, o),
				ramGuard,
				log: (msg) => out(`[sbx-tpl] ${msg}`),
				stepOutput: (_step, chunk) => process.stdout.write(chunk),
				now: () => new Date(),
			},
			opts,
		);
		out(
			`\nbuild ${m.buildId}: ${m.templateSlug} ${m.version} ready, template VM ${m.pveVmid}`,
		);
		out(`\nregister in the control plane:\n${registerCommand(m)}`);
		out(
			`\nor add to topology.templateBuilds in deploy/compose/config/sbx.yaml:\n${topologySnippet(m)}`,
		);
		return 0;
	} catch (err) {
		if (!(err instanceof BuildFailedError)) throw err;
		const e = err.manifest.error;
		out(`\n${err.message}`);
		if (e?.tail?.length) out(`last lines of ${e.step}:\n${e.tail.join("\n")}`);
		out(`step logs: ${join(LOG_DIR, err.manifest.buildId)}`);
		return interrupt.signal.aborted ? interrupt.exitCode() : 1;
	} finally {
		interrupt.release();
		ctx.close();
	}
}

async function main(argv: string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			update: { type: "boolean", default: false },
			node: { type: "string" },
			"agent-package": { type: "string" },
			"sbx-cli": { type: "string" },
			"api-url": { type: "string" },
			"tunnel-url": { type: "string" },
			"ssh-user-ca": { type: "string" },
			refresh: { type: "boolean", default: false },
			"keep-on-failure": { type: "boolean", default: false },
			"no-verify": { type: "boolean", default: false },
			"fail-step": { type: "string" },
			iso: { type: "string" },
			"iso-sha256": { type: "string" },
			"accept-iso-sha256": { type: "boolean", default: false },
			edition: { type: "string" },
			"product-key-file": { type: "string" },
			"connect-url": { type: "string" },
			"dev-cp-ssh": { type: "string" },
			field: { type: "string" },
			"active-vmid": { type: "string" },
		},
	});
	const [cmd, arg, ...extra] = positionals;
	const registry = new FileRegistry(registryDir());
	const nodeOver = values.node !== undefined ? { node: values.node } : {};

	switch (cmd) {
		case "versions": {
			if (!arg || extra.length > 0) break;
			if (values.update) {
				const { file, changes, warnings } = await updateVersionsFile({
					templatesDir: TEMPLATES_DIR,
					slug: arg,
				});
				for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
				out(
					`${file}\n${changes.length > 0 ? changes.join("\n") : "no changes"}`,
				);
			} else {
				process.stdout.write(
					formatRecipeVersions(loadRecipe(TEMPLATES_DIR, arg)),
				);
			}
			return 0;
		}
		case "build":
			if (!arg || extra.length > 0) break;
			return cmdBuild(arg, values, registry);
		case "list":
			if (extra.length > 0) break;
			printBuilds(registry.list(arg));
			return 0;
		case "show": {
			const slug = values["active-vmid"];
			if (slug !== undefined) {
				if (arg !== undefined) break;
				const ready = registry.list(slug).filter((m) => m.status === "ready");
				const newest = ready.at(-1);
				if (newest?.pveVmid == null)
					throw new Error(`no ready build of ${slug}`);
				out(String(newest.pveVmid));
				return 0;
			}
			if (!arg || extra.length > 0) break;
			const m = registry.get(arg);
			if (!m) throw new Error(`build ${arg} not found in ${registry.dir}`);
			out(
				values.field !== undefined
					? field(m, values.field)
					: JSON.stringify(m, null, 2),
			);
			return 0;
		}
		case "verify": {
			if (!arg || extra.length > 0) break;
			const m = registry.get(arg);
			if (!m) throw new Error(`build ${arg} not found in ${registry.dir}`);
			const o = connectOption(values);
			const ctx = await makeContext({ node: m.node });
			const interrupt = trapSignals(
				() =>
					"exiting without cleanup; run sbx-bench cleanup (verify clones and snapshot)",
			);
			try {
				const ramGuard = new RamGuard({
					api: ctx.api,
					node: ctx.cfg.node,
					pool: ctx.cfg.pool,
					capMb: RAM_CAP_MB,
				});
				// The checks are printed as they run; the template stays either way.
				const v = await runVerify(ctx, ramGuard, m, {
					...o,
					signal: interrupt.signal,
				});
				registry.update(m.buildId, { verify: v });
				out(v.ok ? "verify: ok" : "verify: FAILED");
				return v.ok ? 0 : 1;
			} catch (err) {
				if (!interrupt.signal.aborted) throw err;
				out(`\n${err instanceof Error ? err.message : String(err)}`);
				return interrupt.exitCode();
			} finally {
				interrupt.release();
				ctx.close();
			}
		}
		case "iso": {
			const [file, ...rest] = extra;
			if (arg !== "upload" || file === undefined || rest.length > 0) break;
			return cmdIsoUpload(file, nodeOver);
		}
		case "preflight": {
			if (extra.length > 0) break;
			// A windows recipe adds its checks (console right, machine types, user ISO).
			const recipe =
				arg !== undefined ? loadRecipe(TEMPLATES_DIR, arg) : undefined;
			const iso =
				recipe?.os === "windows" ? loadVersions(recipe).iso : undefined;
			const ctx = await makeContext(nodeOver);
			try {
				const checks = await preflight({
					api: ctx.api,
					node: ctx.node,
					cfg: ctx.cfg,
					keyFile: UBUNTU_KEY_FILE,
					...(recipe !== undefined
						? { buildMemoryMb: recipe.buildVm.memoryMb }
						: {}),
					...(iso !== undefined
						? { windows: { isoFile: iso.file, isoSha256: iso.sha256 } }
						: {}),
				});
				for (const c of checks)
					out(
						`${c.ok ? (c.warn ? "WARN" : "ok  ") : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`,
					);
				return checks.every((c) => c.ok) ? 0 : 1;
			} finally {
				ctx.close();
			}
		}
		case "cleanup": {
			if (arg !== undefined) break;
			const ctx = await makeContext(nodeOver);
			try {
				const report = await cleanup({
					api: ctx.api,
					node: ctx.node,
					allocator: ctx.allocator,
					registry,
					cfg: ctx.cfg,
					now: () => new Date(),
				});
				out(report.length > 0 ? report.join("\n") : "nothing to clean");
				return 0;
			} finally {
				ctx.close();
			}
		}
	}
	throw new UsageError(cmd ? `bad arguments for ${cmd}` : "no command");
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		if (err instanceof UsageError) process.stderr.write(`${USAGE}\n`);
		process.exit(err instanceof UsageError ? 2 : 1);
	},
);
