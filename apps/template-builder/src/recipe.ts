import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Recipe (template.yaml, spec S5 section 5; iso-install: spec S9 section 5)

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Shared recipe directories (`_windows`) are never recipes themselves: slugs cannot start with `_`. */
const SHARED_RE = /^_[a-z0-9][a-z0-9-]*$/;
const STEP_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";
const STEP_RE = new RegExp(`^${STEP_PATTERN}$`);
const PARENT_TOKEN = "@parent";
// Desktop profiles extend a headless profile and must pass its complete baseline as well.
const VERIFY_BASE: Record<string, string> = {
	"linux-desktop": "linux",
};

/** A desktop recipe gets the desktop readiness phase and the streamer port exclusions. */
export function isDesktopRecipe(recipe: { verify: string }): boolean {
	return (
		recipe.verify === "windows" ||
		recipe.verify === "windows-desktop" ||
		Object.hasOwn(VERIFY_BASE, recipe.verify)
	);
}

/** The verify script of `profile`, prefixed with its headless baseline. */
export function loadVerifyScript(
	templatesDir: string,
	profile: string,
	os: "linux" | "windows" = "linux",
): string {
	if (profile === "windows-desktop") profile = "windows";
	const file = os === "windows" ? "verify.ps1" : "verify.sh";
	const script = readFileSync(join(templatesDir, profile, file), "utf8");
	const base = VERIFY_BASE[profile];
	if (!base) return script;
	const baseScript = readFileSync(join(templatesDir, base, file), "utf8");
	if (os === "linux") return `${baseScript}\n${script}`;
	// verify.ps1 starts with a param block: the desktop groups go before its main block.
	const at = baseScript.indexOf(WINDOWS_VERIFY_MAIN);
	if (at < 0)
		throw new Error(`${base}/${file}: no "${WINDOWS_VERIFY_MAIN}" marker`);
	return `${baseScript.slice(0, at)}${script}\n${baseScript.slice(at)}`;
}
const WINDOWS_VERIFY_MAIN = "# --- main ---";
export const REBOOT_STEP = "reboot";
/** Windows only: `net0 link_down=0`, then wait for an IPv4 (spec S9 section 5). */
export const NETWORK_UP_STEP = "network-up";
export const DEFAULT_INSTALL_TIMEOUT_S = 2400;
export const OFFLINE_STAGES = ["defender-off", "waasmedic-off"] as const;
export type OfflineStage = (typeof OFFLINE_STAGES)[number];
/** Pseudo value of `hw.machine`: the builder pins the newest pc-q35 version at build time. */
export const PINNED_MACHINE = "pinned";
const FIRMWARE_DISKS = ["efidisk0", "tpmstate0"] as const;
type FirmwareDisk = (typeof FIRMWARE_DISKS)[number];

const cloudImageSourceSchema = z.strictObject({
	kind: z.literal("cloud-image"),
	distro: z.literal("ubuntu"),
	release: z.string().min(1),
	flavor: z.enum(["minimal", "server"]),
});

const LOCALE_RE = /^[A-Za-z0-9:-]+$/;
const isoInstallSourceSchema = z.strictObject({
	kind: z.literal("iso-install"),
	family: z.enum(["client", "server"]),
	drivers: z.enum(["w11", "2k25"]),
	locale: z.strictObject({
		formats: z.string().regex(LOCALE_RE),
		keyboard: z.string().regex(LOCALE_RE),
		// Windows time zone ids contain spaces and parentheses ("GMT Standard Time").
		timezone: z.string().regex(/^[A-Za-z0-9 ()+.,_-]+$/),
	}),
});

export type CloudImageSource = z.infer<typeof cloudImageSourceSchema>;
export type IsoInstallSource = z.infer<typeof isoInstallSourceSchema>;

const diskSchema = z.strictObject({
	slot: z.literal("scsi0"),
	size: z.string().regex(/^[1-9]\d*G$/, "expected whole gigabytes, e.g. 64G"),
});

const buildVmSchema = z.strictObject({
	cores: z.number().int().positive(),
	memory_mb: z.number().int().positive(),
});

const hwScalar = z.union([z.string(), z.number(), z.boolean()]);

