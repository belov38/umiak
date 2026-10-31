import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type IsoInstallSource,
	isBuiltinStep,
	OFFLINE_STAGES,
	type OfflineStage,
	recipeFile,
	resolveProductKey,
	stepFile,
	type WindowsRecipe,
	type WindowsVersions,
} from "../recipe.ts";
import { collectFiles } from "../seed.ts";
import { formatWindowsVersionsToml } from "../versions-update-windows.ts";
import {
	renderAutounattend,
	renderOfflineAutounattend,
	virtioDriverPaths,
	WINDOWS_FILES_DIR,
} from "./unattend.ts";

// Contents of the build ISO (spec S9 section 6.3) and the offline ISO (section 6.4)

export const BUILD_ISO_LABEL = "SBXBUILD";
export const OFFLINE_ISO_LABEL = "SBXOFFL";

/** Services and drivers each offline stage sets to Start=4 (spec S9 sections 8.1, 10.3). */
export const OFFLINE_SERVICES: Record<OfflineStage, string[]> = {
	"defender-off": [
		"WinDefend",
		"WdNisSvc",
		"Sense",
		"WdBoot",
		"WdFilter",
		"WdNisDrv",
	],
	"waasmedic-off": ["WaaSMedicSvc"],
};

/**
 * Services of spec S9 section 8.1 that stay Manual through the build: sysprep /generalize can
 * hang or fail with dmwappushservice disabled. The offline boot comes before sysprep, so they are
 * not in its set; the specialize pass of sbx-unattend.xml disables them on each clone.
 */
export const SYSPREP_DEFERRED_SERVICES = ["dmwappushservice"];

/** Services and drivers the offline boot sets to Start=4, in offline-config.cmd order. */
export function offlineServices(stages: OfflineStage[]): string[] {
	if (stages.length === 0) throw new Error("no offline stages");
	for (const s of stages)
		if (!(OFFLINE_STAGES as readonly string[]).includes(s))
			throw new Error(`unknown offline stage "${s}"`);
	return [...new Set(stages.flatMap((s) => OFFLINE_SERVICES[s]))];
}

/** Same rule as the agent package versions (agent-package.ts). */
const AGENT_VERSION_RE = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,63}$/;
/** Joliet (what Windows reads) keeps at most 64 characters of a name. */
const JOLIET_NAME_MAX = 64;

/** cmd mis-parses labels and `goto` in files with bare LF line ends. */
function crlf(s: string): string {
	return s.replace(/\r?\n/g, "\r\n");
}

export function agentPackageName(version: string): string {
	if (!AGENT_VERSION_RE.test(version))
		throw new Error(`invalid agent version "${version}"`);
	return `sbx-agent-${version}-windows-amd64.tar`;
}

/** Windows reads the Joliet tree; xorriso would silently truncate longer names. */
function assertJolietNames(files: Map<string, string | Buffer>): void {
	for (const path of files.keys())
		for (const name of path.split("/"))
			if (name.length > JOLIET_NAME_MAX)
				throw new Error(
					`ISO file ${path}: name "${name}" is longer than ${JOLIET_NAME_MAX} characters (Joliet)`,
				);
}

export interface BuildIsoInput {
	recipe: WindowsRecipe;
	versions: WindowsVersions;
	/** The verified agent package (.tar). */
	agentTar: Buffer;
	agentVersion: string;
	/** Content of `C:\ProgramData\sbx-agent\agent.toml`. */
	agentToml: string;
	/** Content of the template SSH user CA public keys. */
	sshUserCa?: string;
	buildPassword: string;
	buildId: string;
	/**
	 * Product key override (`--product-key-file`); null installs without a key.
	 * Undefined: the generic key named by `versions.iso.productKey` in keys.toml.
	 */
	productKey?: string | null;
}

/** `build/versions.json`: what the steps download and install. No ISO data, no keys. */
function versionsJson(i: BuildIsoInput): string {
	const v = i.versions;
	return `${JSON.stringify(
		{
			buildId: i.buildId,
			agent: {
				version: i.agentVersion,
				package: agentPackageName(i.agentVersion),
			},
			options: { vsBuildtools: i.recipe.options.vsBuildtools },
			virtioWin: v.virtioWin,
			tools: v.tools,
			npm: v.npm,
			openssh: v.openssh,
		},
		null,
		2,
	)}\n`;
}

/** The generic key named by `versions.iso.productKey` in keys.toml; null for evaluation media. */
export function genericProductKey(
	recipe: WindowsRecipe,
	versions: WindowsVersions,
): string | null {
	return versions.iso.productKey === null
		? null
		: resolveProductKey(recipe, versions.iso.productKey);
}

