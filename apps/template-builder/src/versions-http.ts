import { createHash } from "node:crypto";
import { z } from "zod";

// HTTP sources shared by the linux and windows `versions --update`

export type Fetch = (
	url: string,
) => Promise<{ status: number; text(): Promise<string> }>;

/** Downloads `url` and returns its sha256 (lowercase hex); used when a vendor publishes no checksum. */
export type HashDownload = (url: string) => Promise<string>;

const FETCH_TIMEOUT_MS = 60_000;

/** Global fetch with a timeout; GitHub API requests use GITHUB_TOKEN when set. */
export const defaultFetch: Fetch = (url) => {
	const headers: Record<string, string> = { "User-Agent": "sbx-tpl" };
	if (new URL(url).host === "api.github.com") {
		headers.Accept = "application/vnd.github+json";
		if (process.env.GITHUB_TOKEN)
			headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}
	return fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
};

/** Streams the body into sha256; nothing is written to disk. */
export const defaultHashDownload: HashDownload = async (url) => {
	const res = await fetch(url, { headers: { "User-Agent": "sbx-tpl" } });
	if (res.status !== 200 || !res.body)
		throw new Error(`GET ${url}: HTTP ${res.status}`);
	const h = createHash("sha256");
	for await (const chunk of res.body) h.update(chunk);
	return h.digest("hex");
};

