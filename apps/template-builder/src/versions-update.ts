import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { loadRecipe, type Versions, versionsSchema } from "./recipe.ts";

// `sbx-tpl versions --update`: latest stable versions and official checksums (spec S5 section 6.3)

export type Fetch = (
	url: string,
) => Promise<{ status: number; text(): Promise<string> }>;

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

export const DEFAULT_NPM_PACKAGES = [
	"@anthropic-ai/claude-code",
	"@openai/codex",
	"opencode-ai",
	"@google/gemini-cli",
	"pnpm",
];

const UBUNTU_MINIMAL =
	"https://cloud-images.ubuntu.com/minimal/releases/resolute/";
const BASE_IMAGE = "ubuntu-26.04-minimal-cloudimg-amd64.img";
const DOCKER_PACKAGES =
	"https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages";
const CHROME_PACKAGES =
	"https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages";

async function get(fetch: Fetch, url: string): Promise<string> {
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

async function getJson<T>(
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
function findChecksum(listing: string, file: string, url: string): string {
	for (const line of listing.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line);
		if (m?.[1] && m[2] === file) return m[1].toLowerCase();
	}
	throw new Error(`${url}: no sha256 entry for ${file}`);
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function assertSemver(v: string, url: string): string {
	if (!SEMVER_RE.test(v)) throw new Error(`${url}: unexpected version "${v}"`);
	return v;
}

// Debian version comparison (dpkg algorithm)

function isDigit(c: string | undefined): boolean {
	return c !== undefined && c >= "0" && c <= "9";
}

function order(c: string | undefined): number {
	if (c === undefined || isDigit(c)) return 0;
	if (c === "~") return -1;
	if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
	return c.charCodeAt(0) + 256;
}

function compareFragment(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		while (
			(i < a.length && !isDigit(a[i])) ||
			(j < b.length && !isDigit(b[j]))
		) {
			const diff = order(a[i]) - order(b[j]);
			if (diff !== 0) return diff;
			i++;
			j++;
		}
		while (a[i] === "0") i++;
		while (b[j] === "0") j++;
		let firstDiff = 0;
		while (isDigit(a[i]) && isDigit(b[j])) {
			if (firstDiff === 0)
				firstDiff =
					(a[i] as string).charCodeAt(0) - (b[j] as string).charCodeAt(0);
			i++;
			j++;
		}
		if (isDigit(a[i])) return 1;
		if (isDigit(b[j])) return -1;
		if (firstDiff !== 0) return firstDiff;
	}
	return 0;
}

function splitDebVersion(v: string): {
	epoch: number;
	upstream: string;
	revision: string;
} {
	let rest = v;
	let epoch = 0;
	const colon = rest.indexOf(":");
	if (colon > 0 && /^\d+$/.test(rest.slice(0, colon))) {
		epoch = Number.parseInt(rest.slice(0, colon), 10);
		rest = rest.slice(colon + 1);
	}
	const dash = rest.lastIndexOf("-");
	return dash < 0
		? { epoch, upstream: rest, revision: "" }
		: { epoch, upstream: rest.slice(0, dash), revision: rest.slice(dash + 1) };
}

/** Negative, zero or positive like dpkg --compare-versions; `~` sorts before everything. */
export function compareDebVersions(a: string, b: string): number {
	const x = splitDebVersion(a);
	const y = splitDebVersion(b);
	if (x.epoch !== y.epoch) return x.epoch - y.epoch;
	return (
		compareFragment(x.upstream, y.upstream) ||
		compareFragment(x.revision, y.revision)
	);
}

/** Stanzas of a Debian `Packages` index (single-line fields only). */
function parsePackages(text: string): Record<string, string>[] {
	return text
		.split(/\n\s*\n/)
		.map((block) => {
			const fields: Record<string, string> = {};
			for (const line of block.split("\n")) {
				const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
				if (m?.[1]) fields[m[1]] = m[2] ?? "";
			}
			return fields;
		})
		.filter((f) => f.Package !== undefined);
}

/** The stanza with the highest Version for `name`. */
function newestPackage(
	stanzas: Record<string, string>[],
	name: string,
	url: string,
): Record<string, string> & { Version: string } {
	let best: (Record<string, string> & { Version: string }) | undefined;
	for (const s of stanzas) {
		if (s.Package !== name || !s.Version) continue;
		if (!best || compareDebVersions(s.Version, best.Version) > 0)
			best = s as Record<string, string> & { Version: string };
	}
	if (!best) throw new Error(`${url}: package ${name} not found`);
	return best;
}

// Sources

function compareNumericDotted(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

async function resolveBase(fetch: Fetch): Promise<Versions["base"]> {
	const index = await get(fetch, UBUNTU_MINIMAL);
	const serials = [
		...index.matchAll(/href="release-(\d{8}(?:\.\d+)?)\/"/g),
	].map((m) => m[1] as string);
	const serial = serials.sort(compareNumericDotted).at(-1);
	if (!serial)
		throw new Error(`${UBUNTU_MINIMAL}: no release-<serial>/ entries`);
	const url = `${UBUNTU_MINIMAL}release-${serial}/SHA256SUMS`;
	return {
		serial,
		sha256: findChecksum(await get(fetch, url), BASE_IMAGE, url),
	};
}

function aptSnapshot(now: Date): string {
	return `${now.toISOString().slice(0, 10).replaceAll("-", "")}T000000Z`;
}

async function resolveNode(fetch: Fetch): Promise<Versions["tools"]["node"]> {
	const url = "https://nodejs.org/dist/index.json";
	const index = await getJson(
		fetch,
		url,
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
	if (!lts) throw new Error(`${url}: no LTS release`);
	assertSemver(lts, url);
	const sums = `https://nodejs.org/dist/v${lts}/SHASUMS256.txt`;
	return {
		version: lts,
		sha256: findChecksum(
			await get(fetch, sums),
			`node-v${lts}-linux-x64.tar.xz`,
			sums,
		),
	};
}

async function resolveGo(fetch: Fetch): Promise<Versions["tools"]["go"]> {
	const url = "https://go.dev/dl/?mode=json";
	const releases = await getJson(
		fetch,
		url,
		z.array(
			z.object({
				version: z.string(),
				stable: z.boolean(),
				files: z.array(
					z.object({
						os: z.string(),
						arch: z.string(),
						kind: z.string(),
						sha256: z.string(),
					}),
				),
			}),
		),
	);
	const release = releases.find((r) => r.stable);
	if (!release) throw new Error(`${url}: no stable release`);
	const file = release.files.find(
		(f) => f.os === "linux" && f.arch === "amd64" && f.kind === "archive",
	);
	if (!file)
		throw new Error(`${url}: ${release.version} has no linux-amd64 archive`);
	return {
		version: assertSemver(release.version.replace(/^go/, ""), url),
		sha256: file.sha256,
	};
}

const releaseSchema = z.object({
	tag_name: z.string(),
	assets: z.array(
		z.object({ name: z.string(), browser_download_url: z.string() }),
	),
});

/** Latest GitHub release; `assetUrl` throws when the release has no such asset. */
async function githubLatest(
	fetch: Fetch,
	repo: string,
	tagPrefix: string,
): Promise<{ version: string; assetUrl(name: string): string }> {
	const url = `https://api.github.com/repos/${repo}/releases/latest`;
	const release = await getJson(fetch, url, releaseSchema);
	if (!release.tag_name.startsWith(tagPrefix))
		throw new Error(`${url}: unexpected tag "${release.tag_name}"`);
	return {
		version: assertSemver(release.tag_name.slice(tagPrefix.length), url),
		assetUrl(name) {
			const asset = release.assets.find((a) => a.name === name);
			if (!asset)
				throw new Error(
					`${url}: release ${release.tag_name} has no asset ${name}`,
				);
			return asset.browser_download_url;
		},
	};
}

async function resolveBun(fetch: Fetch): Promise<Versions["tools"]["bun"]> {
	const rel = await githubLatest(fetch, "oven-sh/bun", "bun-v");
	const url = rel.assetUrl("SHASUMS256.txt");
	return {
		version: rel.version,
		sha256: findChecksum(await get(fetch, url), "bun-linux-x64.zip", url),
	};
}

async function resolveUv(fetch: Fetch): Promise<Versions["tools"]["uv"]> {
	const rel = await githubLatest(fetch, "astral-sh/uv", "");
	const file = "uv-x86_64-unknown-linux-gnu.tar.gz";
	const url = rel.assetUrl(`${file}.sha256`);
	return {
		version: rel.version,
		sha256: findChecksum(await get(fetch, url), file, url),
	};
}

async function resolveGh(fetch: Fetch): Promise<Versions["tools"]["gh"]> {
	const rel = await githubLatest(fetch, "cli/cli", "v");
	const url = rel.assetUrl(`gh_${rel.version}_checksums.txt`);
	return {
		version: rel.version,
		sha256: findChecksum(
			await get(fetch, url),
			`gh_${rel.version}_linux_amd64.tar.gz`,
			url,
		),
	};
}

async function resolveRust(fetch: Fetch): Promise<Versions["tools"]["rust"]> {
	const url = "https://static.rust-lang.org/dist/channel-rust-stable.toml";
	const manifest = z
		.object({ pkg: z.object({ rust: z.object({ version: z.string() }) }) })
		.safeParse(parseToml(await get(fetch, url)));
	if (!manifest.success) throw new Error(`${url}: no [pkg.rust] version`);
	const version = assertSemver(
		manifest.data.pkg.rust.version.split(" ")[0] ?? "",
		url,
	);
	const sums =
		"https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256";
	return {
		version,
		rustup_init_sha256: findChecksum(
			await get(fetch, sums),
			"rustup-init",
			sums,
		),
	};
}

async function resolveDocker(fetch: Fetch): Promise<Versions["docker"]> {
	const stanzas = parsePackages(await get(fetch, DOCKER_PACKAGES));
	const newest = (name: string) =>
		newestPackage(stanzas, name, DOCKER_PACKAGES).Version;
	return {
		docker_ce: newest("docker-ce"),
		containerd_io: newest("containerd.io"),
		compose_plugin: newest("docker-compose-plugin"),
		buildx_plugin: newest("docker-buildx-plugin"),
	};
}

async function resolveChrome(fetch: Fetch): Promise<Versions["chrome"]> {
	const stanzas = parsePackages(await get(fetch, CHROME_PACKAGES));
	const pkg = newestPackage(stanzas, "google-chrome-stable", CHROME_PACKAGES);
	if (!/^[0-9a-f]{64}$/.test(pkg.SHA256 ?? ""))
		throw new Error(`${CHROME_PACKAGES}: google-chrome-stable has no SHA256`);
	return {
		google_chrome_stable: {
			version: pkg.Version,
			sha256: pkg.SHA256 as string,
		},
	};
}

async function resolveNpm(
	fetch: Fetch,
	names: string[],
): Promise<Versions["npm"]> {
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

/** Everything `versions.toml` pins except `sbx`, which has no release source yet. */
export async function resolveLatest(
	fetch: Fetch,
	now: Date,
	npmNames: string[],
): Promise<Versions> {
	const [base, node, go, bun, uv, gh, rust, docker, chrome, npm] =
		await Promise.all([
			resolveBase(fetch),
			resolveNode(fetch),
			resolveGo(fetch),
			resolveBun(fetch),
			resolveUv(fetch),
			resolveGh(fetch),
			resolveRust(fetch),
			resolveDocker(fetch),
			resolveChrome(fetch),
			resolveNpm(fetch, npmNames),
		]);
	return versionsSchema.parse({
		base,
		apt: { snapshot: aptSnapshot(now) },
		docker,
		tools: { node, go, bun, uv, gh, rust },
		chrome,
		npm,
	});
}

// versions.toml output

const HEADER =
	"# Generated by sbx-tpl versions --update; edit by hand only to pin.";

function tomlKey(k: string): string {
	return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function inline(entry: Record<string, string>): string {
	const body = Object.entries(entry)
		.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
		.join(", ");
	return `{ ${body} }`;
}

function table(name: string, rows: [string, string][]): string {
	return [`[${name}]`, ...rows.map(([k, v]) => `${tomlKey(k)} = ${v}`)].join(
		"\n",
	);
}

export function formatVersionsToml(v: Versions): string {
	const str = (s: string) => JSON.stringify(s);
	const sections = [
		table("base", [
			["serial", str(v.base.serial)],
			["sha256", str(v.base.sha256)],
		]),
		table("apt", [["snapshot", str(v.apt.snapshot)]]),
		table("docker", [
			["docker_ce", str(v.docker.docker_ce)],
			["containerd_io", str(v.docker.containerd_io)],
			["compose_plugin", str(v.docker.compose_plugin)],
			["buildx_plugin", str(v.docker.buildx_plugin)],
		]),
		table("tools", [
			["node", inline(v.tools.node)],
			["go", inline(v.tools.go)],
			["bun", inline(v.tools.bun)],
			["uv", inline(v.tools.uv)],
			["gh", inline(v.tools.gh)],
			["rust", inline(v.tools.rust)],
		]),
		table("chrome", [
			["google_chrome_stable", inline(v.chrome.google_chrome_stable)],
		]),
		table(
			"npm",
			Object.entries(v.npm)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, ver]): [string, string] => [k, str(ver)]),
		),
	];
	if (v.sbx) sections.push(table("sbx", [["cli", inline(v.sbx.cli)]]));
	return `${HEADER}\n\n${sections.join("\n\n")}\n`;
}

// Update

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
function diffVersions(prev: Section | null, next: Versions): string[] {
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

export interface UpdateOptions {
	templatesDir: string;
	slug: string;
	fetch?: Fetch;
	now?: Date;
}

/** Re-resolves every pin, rewrites the recipe's `versions.toml` and lists what changed. */
export async function updateVersionsFile(
	opts: UpdateOptions,
): Promise<{ file: string; text: string; changes: string[] }> {
	const recipe = loadRecipe(opts.templatesDir, opts.slug);
	if (recipe.extends !== null)
		throw new Error(
			`recipe "${recipe.slug}" extends "${recipe.extends}": versions --update supports root recipes only`,
		);
	const file = join(recipe.dir, "versions.toml");
	let prev: Section | null = null;
	if (existsSync(file)) {
		try {
			prev = parseToml(readFileSync(file, "utf8"));
		} catch (err) {
			throw new Error(
				`${file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// Packages already pinned by hand stay in the file.
	const pinned =
		typeof prev?.npm === "object" && prev.npm !== null
			? Object.keys(prev.npm)
			: [];
	const npmNames = [
		...DEFAULT_NPM_PACKAGES,
		...pinned.filter((n) => !DEFAULT_NPM_PACKAGES.includes(n)).sort(),
	];
	const resolved = await resolveLatest(
		opts.fetch ?? defaultFetch,
		opts.now ?? new Date(),
		npmNames,
	);

	let sbx: Versions["sbx"];
	try {
		sbx = versionsSchema.shape.sbx.parse(prev?.sbx);
	} catch (err) {
		throw new Error(
			`${file}: [sbx]: ${err instanceof z.ZodError ? z.prettifyError(err) : String(err)}`,
		);
	}
	const next: Versions = sbx ? { ...resolved, sbx } : resolved;

	const text = formatVersionsToml(next);
	writeFileSync(file, text);
	return { file, text, changes: diffVersions(prev, next) };
}
