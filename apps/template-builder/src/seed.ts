import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	isDesktopRecipe,
	REBOOT_STEP,
	type Recipe,
	stepFile,
	type Versions,
} from "./recipe.ts";
import { formatVersionsToml } from "./versions-update.ts";

// Seed ISO for the build VM (spec S5 sections 6.2, 7.2 step 3, 14)

/** Seed path of the agent package (step 50-umiak-agent reads it). */
export const SEED_AGENT_PACKAGE = "build/umiak-agent.tar";
/** Seed path of the update keys that verified the package (first-install trust anchor). */
export const SEED_UPDATE_KEYS = "build/update-keys.pub";
export interface SeedInput {
	/** CA-free first install, authenticated by the outer offline-layer signature. */
	genericAgent?: { binary: string; unitsDirectory: string };
	recipe: Recipe;
	versions: Versions;
	buildId: string;
	/** Template version, YYYYMMDD.n. */
	version: string;
	/** Path of the signed agent package (.tar), already verified. */
	agentPackage: string;
	agentVersion: string;
	/**
	 * The update keys file the package was verified with. Step 50 passes it to
	 * `install-package --trust-keys`: a per-install signing key (quickstart) is
	 * not among the keys embedded in the agent binary.
	 */
	updateKeys: string | Buffer;
	/** Path of the `umiak` CLI binary. */
	umiakCli?: string;
	apiUrl?: string;
	tunnelUrl?: string;
	/** Path of the template SSH user CA public key. */
	sshUserCa?: string;
	/** Build manifest without the `verify` section. */
	manifestBase: object;
}

/**
 * POSIX sh for cloud-init `bootcmd`: `$1` is the snapshot timestamp, `$2` the deb822 file.
 * Appends `Snapshot: <ts>` to every stanza that has `Types:` and no `Snapshot:` line.
 */
export const APT_SNAPSHOT_SCRIPT = `set -eu
awk -v ts="$1" '
function flush() {
  for (i = 1; i <= n; i++) print buf[i]
  if (types && !snap) print "Snapshot: " ts
  n = 0; types = 0; snap = 0
}
/^[[:space:]]*$/ { flush(); print; next }
{ buf[++n] = $0 }
/^Types:/ { types = 1 }
/^Snapshot:/ { snap = 1 }
END { flush() }
' "$2" > "$2.new"
cat "$2.new" > "$2"
rm -f "$2.new"
`;

/** Replaces `{{name}}` with the value; a placeholder without a value is an error. */
export function fillTemplate(
	tmpl: string,
	values: Record<string, string>,
	file: string,
): string {
	return tmpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
		const v = values[name];
		if (v === undefined)
			throw new Error(`${file}: unknown placeholder {{${name}}}`);
		return v;
	});
}

/** First existing `<dir>/<rel>`, child recipe directory first. */
function findInRecipe(recipe: Recipe, rel: string): string | undefined {
	for (const d of [...recipe.stepDirs].reverse()) {
		const p = join(d, rel);
		if (existsSync(p)) return p;
	}
	return undefined;
}

function requireInRecipe(recipe: Recipe, rel: string): string {
	const p = findInRecipe(recipe, rel);
	if (p === undefined)
		throw new Error(
			`${rel} not found for recipe "${recipe.slug}" in: ${recipe.stepDirs.join(", ")}`,
		);
	return p;
}

function shellQuote(v: string): string {
	return `'${v.replaceAll("'", "'\\''")}'`;
}

export function renderAgentToml(tunnelUrl?: string, desktop = false): string {
	const lines: string[] = [];
	if (tunnelUrl !== undefined)
		lines.push("[tunnel]", `url = ${JSON.stringify(tunnelUrl)}`, "");
	lines.push(
		"[user]",
		'default = "user"',
		"",
		"[readiness]",
		desktop
			? 'required = ["identity", "claim", "secrets", "docker", "desktop"]'
			: 'required = ["identity", "claim", "secrets", "docker"]',
		"",
		"[docker]",
		"enabled = true",
		"",
	);
	if (desktop)
		lines.push(
			"[desktop]",
			"enabled = true",
			"",
			"[ports]",
			"exclude = [22, 53, 47800, 47984, 47989, 47990, 48010]",
			"",
		);
	return lines.join("\n");
}

/** Every file under `<dir>/files/`, as `build/files/<relative path> -> content`. */
export function collectFiles(
	dir: string,
	out: Map<string, string | Buffer>,
): void {
	const root = join(dir, "files");
	if (!existsSync(root)) return;
	const rels = readdirSync(root, { recursive: true, encoding: "utf8" })
		.filter((rel) => !rel.split("/").includes(".DS_Store"))
		.sort();
	for (const rel of rels) {
		const p = join(root, rel);
		if (statSync(p).isFile()) out.set(`build/files/${rel}`, readFileSync(p));
	}
}

