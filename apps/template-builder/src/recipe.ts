import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Recipe (template.yaml, spec S5 section 5)

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const STEP_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]*";
const STEP_RE = new RegExp(`^${STEP_PATTERN}$`);
const PARENT_TOKEN = "@parent";
export const REBOOT_STEP = "reboot";

const sourceSchema = z.strictObject({
	kind: z.literal("cloud-image"),
	distro: z.literal("ubuntu"),
	release: z.string().min(1),
	flavor: z.enum(["minimal", "server"]),
});

const diskSchema = z.strictObject({
	slot: z.literal("scsi0"),
	size: z.string().regex(/^[1-9]\d*G$/, "expected whole gigabytes, e.g. 64G"),
});

const buildVmSchema = z.strictObject({
	cores: z.number().int().positive(),
	memory_mb: z.number().int().positive(),
});

// Every field except slug and os is optional in the file: a recipe with
// `extends` inherits the rest. Required-ness of a root recipe is checked after merging.
const recipeFileSchema = z.strictObject({
	slug: z.string().regex(SLUG_RE),
	os: z.enum(["linux", "windows"]),
	extends: z.string().regex(SLUG_RE).nullable().optional(),
	source: sourceSchema.optional(),
	disk: diskSchema.optional(),
	hw: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
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
	seal: z.literal("sbx-agent").optional(),
	boot_timeout_s: z.number().int().positive().optional(),
	verify: z.string().min(1).optional(),
	/** Template slots this recipe builds into, in order (not inherited: each template has its own). */
	vmids: z.array(z.number().int().positive()).min(1),
});

export interface Recipe {
	slug: string;
	os: "linux" | "windows";
	extends: string | null;
	source: z.infer<typeof sourceSchema>;
	disk: { slot: "scsi0"; sizeGb: number };
	/** Proxmox config values as strings; `cloudinit` is lifted out into the field below. */
	hw: Record<string, string>;
	cloudinit: boolean;
	buildVm: { cores: number; memoryMb: number };
	steps: string[];
	seal: "sbx-agent";
	bootTimeoutS: number;
	verify: string;
	/** Template slots (VMIDs) this recipe builds into, first free one wins. */
	vmids: number[];
	/** Directory of this recipe. */
	dir: string;
	/** Parent recipe directories first, this recipe's directory last. */
	stepDirs: string[];
}

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

function splitHw(hw: Record<string, string | number | boolean>): {
	hw: Record<string, string>;
	cloudinit?: boolean;
} {
	const out: Record<string, string> = {};
	let cloudinit: boolean | undefined;
	for (const [k, v] of Object.entries(hw)) {
		if (k === "cloudinit") {
			if (typeof v !== "boolean")
				throw new Error(`hw.cloudinit must be a boolean`);
			cloudinit = v;
		} else if (typeof v === "boolean") {
			throw new Error(`hw.${k} must be a string or number`);
		} else {
			out[k] = String(v);
		}
	}
	return cloudinit === undefined ? { hw: out } : { hw: out, cloudinit };
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
		const split = raw.hw ? splitHw(raw.hw) : { hw: {} };
		const cloudinit = split.cloudinit ?? parent?.cloudinit ?? false;
		const hw = { ...parent?.hw, ...split.hw };

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

		return {
			slug,
			os: raw.os,
			extends: parentSlug,
			source,
			disk,
			hw,
			cloudinit,
			buildVm,
			steps,
			seal,
			bootTimeoutS,
			verify,
			vmids: raw.vmids,
			dir,
			stepDirs: [...(parent?.stepDirs ?? []), dir],
		};
	} catch (err) {
		throw formatError(file, err);
	}
}

export function loadRecipe(templatesDir: string, slug: string): Recipe {
	return loadRecipeChain(templatesDir, slug, []);
}

/** Absolute path of `steps/<step>.sh`, looked up child recipe first. */
export function stepFile(recipe: Recipe, step: string): string {
	if (step === REBOOT_STEP)
		throw new Error(`step "${REBOOT_STEP}" is built in and has no file`);
	if (!STEP_RE.test(step)) throw new Error(`invalid step name "${step}"`);
	for (const d of [...recipe.stepDirs].reverse()) {
		const p = join(d, "steps", `${step}.sh`);
		if (existsSync(p)) return p;
	}
	throw new Error(
		`step file "${step}.sh" not found for recipe "${recipe.slug}" in: ${recipe.stepDirs.join(", ")}`,
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
		rust: z.strictObject({ version: nonEmpty, rustup_init_sha256: hex64 }),
	}),
	chrome: z.strictObject({ google_chrome_stable: versionSha }),
	npm: z.record(z.string(), nonEmpty),
	sbx: z.strictObject({ cli: versionSha }).optional(),
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

/** Pins from the parent recipes' versions.toml, overridden by the recipe's own file. */
export function loadVersions(recipe: Recipe): Versions {
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
	try {
		return versionsSchema.parse(merged);
	} catch (err) {
		throw formatError(
			files.length > 0
				? files.join(" + ")
				: `${recipe.dir}/versions.toml (missing)`,
			err,
		);
	}
}
