import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Versions, versionsSchema } from "./recipe.ts";
import {
	assertSemver,
	compareNumericDotted,
	diffVersions,
	type Fetch,
	findChecksum,
	get,
	githubLatest,
	latestGo,
	latestNodeLts,
	nodeChecksum,
	npmNames,
	resolveNpm,
	sortedEntries,
	tomlKey,
	UPDATE_HEADER,
} from "./versions-http.ts";

// Linux `versions --update`: latest stable versions and official checksums (spec S5 section 6.3)

export const DEFAULT_NPM_PACKAGES = [
	"@anthropic-ai/claude-code",
	"@openai/codex",
	"opencode-ai",
	"@google/gemini-cli",
	"pnpm",
];

export const UBUNTU_MINIMAL =
	"https://cloud-images.ubuntu.com/minimal/releases/resolute/";
export const BASE_IMAGE = "ubuntu-26.04-minimal-cloudimg-amd64.img";
const DOCKER_PACKAGES =
	"https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages";
const CHROME_PACKAGES =
	"https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages";

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
	const version = await latestNodeLts(fetch);
	return {
		version,
		sha256: await nodeChecksum(
			fetch,
			version,
			`node-v${version}-linux-x64.tar.xz`,
		),
	};
}

async function resolveGo(fetch: Fetch): Promise<Versions["tools"]["go"]> {
	const go = await latestGo(fetch);
	return {
		version: go.version,
		sha256: go.file("linux", "amd64", "archive").sha256,
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
			sortedEntries(v.npm).map(([k, ver]): [string, string] => [k, str(ver)]),
		),
	];
	if (v.desktop) {
		sections.push(
			table("desktop", [
				["sunshine", inline(v.desktop.sunshine)],
				["moonlight_web", inline(v.desktop.moonlight_web)],
				["cua_driver", inline(v.desktop.cua_driver)],
				...(v.desktop.cosign
					? [["cosign", inline(v.desktop.cosign)] as [string, string]]
					: []),
			]),
		);
	}
	if (v.sbx) sections.push(table("sbx", [["cli", inline(v.sbx.cli)]]));
	return `${UPDATE_HEADER}\n\n${sections.join("\n\n")}\n`;
}

// Update

type Section = Record<string, unknown>;

/** Re-resolves every linux pin; `[sbx]` and `[desktop]` are kept from the previous file. */
export async function updateLinuxVersions(
	file: string,
	prev: Section | null,
	fetch: Fetch,
	now: Date,
): Promise<{ text: string; changes: string[] }> {
	// Packages already pinned by hand stay in the file.
	const resolved = await resolveLatest(
		fetch,
		now,
		npmNames(DEFAULT_NPM_PACKAGES, prev?.npm),
	);

	let sbx: Versions["sbx"];
	try {
		sbx = versionsSchema.shape.sbx.parse(prev?.sbx);
	} catch (err) {
		throw new Error(
			`${file}: [sbx]: ${err instanceof z.ZodError ? z.prettifyError(err) : String(err)}`,
		);
	}
	let desktop: Versions["desktop"];
	try {
		desktop = versionsSchema.shape.desktop.parse(prev?.desktop);
	} catch (err) {
		throw new Error(
			`${file}: [desktop]: ${err instanceof z.ZodError ? z.prettifyError(err) : String(err)}`,
		);
	}
	const next: Versions = {
		...resolved,
		...(sbx ? { sbx } : {}),
		...(desktop ? { desktop } : {}),
	};
	return { text: formatVersionsToml(next), changes: diffVersions(prev, next) };
}