// Every field except slug and os is optional in the file: a recipe with
// `extends` inherits the rest. Required-ness of a root recipe is checked after merging.
const recipeFileSchema = z.strictObject({
	slug: z.string().regex(SLUG_RE),
	os: z.enum(["linux", "windows"]),
	extends: z.string().regex(SLUG_RE).nullable().optional(),
	shared: z
		.string()
		.regex(SHARED_RE, "expected a shared directory name like _windows")
		.optional(),
	source: z
		.discriminatedUnion("kind", [
			cloudImageSourceSchema,
			isoInstallSourceSchema,
		])
		.optional(),
	disk: diskSchema.optional(),
	hw: z
		.record(
			z.string(),
			z.union([
				hwScalar,
				z.record(z.string(), z.union([z.string(), z.number()])),
			]),
		)
		.optional(),
	build_vm: buildVmSchema.optional(),
	steps: z
		.array(
			z
				.string()
				.regex(
					new RegExp(`^(${PARENT_TOKEN}|${STEP_PATTERN})$`),
					"invalid step name",
				),
		)
		.optional(),
	seal: z.enum(["umiak-agent", "sysprep"]).optional(),
	offline: z.array(z.enum(OFFLINE_STAGES)).optional(),
	options: z.strictObject({ vs_buildtools: z.boolean().optional() }).optional(),
	boot_timeout_s: z.number().int().positive().optional(),
	install_timeout_s: z.number().int().positive().optional(),
	/** Minutes per script step (windows); steps not listed get the runner's default. */
	step_timeouts: z.record(z.string(), z.number().int().positive()).optional(),
	verify: z.string().min(1).optional(),
	/** Template slots this recipe builds into, in order (not inherited: each template has its own). */
	vmids: z.array(z.number().int().positive()).min(1),
});

interface RecipeBase {
	slug: string;
	extends: string | null;
	disk: { slot: "scsi0"; sizeGb: number };
	/**
	 * Proxmox config values as strings; `cloudinit` and the firmware disks are
	 * lifted out into the fields below. `machine` may be `pinned` (windows).
	 */
	hw: Record<string, string>;
	/** Options of `efidisk0`/`tpmstate0` without the volume: the builder allocates it. */
	firmwareDisks: Partial<Record<FirmwareDisk, Record<string, string>>>;
	cloudinit: boolean;
	buildVm: { cores: number; memoryMb: number };
	steps: string[];
	seal: "umiak-agent" | "sysprep";
	/** Stages of the offline WinPE boot after sysprep (windows; empty for linux). */
	offline: OfflineStage[];
	options: { vsBuildtools: boolean };
	bootTimeoutS: number;
	/** iso-install: how long the builder waits for QGA after starting Windows Setup. */
	installTimeoutS: number;
	/** `step_timeouts`: minutes per script step, merged over the parent's (windows; empty for linux). */
	stepTimeoutsMin: Record<string, number>;
	verify: string;
	/** Shared directory name (`_windows`); its files have the lowest lookup priority. */
	shared?: string;
	/** Template slots (VMIDs) this recipe builds into, first free one wins. */
	vmids: number[];
	/** Directory of this recipe. */
	dir: string;
	/** Lookup order lowest priority first: shared dir, parent recipe directories, this recipe's directory last. */
	stepDirs: string[];
}

export interface LinuxRecipe extends RecipeBase {
	os: "linux";
	source: CloudImageSource;
	seal: "umiak-agent";
}

export interface WindowsRecipe extends RecipeBase {
	os: "windows";
	source: IsoInstallSource;
	seal: "sysprep";
}

export type Recipe = LinuxRecipe | WindowsRecipe;
export type RecipeOs = Recipe["os"];

function formatError(file: string, err: unknown): Error {
	if (err instanceof z.ZodError)
		return new Error(`${file}: ${z.prettifyError(err)}`);
	return new Error(
		`${file}: ${err instanceof Error ? err.message : String(err)}`,
	);
}

function assertSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) throw new Error(`invalid template slug "${slug}"`);
}

type RawHw = NonNullable<z.infer<typeof recipeFileSchema>["hw"]>;