/** File map of the build ISO (volume label `SBXBUILD`); recipe files are looked up child recipe first. */
export function buildIsoFiles(i: BuildIsoInput): Map<string, string | Buffer> {
	const { recipe, versions } = i;
	const read = (rel: string) => readFileSync(recipeFile(recipe, rel), "utf8");
	const productKey =
		i.productKey !== undefined
			? i.productKey
			: genericProductKey(recipe, versions);
	const agentTarName = agentPackageName(i.agentVersion);

	const out = new Map<string, string | Buffer>();
	out.set(
		"autounattend.xml",
		renderAutounattend(
			{
				edition: versions.iso.edition,
				productKey,
				uiLanguage: versions.iso.uiLanguage,
				locale: recipe.source.locale,
				buildPassword: i.buildPassword,
				driverPaths: virtioDriverPaths(recipe.source.drivers),
			},
			read("autounattend.xml.tmpl"),
		),
	);
	out.set("build/SetupComplete.cmd", crlf(read("SetupComplete.cmd")));
	out.set("build/run-step.ps1", read("run-step.ps1"));
	for (const step of recipe.steps) {
		if (isBuiltinStep(recipe, step)) continue;
		out.set(`build/steps/${step}.ps1`, readFileSync(stepFile(recipe, step)));
	}
	// Optional helpers the steps dot-source.
	for (const d of [...recipe.stepDirs].reverse()) {
		const lib = join(d, "lib.ps1");
		if (existsSync(lib)) {
			out.set("build/lib.ps1", readFileSync(lib));
			break;
		}
	}
	for (const dir of recipe.stepDirs) collectFiles(dir, out);

	out.set("build/versions.toml", formatWindowsVersionsToml(versions));
	out.set("build/versions.json", versionsJson(i));
	out.set("build/agent.toml", i.agentToml);
	out.set(`build/${agentTarName}`, i.agentTar);
	// Always present, empty without a CA, so 50-sbx-agent copies it unconditionally.
	out.set("build/ssh-user-ca.pub", i.sshUserCa ?? "");
	out.set("build/sbx-unattend.xml", read("sbx-unattend.xml"));
	assertJolietNames(out);
	return out;
}

export interface OfflineIsoInput {
	/** `versions.iso.uiLanguage`. */
	uiLanguage: string;
	/** The generic key (`genericProductKey`), never a --product-key-file key: nothing is installed. */
	productKey: string | null;
	drivers?: IsoInstallSource["drivers"];
}

/**
 * File map of the offline ISO (volume label `SBXOFFL`): the windowsPE-only answer file,
 * offline.cmd and offline-config.cmd with the virtio-win driver folder and the services.
 */
export function offlineIsoFiles(
	stages: OfflineStage[],
	i: OfflineIsoInput,
): Map<string, string | Buffer> {
	const services = offlineServices(stages);
	const drivers = i.drivers ?? "w11";
	const read = (name: string) =>
		readFileSync(join(WINDOWS_FILES_DIR, name), "utf8");
	return new Map<string, string | Buffer>([
		[
			"autounattend.xml",
			renderOfflineAutounattend({
				uiLanguage: i.uiLanguage,
				productKey: i.productKey,
			}),
		],
		["offline.cmd", crlf(read("offline.cmd"))],
		[
			"offline-config.cmd",
			crlf(
				`set SBX_DRIVERS=${drivers}\nset SBX_SERVICES=${services.join(" ")}\n`,
			),
		],
	]);
}

/**
 * `C:\ProgramData\sbx-agent\agent.toml` of the template (spec S9 section 12.1). The values equal
 * the agent's Windows defaults; the file makes them visible on the image. A desktop recipe adds
 * the desktop readiness phase and excludes the loopback streamer ports (spec S10 section 8.1).
 */
export function renderWindowsAgentToml(
	tunnelUrl?: string,
	desktop = false,
): string {
	const lines: string[] = [];
	if (tunnelUrl !== undefined)
		lines.push("[tunnel]", `url = ${JSON.stringify(tunnelUrl)}`, "");
	lines.push(
		"[user]",
		'default = "user"',
		"",
		"[readiness]",
		desktop
			? 'required = ["identity", "claim", "secrets", "desktop"]'
			: 'required = ["identity", "claim", "secrets"]',
		"",
		"[docker]",
		"enabled = false",
		"",
	);
	if (desktop) lines.push("[desktop]", "enabled = true", "");
	lines.push(
		"[ports]",
		desktop
			? "exclude = [22, 135, 47800, 47984, 47989, 47990, 48010]"
			: "exclude = [22, 135]",
		'exclude_processes = ["System", "lsass.exe", "wininit.exe", "services.exe", "svchost.exe", "spoolsv.exe"]',
		"",
	);
	return lines.join("\n");
}