export function renderSeed(i: SeedInput): Map<string, string | Buffer> {
	const { recipe } = i;
	if (
		i.genericAgent &&
		(i.tunnelUrl !== undefined ||
			i.apiUrl !== undefined ||
			i.sshUserCa !== undefined ||
			!/^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,63}$/.test(i.agentVersion))
	)
		throw new Error(
			"Generic layer seed cannot contain installation trust/endpoints or unsafe versions",
		);
	const snapshot = i.versions.apt.snapshot;
	const out = new Map<string, string | Buffer>();

	// Strings are JSON-encoded: a JSON string is a valid YAML double-quoted scalar.
	const values = {
		build_id: JSON.stringify(i.buildId),
		apt_snapshot: JSON.stringify(snapshot),
		apt_snapshot_script: JSON.stringify(APT_SNAPSHOT_SCRIPT),
	};
	for (const name of ["meta-data", "user-data"]) {
		const file = requireInRecipe(recipe, `seed/${name}.tmpl`);
		out.set(name, fillTemplate(readFileSync(file, "utf8"), values, file));
	}
	out.set(
		"network-config",
		readFileSync(requireInRecipe(recipe, "seed/network-config")),
	);

	for (const step of recipe.steps) {
		if (step === REBOOT_STEP) continue;
		out.set(`build/steps/${step}.sh`, readFileSync(stepFile(recipe, step)));
	}
	out.set("build/lib.sh", readFileSync(requireInRecipe(recipe, "lib.sh")));
	for (const dir of recipe.stepDirs) collectFiles(dir, out);

	out.set("build/versions.toml", formatVersionsToml(i.versions));
	out.set(
		"build/env",
		(
			[
				["UMIAK_BUILD_ID", i.buildId],
				["UMIAK_BUILD_VERSION", i.version],
				["UMIAK_AGENT_VERSION", i.agentVersion],
				["UMIAK_APT_SNAPSHOT", snapshot],
			] satisfies [string, string][]
		)
			.map(([k, v]) => `${k}=${shellQuote(v)}\n`)
			.join(""),
	);
	// A fixed name; the version travels in build/env.
	if (i.genericAgent) {
		const binary = readFileSync(i.genericAgent.binary);
		out.set("build/generic-agent/umiak-agent", binary);
		for (const unit of [
			"umiak-agent.service",
			"umiak-identity.service",
			"umiak-agent-rollback.service",
			"umiak-cmd.slice",
		])
			out.set(
				`build/generic-agent/${unit}`,
				readFileSync(join(i.genericAgent.unitsDirectory, unit)),
			);
		out.set(
			"build/generic-agent/manifest.json",
			JSON.stringify({
				format: "umiak-agent-manifest/v1",
				version: i.agentVersion,
				os: "linux",
				arch: "amd64",
				files: {
					"umiak-agent": createHash("sha256").update(binary).digest("hex"),
					"trust/update-keys.pub": createHash("sha256")
						.update(i.updateKeys)
						.digest("hex"),
				},
			}),
		);
		out.set(
			"build/generic-agent.sh",
			readFileSync(
				new URL(
					"../../../infra/templates/linux/generic-agent.sh",
					import.meta.url,
				),
			),
		);
		out.set("build/env", `${out.get("build/env")}UMIAK_GENERIC_IMAGE='1'\n`);
	} else out.set(SEED_AGENT_PACKAGE, readFileSync(i.agentPackage));
	out.set(SEED_UPDATE_KEYS, i.updateKeys);
	out.set(
		"build/agent.toml",
		renderAgentToml(i.tunnelUrl, isDesktopRecipe(recipe)),
	);
	out.set(
		"build/ssh-user-ca.pub",
		i.sshUserCa === undefined ? "" : readFileSync(i.sshUserCa),
	);
	if (i.umiakCli !== undefined)
		out.set("build/umiak", readFileSync(i.umiakCli));
	if (i.apiUrl !== undefined)
		out.set(
			"build/umiak-config.json",
			`${JSON.stringify({ apiUrl: i.apiUrl })}\n`,
		);
	out.set("build/build.json", `${JSON.stringify(i.manifestBase, null, 2)}\n`);
	return out;
}

// ISO

const VOLUME_LABEL = "cidata";
/** ISO 9660 volume id: at most 32 characters; xorriso keeps the case. */
const VOLUME_LABEL_RE = /^[A-Za-z0-9_]{1,32}$/;

/** The ISO tool, on every platform. */
export const ISO_TOOL = "xorriso";

/**
 * Writes the tree to a temp directory and packs it into `out` (volume label `cidata` unless given) with xorriso,
 * Rock Ridge and Joliet. Not hdiutil: it shortens names with dots or more than 30 characters
 * (sudoers.d became sudoersd on a real build).
 */
export function makeIso(
	files: Map<string, string | Buffer>,
	out: string,
	label = VOLUME_LABEL,
): void {
	if (!VOLUME_LABEL_RE.test(label))
		throw new Error(`invalid ISO volume label "${label}"`);
	const root = mkdtempSync(join(tmpdir(), "umiak-seed-"));
	try {
		for (const [rel, data] of files) {
			const p = join(root, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, data);
		}
		rmSync(out, { force: true });
		const args = ["-as", "mkisofs", "-V", label, "-J", "-R", "-o", out, root];
		try {
			execFileSync(ISO_TOOL, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
			if (e.code === "ENOENT")
				throw new Error(
					`${ISO_TOOL} not found in PATH (macOS: brew install xorriso; Debian/Ubuntu: apt install xorriso)`,
				);
			throw new Error(
				`${ISO_TOOL} failed: ${e.stderr?.toString().trim() || e.message}`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