export async function get(fetch: Fetch, url: string): Promise<string> {
	let status: number;
	let body: string;
	try {
		const res = await fetch(url);
		status = res.status;
		body = status === 200 ? await res.text() : "";
	} catch (err) {
		throw new Error(
			`GET ${url}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (status !== 200) throw new Error(`GET ${url}: HTTP ${status}`);
	return body;
}

export async function getJson<T>(
	fetch: Fetch,
	url: string,
	schema: z.ZodType<T>,
): Promise<T> {
	const body = await get(fetch, url);
	try {
		return schema.parse(JSON.parse(body));
	} catch (err) {
		throw new Error(
			`GET ${url}: unexpected response: ${err instanceof z.ZodError ? z.prettifyError(err) : String(err)}`,
		);
	}
}

/** sha256 for `file` from a `sha256sum`-style listing (`<hex>  name`, `<hex> *name`, `<hex> *./name`). */
export function findChecksum(
	listing: string,
	file: string,
	url: string,
): string {
	for (const line of listing.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line);
		if (m?.[1] && m[2] === file) return m[1].toLowerCase();
	}
	throw new Error(`${url}: no sha256 entry for ${file}`);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function assertSemver(v: string, url: string): string {
	if (!SEMVER_RE.test(v)) throw new Error(`${url}: unexpected version "${v}"`);
	return v;
}

export function compareNumericDotted(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

// Node.js

export const NODE_INDEX = "https://nodejs.org/dist/index.json";

/** Newest LTS version from nodejs.org/dist/index.json. */
export async function latestNodeLts(fetch: Fetch): Promise<string> {
	const index = await getJson(
		fetch,
		NODE_INDEX,
		z.array(
			z.object({
				version: z.string().startsWith("v"),
				lts: z.union([z.literal(false), z.string()]),
			}),
		),
	);
	const lts = index
		.filter((e) => e.lts !== false)
		.map((e) => e.version.slice(1))
		.sort(compareNumericDotted)
		.at(-1);
	if (!lts) throw new Error(`${NODE_INDEX}: no LTS release`);
	return assertSemver(lts, NODE_INDEX);
}

/** sha256 of a file of node `version` from its SHASUMS256.txt. */
export async function nodeChecksum(
	fetch: Fetch,
	version: string,
	file: string,
): Promise<string> {
	const sums = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
	return findChecksum(await get(fetch, sums), file, sums);
}

// Go

export const GO_DL = "https://go.dev/dl/?mode=json";

const goFileSchema = z.object({
	filename: z.string().optional(),
	os: z.string(),
	arch: z.string(),
	kind: z.string(),
	sha256: z.string(),
});

/** The first stable release in go.dev/dl, with its version without the `go` prefix. */
export async function latestGo(fetch: Fetch): Promise<{
	version: string;
	file(os: string, arch: string, kind: string): z.infer<typeof goFileSchema>;
}> {
	const releases = await getJson(
		fetch,
		GO_DL,
		z.array(
			z.object({
				version: z.string(),
				stable: z.boolean(),
				files: z.array(goFileSchema),
			}),
		),
	);
	const release = releases.find((r) => r.stable);
	if (!release) throw new Error(`${GO_DL}: no stable release`);
	return {
		version: assertSemver(release.version.replace(/^go/, ""), GO_DL),
		file(os, arch, kind) {
			const f = release.files.find(
				(x) => x.os === os && x.arch === arch && x.kind === kind,
			);
			if (!f)
				throw new Error(
					`${GO_DL}: ${release.version} has no ${os}-${arch} ${kind}`,
				);
			return f;
		},
	};
}

// GitHub releases

export const releaseSchema = z.object({
	tag_name: z.string(),
	prerelease: z.boolean().optional(),
	draft: z.boolean().optional(),
	assets: z.array(
		z.object({
			name: z.string(),
			browser_download_url: z.string(),
			/** `sha256:<hex>`; GitHub computes it for assets uploaded since 2025. */
			digest: z.string().nullable().optional(),
		}),
	),
});

export type GithubRelease = z.infer<typeof releaseSchema>;
export type GithubAsset = GithubRelease["assets"][number];

/** The named asset of a release; throws naming the release when it is missing. */
export function releaseAsset(
	release: GithubRelease,
	name: string,
	url: string,
): GithubAsset {
	const asset = release.assets.find((a) => a.name === name);
	if (!asset)
		throw new Error(`${url}: release ${release.tag_name} has no asset ${name}`);
	return asset;
}

/** Latest GitHub release; `assetUrl` throws when the release has no such asset. */
export async function githubLatest(
	fetch: Fetch,
	repo: string,
	tagPrefix: string,
): Promise<{
	version: string;
	release: GithubRelease;
	url: string;
	assetUrl(name: string): string;
}> {
	const url = `https://api.github.com/repos/${repo}/releases/latest`;
	const release = await getJson(fetch, url, releaseSchema);
	if (!release.tag_name.startsWith(tagPrefix))
		throw new Error(`${url}: unexpected tag "${release.tag_name}"`);
	return {
		version: assertSemver(release.tag_name.slice(tagPrefix.length), url),
		release,
		url,
		assetUrl: (name) => releaseAsset(release, name, url).browser_download_url,
	};
}

// npm

/** Latest version of each package (`npm view <pkg> version`, read from the registry). */
export async function resolveNpm(
	fetch: Fetch,
	names: string[],
): Promise<Record<string, string>> {
	const entries = await Promise.all(
		names.map(async (name) => {
			const { version } = await getJson(
				fetch,
				`https://registry.npmjs.org/${name}/latest`,
				z.object({ version: z.string().min(1) }),
			);
			return [name, version] as const;
		}),
	);
	return Object.fromEntries(entries);
}

/** Default package list first, then extra packages already pinned in the file (sorted). */
export function npmNames(defaults: string[], prevNpm: unknown): string[] {
	const pinned =
		typeof prevNpm === "object" && prevNpm !== null ? Object.keys(prevNpm) : [];
	return [...defaults, ...pinned.filter((n) => !defaults.includes(n)).sort()];
}

// Output helpers

export const UPDATE_HEADER =
	"# Generated by sbx-tpl versions --update; edit by hand only to pin.";

export function tomlKey(k: string): string {
	return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

export function sortedEntries<V>(o: Record<string, V>): [string, V][] {
	return Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

type Section = Record<string, unknown>;

function flatten(value: unknown, prefix: string, out: Map<string, string>) {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value))
			flatten(v, prefix ? `${prefix}.${k}` : k, out);
	} else {
		out.set(prefix, String(value));
	}
}

/** `name: old -> new` for every entry that differs; `(none)` marks an absent side. */
export function diffVersions(prev: Section | null, next: Section): string[] {
	const before = new Map<string, string>();
	const after = new Map<string, string>();
	if (prev) flatten(prev, "", before);
	flatten(next, "", after);
	const changes: string[] = [];
	for (const [k, v] of after) {
		const old = before.get(k);
		if (old !== v) changes.push(`${k}: ${old ?? "(none)"} -> ${v}`);
	}
	for (const [k, v] of before)
		if (!after.has(k)) changes.push(`${k}: ${v} -> (none)`);
	return changes;
}
