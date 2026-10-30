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

/** File map of the build ISO (volume label `SBXBUILD`); recipe files are looked up child recipe first. */
export function buildIsoFiles(i: BuildIsoInput): Map<string, string | Buffer> {
	const { recipe, versions } = i;
	const read = (rel: string) => readFileSync(recipeFile(recipe, rel), "utf8");
	const productKey =
		i.productKey !== undefined
			? i.productKey
			: versions.iso.productKey === null
				? null
				: resolveProductKey(recipe, versions.iso.productKey);
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

/**
 * File map of the offline ISO (volume label `SBXOFFL`): the windowsPE-only answer file,
 * offline.cmd and offline-config.cmd with the virtio-win driver folder and the services.
 */
export function offlineIsoFiles(
	stages: OfflineStage[],
	drivers: IsoInstallSource["drivers"] = "w11",
): Map<string, string | Buffer> {
	if (stages.length === 0) throw new Error("no offline stages");
	for (const s of stages)
		if (!(OFFLINE_STAGES as readonly string[]).includes(s))
			throw new Error(`unknown offline stage "${s}"`);
	const services = [...new Set(stages.flatMap((s) => OFFLINE_SERVICES[s]))];
	const read = (name: string) =>
		readFileSync(join(WINDOWS_FILES_DIR, name), "utf8");
	return new Map<string, string | Buffer>([
		["autounattend.xml", renderOfflineAutounattend()],
		["offline.cmd", crlf(read("offline.cmd"))],
		[
			"offline-config.cmd",
			crlf(
				`set SBX_DRIVERS=${drivers}\nset SBX_SERVICES=${services.join(" ")}\n`,
			),
		],
	]);
}