function splitHw(hw: RawHw): {
	hw: Record<string, string>;
	cloudinit?: boolean;
	firmwareDisks: RecipeBase["firmwareDisks"];
} {
	const out: Record<string, string> = {};
	const firmwareDisks: RecipeBase["firmwareDisks"] = {};
	let cloudinit: boolean | undefined;
	for (const [k, v] of Object.entries(hw)) {
		if ((FIRMWARE_DISKS as readonly string[]).includes(k)) {
			if (typeof v !== "object")
				throw new Error(
					`hw.${k} must be an object of options, e.g. { version: v2.0 }`,
				);
			firmwareDisks[k as FirmwareDisk] = Object.fromEntries(
				Object.entries(v).map(([o, ov]) => [o, String(ov)]),
			);
		} else if (typeof v === "object") {
			throw new Error(`hw.${k} must be a string or number`);
		} else if (k === "cloudinit") {
			if (typeof v !== "boolean")
				throw new Error(`hw.cloudinit must be a boolean`);
			cloudinit = v;
		} else if (typeof v === "boolean") {
			throw new Error(`hw.${k} must be a string or number`);
		} else {
			out[k] = String(v);
		}
	}
	return cloudinit === undefined
		? { hw: out, firmwareDisks }
		: { hw: out, cloudinit, firmwareDisks };
}

function loadRecipeChain(
	templatesDir: string,
	slug: string,
	chain: string[],
): Recipe {
	assertSlug(slug);
	const dir = join(templatesDir, slug);
	const file = join(dir, "template.yaml");
	if (!existsSync(file)) throw new Error(`recipe "${slug}" not found: ${file}`);

	let raw: z.infer<typeof recipeFileSchema>;
	try {
		raw = recipeFileSchema.parse(parseYaml(readFileSync(file, "utf8")));
	} catch (err) {
		throw formatError(file, err);
	}
	if (raw.slug !== slug)
		throw new Error(
			`${file}: slug "${raw.slug}" does not match directory "${slug}"`,
		);

	const parentSlug = raw.extends ?? null;
	const here = [...chain, slug];
	let parent: Recipe | null = null;
	if (parentSlug !== null) {
		if (here.includes(parentSlug)) {
			throw new Error(
				`${file}: extends cycle: ${[...here, parentSlug].join(" -> ")}`,
			);
		}
		parent = loadRecipeChain(templatesDir, parentSlug, here);
		if (parent.os !== raw.os)
			throw new Error(
				`${file}: os "${raw.os}" differs from parent "${parentSlug}" (${parent.os})`,
			);
	}

	try {
		const split = raw.hw ? splitHw(raw.hw) : { hw: {}, firmwareDisks: {} };
		const cloudinit = split.cloudinit ?? parent?.cloudinit ?? false;
		const hw = { ...parent?.hw, ...split.hw };
		const firmwareDisks = { ...parent?.firmwareDisks, ...split.firmwareDisks };

		let steps: string[] | undefined;
		if (raw.steps) {
			if (raw.steps.includes(PARENT_TOKEN) && parent === null) {
				throw new Error(
					`steps use ${PARENT_TOKEN} but the recipe has no extends`,
				);
			}
			steps = raw.steps.flatMap((s) =>
				s === PARENT_TOKEN ? (parent?.steps ?? []) : [s],
			);
		} else {
			steps = parent?.steps;
		}

		const disk = raw.disk
			? { slot: raw.disk.slot, sizeGb: Number.parseInt(raw.disk.size, 10) }
			: parent?.disk;
		const buildVm = raw.build_vm
			? { cores: raw.build_vm.cores, memoryMb: raw.build_vm.memory_mb }
			: parent?.buildVm;
		const source = raw.source ?? parent?.source;
		const seal = raw.seal ?? parent?.seal;
		const bootTimeoutS = raw.boot_timeout_s ?? parent?.bootTimeoutS;
		const verify = raw.verify ?? parent?.verify;
		const offline = raw.offline ?? parent?.offline ?? [];
		const options = raw.options
			? { vsBuildtools: raw.options.vs_buildtools ?? false }
			: (parent?.options ?? { vsBuildtools: false });
		const installTimeoutS =
			raw.install_timeout_s ??
			parent?.installTimeoutS ??
			DEFAULT_INSTALL_TIMEOUT_S;
		const stepTimeoutsMin = {
			...parent?.stepTimeoutsMin,
			...raw.step_timeouts,
		};

		const shared = raw.shared ?? parent?.shared;
		let sharedDir: string | undefined;
		if (shared !== undefined) {
			sharedDir = join(templatesDir, shared);
			if (!existsSync(sharedDir))
				throw new Error(`shared directory "${shared}" not found: ${sharedDir}`);
		}
		const parentShared =
			parent?.shared !== undefined ? join(templatesDir, parent.shared) : null;
		const ownDirs = [
			...(parent?.stepDirs.filter((d) => d !== parentShared) ?? []),
			dir,
		];

		const missing = Object.entries({
			source,
			disk,
			hw: raw.hw ?? parent,
			build_vm: buildVm,
			steps,
			seal,
			boot_timeout_s: bootTimeoutS,
			verify,
		})
			.filter(([, v]) => v === undefined || v === null)
			.map(([k]) => k);
		if (
			missing.length > 0 ||
			!source ||
			!disk ||
			!buildVm ||
			!steps ||
			!seal ||
			bootTimeoutS === undefined ||
			!verify
		) {
			throw new Error(`missing required fields: ${missing.join(", ")}`);
		}
		for (const step of Object.keys(stepTimeoutsMin))
			if (
				!steps.includes(step) ||
				step === REBOOT_STEP ||
				(raw.os === "windows" && step === NETWORK_UP_STEP)
			)
				throw new Error(
					`step_timeouts: "${step}" is not a script step of the recipe`,
				);

		const base = {
			slug,
			extends: parentSlug,
			disk,
			hw,
			firmwareDisks,
			cloudinit,
			buildVm,
			steps,
			offline,
			options,
			bootTimeoutS,
			installTimeoutS,
			stepTimeoutsMin,
			verify,
			...(shared !== undefined ? { shared } : {}),
			vmids: raw.vmids,
			dir,
			stepDirs: sharedDir !== undefined ? [sharedDir, ...ownDirs] : ownDirs,
		};

		if (raw.os === "windows") {
			if (source.kind !== "iso-install")
				throw new Error(`os windows requires source.kind iso-install`);
			if (seal !== "sysprep")
				throw new Error(`os windows requires seal: sysprep`);
			return { ...base, os: "windows", source, seal };
		}

		if (source.kind !== "cloud-image")
			throw new Error(`os linux requires source.kind cloud-image`);
		if (seal !== "umiak-agent")
			throw new Error(`os linux requires seal: umiak-agent`);
		// The linux pipeline would silently ignore these: reject them instead.
		for (const key of [
			"offline",
			"options",
			"install_timeout_s",
			"step_timeouts",
		] as const)
			if (raw[key] !== undefined)
				throw new Error(`${key} is supported only for os windows`);
		const firmwareDisk = Object.keys(firmwareDisks)[0];
		if (firmwareDisk !== undefined)
			throw new Error(`hw.${firmwareDisk} is supported only for os windows`);
		if (hw.machine === PINNED_MACHINE)
			throw new Error(
				`hw.machine: ${PINNED_MACHINE} is supported only for os windows`,
			);
		return { ...base, os: "linux", source, seal };
	} catch (err) {
		throw formatError(file, err);
	}
}

