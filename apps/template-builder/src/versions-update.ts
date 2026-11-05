import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadRecipe, loadVersions, type Recipe } from "./recipe.ts";
import {
	defaultFetch,
	defaultHashDownload,
	type Fetch,
	type HashDownload,
} from "./versions-http.ts";
import {
	formatVersionsToml,
	updateLinuxVersions,
} from "./versions-update-linux.ts";
import {
	formatWindowsVersionsToml,
	updateWindowsVersions,
} from "./versions-update-windows.ts";

// `umiak-tpl versions <slug> [--update]`: dispatch by recipe os

export {
	defaultFetch,
	type Fetch,
	findChecksum,
	type HashDownload,
} from "./versions-http.ts";
export {
	BASE_IMAGE,
	compareDebVersions,
	DEFAULT_NPM_PACKAGES,
	formatVersionsToml,
	resolveLatest,
	UBUNTU_MINIMAL,
} from "./versions-update-linux.ts";

/** The recipe's merged pins in versions.toml format. */
export function formatRecipeVersions(recipe: Recipe): string {
	return recipe.os === "windows"
		? formatWindowsVersionsToml(loadVersions(recipe))
		: formatVersionsToml(loadVersions(recipe));
}

export interface UpdateOptions {
	templatesDir: string;
	slug: string;
	fetch?: Fetch;
	/** Windows: hashes downloads whose vendor publishes no sha256. */
	hashDownload?: HashDownload;
	now?: Date;
}

/** Re-resolves every pin, rewrites the recipe's `versions.toml` and lists what changed. */
export async function updateVersionsFile(opts: UpdateOptions): Promise<{
	file: string;
	text: string;
	changes: string[];
	warnings: string[];
}> {
	const recipe = loadRecipe(opts.templatesDir, opts.slug);
	if (recipe.extends !== null)
		throw new Error(
			`recipe "${recipe.slug}" extends "${recipe.extends}": versions --update supports root recipes only`,
		);
	const file = join(recipe.dir, "versions.toml");
	let prev: Record<string, unknown> | null = null;
	if (existsSync(file)) {
		try {
			prev = parseToml(readFileSync(file, "utf8"));
		} catch (err) {
			throw new Error(
				`${file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	const fetch = opts.fetch ?? defaultFetch;
	const res =
		recipe.os === "windows"
			? await updateWindowsVersions(
					file,
					prev,
					fetch,
					opts.hashDownload ?? defaultHashDownload,
				)
			: {
					...(await updateLinuxVersions(
						file,
						prev,
						fetch,
						opts.now ?? new Date(),
					)),
					warnings: [],
				};
	writeFileSync(file, res.text);
	return { file, ...res };
}