export function loadRecipe(templatesDir: string, slug: string): Recipe;
export function loadRecipe<O extends RecipeOs>(
	templatesDir: string,
	slug: string,
	os: O,
): Extract<Recipe, { os: O }>;
/** Loads and merges a recipe; with `os`, also checks the recipe is for that OS. */
export function loadRecipe(
	templatesDir: string,
	slug: string,
	os?: RecipeOs,
): Recipe {
	const recipe = loadRecipeChain(
		templatesDir,
		slug === "windows-desktop" ? "windows" : slug,
		[],
	);
	if (os !== undefined && recipe.os !== os)
		throw new Error(`recipe "${slug}" is for ${recipe.os}, expected ${os}`);
	return recipe;
}

/** Steps the builder runs itself: `reboot` everywhere, `network-up` on windows. */
export function isBuiltinStep(recipe: Recipe, step: string): boolean {
	return (
		step === REBOOT_STEP ||
		(recipe.os === "windows" && step === NETWORK_UP_STEP)
	);
}

/** Absolute path of a recipe file (relative path), looked up child recipe first, shared dir last. */
export function recipeFile(recipe: Recipe, rel: string): string {
	const parts = rel.split("/");
	if (parts.some((p) => p === "" || p === "." || p === ".."))
		throw new Error(`invalid recipe file path "${rel}"`);
	for (const d of [...recipe.stepDirs].reverse()) {
		const p = join(d, rel);
		if (existsSync(p)) return p;
	}
	throw new Error(
		`${rel} not found for recipe "${recipe.slug}" in: ${recipe.stepDirs.join(", ")}`,
	);
}

/** Absolute path of `steps/<step>.sh` (linux) or `steps/<step>.ps1` (windows), looked up child recipe first. */
export function stepFile(recipe: Recipe, step: string): string {
	if (isBuiltinStep(recipe, step))
		throw new Error(`step "${step}" is built in and has no file`);
	if (!STEP_RE.test(step)) throw new Error(`invalid step name "${step}"`);
	const ext = recipe.os === "windows" ? "ps1" : "sh";
	for (const d of [...recipe.stepDirs].reverse()) {
		const p = join(d, "steps", `${step}.${ext}`);
		if (existsSync(p)) return p;
	}
	throw new Error(
		`step file "${step}.${ext}" not found for recipe "${recipe.slug}" in: ${recipe.stepDirs.join(", ")}`,
	);
}

/** sha256 over relative paths and contents of every file in the recipe directories. */
export function recipeDigest(recipe: Recipe): string {
	const h = createHash("sha256");
	recipe.stepDirs.forEach((dir, i) => {
		const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
			.filter(
				(rel) =>
					!rel.split("/").includes(".DS_Store") &&
					statSync(join(dir, rel)).isFile(),
			)
			.sort();
		for (const rel of files) {
			const data = readFileSync(join(dir, rel));
			h.update(`${i}\0${rel}\0${data.length}\0`);
			h.update(data);
		}
	});
	return h.digest("hex");
}

// Versions (versions.toml, spec S5 section 6.3)

const hex64 = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");
const versionSha = z.strictObject({
	version: z.string().min(1),
	sha256: hex64,
});
const nonEmpty = z.string().min(1);

export const versionsSchema = z.strictObject({
	base: z.strictObject({
		serial: z.string().regex(/^\d{8}(\.\d+)?$/),
		sha256: hex64,
	}),
	apt: z.strictObject({ snapshot: z.string().regex(/^\d{8}T\d{6}Z$/) }),
	docker: z.strictObject({
		docker_ce: nonEmpty,
		containerd_io: nonEmpty,
		compose_plugin: nonEmpty,
		buildx_plugin: nonEmpty,
	}),
	tools: z.strictObject({
		node: versionSha,
		go: versionSha,
		bun: versionSha,
		uv: versionSha,
		gh: versionSha,
		rust: z.strictObject({
			version: nonEmpty,
			rustup_version: nonEmpty,
			rustup_init_sha256: hex64,
		}),
	}),
	chrome: z.strictObject({ google_chrome_stable: versionSha }),
	npm: z.record(z.string(), nonEmpty),
	umiak: z.strictObject({ cli: versionSha }).optional(),
	// The desktop stack is optional for headless recipes, complete when present.
	desktop: z
		.strictObject({
			sunshine: versionSha,
			moonlight_web: versionSha,
			cua_driver: versionSha,
			cosign: versionSha.optional(),
		})
		.optional(),
});

export type Versions = z.infer<typeof versionsSchema>;

type Section = Record<string, unknown>;

function isSection(v: unknown): v is Section {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge section by section; an entry (key inside a section) is replaced as a whole. */
function mergeVersions(base: Section, over: Section): Section {
	const out: Section = { ...base };
	for (const [name, section] of Object.entries(over)) {
		const prev = out[name];
		out[name] =
			isSection(prev) && isSection(section) ? { ...prev, ...section } : section;
	}
	return out;
}

function mergedVersionsFiles(recipe: Recipe): {
	merged: Section;
	label: string;
} {
	let merged: Section = {};
	const files: string[] = [];
	for (const dir of recipe.stepDirs) {
		const file = join(dir, "versions.toml");
		if (!existsSync(file)) continue;
		files.push(file);
		try {
			merged = mergeVersions(merged, parseToml(readFileSync(file, "utf8")));
		} catch (err) {
			throw formatError(file, err);
		}
	}
	return {
		merged,
		label:
			files.length > 0
				? files.join(" + ")
				: `${recipe.dir}/versions.toml (missing)`,
	};
}

// Windows versions (versions.toml, spec S9 section 5.1)

export const WINDOWS_TOOLS = [
	"pwsh",
	"git",
	"node",
	"python",
	"go",
	"bun",
	"uv",
	"gh",
] as const;
export type WindowsTool = (typeof WINDOWS_TOOLS)[number];

const toolPin = z.strictObject({
	version: nonEmpty,
	url: z.url({ protocol: /^https$/ }),
	sha256: hex64,
});

/** Shape of the TOML file (snake_case); `loadVersions` returns it as `WindowsVersions`. */
export const windowsVersionsSchema = z.strictObject({
	iso: z.strictObject({
		file: z
			.string()
			.regex(/^[A-Za-z0-9._()+-]+\.iso$/, "expected an ISO file name"),
		// Required key; "" means not known yet (see WindowsVersions.iso.sha256).
		sha256: z.union([z.literal(""), hex64]),
		edition: nonEmpty,
		// TOML has no null: an absent key means no product key (evaluation media).
		product_key: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/)
			.optional(),
		channel: z.enum(["retail", "evaluation", "volume"]),
		ui_language: z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/),
	}),
	virtio_win: z.strictObject({
		version: z.string().regex(/^\d+\.\d+\.\d+$/),
		sha256: hex64,
	}),
	tools: z.strictObject(
		Object.fromEntries(WINDOWS_TOOLS.map((t) => [t, toolPin])) as Record<
			WindowsTool,
			typeof toolPin
		>,
	),
	npm: z.record(z.string(), nonEmpty),
	openssh: z.strictObject({ source: z.enum(["inbox", "github"]) }),
});

export type WindowsVersionsToml = z.infer<typeof windowsVersionsSchema>;

export interface WindowsVersions {
	iso: {
		/** File name of the user's ISO in local:iso. */
		file: string;
		/**
		 * sha256 of the user's ISO, or "" while it is not known yet. The
		 * iso-install pipeline refuses to build with "" unless
		 * `--accept-iso-sha256` is given, which computes it on the node and
		 * writes it into versions.toml.
		 */
		sha256: string;
		/** `/IMAGE/NAME` in install.wim. */
		edition: string;
		/** Name of a key in `_windows/keys.toml` (see `resolveProductKey`); null for evaluation media. */
		productKey: string | null;
		channel: "retail" | "evaluation" | "volume";
		uiLanguage: string;
	};
	/** Pinned by hand; `versions --update` never changes it. */
	virtioWin: { version: string; sha256: string };
	tools: Record<WindowsTool, { version: string; sha256: string; url: string }>;
	npm: Record<string, string>;
	openssh: { source: "inbox" | "github" };
}

export function windowsVersionsFromToml(
	t: WindowsVersionsToml,
): WindowsVersions {
	return {
		iso: {
			file: t.iso.file,
			sha256: t.iso.sha256,
			edition: t.iso.edition,
			productKey: t.iso.product_key ?? null,
			channel: t.iso.channel,
			uiLanguage: t.iso.ui_language,
		},
		virtioWin: { ...t.virtio_win },
		tools: t.tools,
		npm: t.npm,
		openssh: { ...t.openssh },
	};
}

export function windowsVersionsToToml(v: WindowsVersions): WindowsVersionsToml {
	return {
		iso: {
			file: v.iso.file,
			sha256: v.iso.sha256,
			edition: v.iso.edition,
			...(v.iso.productKey !== null ? { product_key: v.iso.productKey } : {}),
			channel: v.iso.channel,
			ui_language: v.iso.uiLanguage,
		},
		virtio_win: { ...v.virtioWin },
		tools: v.tools,
		npm: v.npm,
		openssh: { ...v.openssh },
	};
}

export function loadVersions(recipe: LinuxRecipe): Versions;
export function loadVersions(recipe: WindowsRecipe): WindowsVersions;
export function loadVersions(recipe: Recipe): Versions | WindowsVersions;
/** Pins from the parent recipes' versions.toml, overridden by the recipe's own file. */
export function loadVersions(recipe: Recipe): Versions | WindowsVersions {
	const { merged, label } = mergedVersionsFiles(recipe);
	try {
		return recipe.os === "windows"
			? windowsVersionsFromToml(windowsVersionsSchema.parse(merged))
			: versionsSchema.parse(merged);
	} catch (err) {
		throw formatError(label, err);
	}
}

export const PRODUCT_KEY_RE = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/;

/** The product key named `name` in `keys.toml` (recipe dir first, shared dir last). */
export function resolveProductKey(recipe: Recipe, name: string): string {
	const file = recipeFile(recipe, "keys.toml");
	let keys: Record<string, unknown>;
	try {
		keys = parseToml(readFileSync(file, "utf8"));
	} catch (err) {
		throw formatError(file, err);
	}
	const key = keys[name];
	if (key === undefined) throw new Error(`${file}: no key named "${name}"`);
	if (typeof key !== "string" || !PRODUCT_KEY_RE.test(key))
		throw new Error(
			`${file}: key "${name}" is not a XXXXX-XXXXX-XXXXX-XXXXX-XXXXX product key`,
		);
	return key;
}
