import { z } from "zod";
import {
	WINDOWS_TOOLS,
	type WindowsTool,
	type WindowsVersions,
	type WindowsVersionsToml,
	windowsVersionsFromToml,
	windowsVersionsSchema,
	windowsVersionsToToml,
} from "./recipe.ts";
import {
	compareNumericDotted,
	diffVersions,
	type Fetch,
	type GithubAsset,
	get,
	getJson,
	githubLatest,
	type HashDownload,
	latestGo,
	latestNodeLts,
	nodeChecksum,
	npmNames,
	releaseAsset,
	releaseSchema,
	resolveNpm,
	sortedEntries,
	tomlKey,
	UPDATE_HEADER,
} from "./versions-http.ts";

export type { HashDownload } from "./versions-http.ts";

// Windows `versions --update` (spec S9 section 5.1): tools and npm packages are
// re-resolved; [iso], [virtio_win] and [openssh] are kept as written by hand.

/** Same packages as linux [npm] (S5 section 6.3) without pnpm. */
export const WINDOWS_NPM_PACKAGES = [
	"@anthropic-ai/claude-code",
	"@google/gemini-cli",
	"@openai/codex",
	"opencode-ai",
];

export const PWSH_RELEASES =
	"https://api.github.com/repos/PowerShell/PowerShell/releases?per_page=30";
export const PYTHON_RELEASES =
	"https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false";
export const PROXMOX_VIRTIO_WIKI =
	"https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers";
/** Redirects to the directory of the current stable release. */
export const VIRTIO_WIN_STABLE =
	"https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/";

type Tool = WindowsVersions["tools"][WindowsTool];

/** sha256 from the asset digest; assets uploaded before GitHub computed digests are downloaded and hashed. */
async function assetPin(
	asset: GithubAsset,
	version: string,
	hash: HashDownload,
): Promise<Tool> {
	const url = asset.browser_download_url;
	const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
	return {
		version,
		url,
		sha256: m?.[1] ? m[1].toLowerCase() : await hash(url),
	};
}

/** Newest stable PowerShell release that ships the LTS package (`PowerShell-LTS-<v>.msixbundle`). */
async function resolvePwsh(fetch: Fetch, hash: HashDownload): Promise<Tool> {
	const releases = await getJson(fetch, PWSH_RELEASES, z.array(releaseSchema));
	const lts = releases
		.filter(
			(r) => !r.prerelease && !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name),
		)
		.map((r) => ({ release: r, version: r.tag_name.slice(1) }))
		.filter(({ release, version }) =>
			release.assets.some(
				(a) => a.name === `PowerShell-LTS-${version}.msixbundle`,
			),
		)
		.sort((a, b) => compareNumericDotted(a.version, b.version))
		.at(-1);
	if (!lts) throw new Error(`${PWSH_RELEASES}: no stable LTS release`);
	const asset = releaseAsset(
		lts.release,
		`PowerShell-${lts.version}-win-x64.msi`,
		PWSH_RELEASES,
	);
	return assetPin(asset, lts.version, hash);
}

/** Git for Windows: tag `v2.56.0.windows.4`, installer `Git-2.56.0.4-64-bit.exe` (`.1` is omitted). */
async function resolveGit(fetch: Fetch, hash: HashDownload): Promise<Tool> {
	const url =
		"https://api.github.com/repos/git-for-windows/git/releases/latest";
	const release = await getJson(fetch, url, releaseSchema);
	const m = /^v(\d+\.\d+\.\d+)\.windows\.(\d+)$/.exec(release.tag_name);
	if (!m?.[1] || !m[2])
		throw new Error(`${url}: unexpected tag "${release.tag_name}"`);
	const file = `Git-${m[1]}${m[2] === "1" ? "" : `.${m[2]}`}-64-bit.exe`;
	return assetPin(
		releaseAsset(release, file, url),
		release.tag_name.slice(1),
		hash,
	);
}

async function resolveGithubAsset(
	fetch: Fetch,
	hash: HashDownload,
	repo: string,
	tagPrefix: string,
	file: (version: string) => string,
): Promise<Tool> {
	const rel = await githubLatest(fetch, repo, tagPrefix);
	return assetPin(
		releaseAsset(rel.release, file(rel.version), rel.url),
		rel.version,
		hash,
	);
}

async function resolveNodeMsi(fetch: Fetch): Promise<Tool> {
	const version = await latestNodeLts(fetch);
	const file = `node-v${version}-x64.msi`;
	return {
		version,
		url: `https://nodejs.org/dist/v${version}/${file}`,
		sha256: await nodeChecksum(fetch, version, file),
	};
}

async function resolveGoMsi(fetch: Fetch): Promise<Tool> {
	const go = await latestGo(fetch);
	const file = go.file("windows", "amd64", "installer");
	return {
		version: go.version,
		url: `https://go.dev/dl/${file.filename ?? `go${go.version}.windows-amd64.msi`}`,
		sha256: file.sha256,
	};
}

/** Newest Python 3 release on python.org by version and its amd64 installer. */
async function resolvePython(fetch: Fetch, hash: HashDownload): Promise<Tool> {
	const releases = await getJson(
		fetch,
		PYTHON_RELEASES,
		z.array(
			z.object({
				name: z.string(),
				pre_release: z.boolean(),
				resource_uri: z.string(),
			}),
		),
	);
	const newest = releases
		.filter((r) => !r.pre_release)
		.flatMap((r) => {
			const v = /^Python (3\.\d+\.\d+)$/.exec(r.name)?.[1];
			const id = /\/release\/(\d+)\/$/.exec(r.resource_uri)?.[1];
			return v && id ? [{ version: v, id }] : [];
		})
		.sort((a, b) => compareNumericDotted(a.version, b.version))
		.at(-1);
	if (!newest) throw new Error(`${PYTHON_RELEASES}: no Python 3 release`);
	const filesUrl = `https://www.python.org/api/v2/downloads/release_file/?release=${newest.id}`;
	const files = await getJson(
		fetch,
		filesUrl,
		z.array(z.object({ url: z.string(), sha256_sum: z.string().nullish() })),
	);
	const name = `python-${newest.version}-amd64.exe`;
	const file = files.find((f) => f.url.endsWith(`/${name}`));
	if (!file) throw new Error(`${filesUrl}: no ${name}`);
	if (!file.url.startsWith("https://www.python.org/"))
		throw new Error(`${filesUrl}: unexpected download URL ${file.url}`);
	const published = file.sha256_sum?.toLowerCase() ?? "";
	return {
		version: newest.version,
		url: file.url,
		sha256: /^[0-9a-f]{64}$/.test(published) ? published : await hash(file.url),
	};
}

/** Latest stable of every Windows tool from the official sources. */
export async function resolveWindowsTools(
	fetch: Fetch,
	hash: HashDownload,
): Promise<WindowsVersions["tools"]> {
	const [pwsh, git, node, python, go, bun, uv, gh] = await Promise.all([
		resolvePwsh(fetch, hash),
		resolveGit(fetch, hash),
		resolveNodeMsi(fetch),
		resolvePython(fetch, hash),
		resolveGoMsi(fetch),
		resolveGithubAsset(
			fetch,
			hash,
			"oven-sh/bun",
			"bun-v",
			() => "bun-windows-x64.zip",
		),
		resolveGithubAsset(
			fetch,
			hash,
			"astral-sh/uv",
			"",
			() => "uv-x86_64-pc-windows-msvc.zip",
		),
		resolveGithubAsset(
			fetch,
			hash,
			"cli/cli",
			"v",
			(v) => `gh_${v}_windows_amd64.msi`,
		),
	]);
	return { pwsh, git, node, python, go, bun, uv, gh };
}

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ");
}

async function check(
	url: string,
	run: () => Promise<string | null>,
): Promise<string[]> {
	try {
		const w = await run();
		return w ? [w] : [];
	} catch (err) {
		return [
			`virtio-win: could not check ${url}: ${err instanceof Error ? err.message : String(err)}`,
		];
	}
}

/**
 * Warnings only: virtio-win is never bumped automatically (spec S9 section
 * 5.1). Compares the pin with the version the Proxmox wiki recommends and
 * with the current fedorapeople `stable`.
 */
export async function virtioWinWarnings(
	fetch: Fetch,
	pinned: string,
): Promise<string[]> {
	const wiki = await check(PROXMOX_VIRTIO_WIKI, async () => {
		const text = stripHtml(await get(fetch, PROXMOX_VIRTIO_WIKI));
		const v = /no known issues for version virtio-win (\d+\.\d+\.\d+)/.exec(
			text,
		)?.[1];
		if (!v) throw new Error("no recommended version found");
		return v === pinned
			? null
			: `virtio-win: the Proxmox wiki recommends ${v}, pinned ${pinned} (not changed)`;
	});
	const stable = await check(VIRTIO_WIN_STABLE, async () => {
		const listing = await get(fetch, VIRTIO_WIN_STABLE);
		const v = /href="virtio-win-(\d+\.\d+\.\d+)\.iso"/.exec(listing)?.[1];
		if (!v) throw new Error("no virtio-win-<version>.iso in the listing");
		return compareNumericDotted(v, pinned) > 0
			? `virtio-win: stable ${v} is newer than pinned ${pinned} (not changed; raise it by hand after a green verify)`
			: null;
	});
	return [...wiki, ...stable];
}

// versions.toml output

const str = (s: string) => JSON.stringify(s);

/** Deterministic file text; the comments are part of the output so --update keeps them. */
export function formatWindowsVersionsToml(v: WindowsVersions): string {
	const t: WindowsVersionsToml = windowsVersionsToToml(v);
	const lines = [
		UPDATE_HEADER,
		"# [iso], [virtio_win] and [openssh] are written by hand; --update keeps them.",
		"",
		"# User's ISO in local:iso (spec S9 section 6.1). An empty sha256 means not",
		"# known yet: `umiak-tpl build --accept-iso-sha256` computes it and writes it here.",
		"# product_key names a public generic key in _windows/keys.toml; omit it for",
		"# evaluation media.",
		"[iso]",
		`file = ${str(t.iso.file)}`,
		`sha256 = ${str(t.iso.sha256)}`,
		`edition = ${str(t.iso.edition)}`,
		...(t.iso.product_key !== undefined
			? [`product_key = ${str(t.iso.product_key)}`]
			: []),
		`channel = ${str(t.iso.channel)}`,
		`ui_language = ${str(t.iso.ui_language)}`,
		"",
		"# Pinned to the version Proxmox recommends, not `stable`; --update only warns.",
		"[virtio_win]",
		`version = ${str(t.virtio_win.version)}`,
		`sha256 = ${str(t.virtio_win.sha256)}`,
	];
	for (const name of WINDOWS_TOOLS) {
		const tool = t.tools[name];
		lines.push(
			"",
			`[tools.${name}]`,
			`version = ${str(tool.version)}`,
			`url = ${str(tool.url)}`,
			`sha256 = ${str(tool.sha256)}`,
		);
	}
	lines.push("", "[npm]");
	for (const [k, ver] of sortedEntries(t.npm))
		lines.push(`${tomlKey(k)} = ${str(ver)}`);
	lines.push("", "[openssh]", `source = ${str(t.openssh.source)}`);
	return `${lines.join("\n")}\n`;
}

// Update

type Section = Record<string, unknown>;

const keptSections = {
	iso: windowsVersionsSchema.shape.iso,
	virtio_win: windowsVersionsSchema.shape.virtio_win,
	openssh: windowsVersionsSchema.shape.openssh,
} as const;

/** Re-resolves tools and npm packages; the hand-written sections must already be in `prev`. */
export async function updateWindowsVersions(
	file: string,
	prev: Section | null,
	fetch: Fetch,
	hash: HashDownload,
): Promise<{ text: string; changes: string[]; warnings: string[] }> {
	const kept: Partial<Pick<WindowsVersionsToml, keyof typeof keptSections>> =
		{};
	for (const [name, schema] of Object.entries(keptSections)) {
		if (prev?.[name] === undefined)
			throw new Error(
				`${file}: [${name}] is written by hand (spec S9 section 5.1); add it before --update`,
			);
		const parsed = schema.safeParse(prev[name]);
		if (!parsed.success)
			throw new Error(`${file}: [${name}]: ${z.prettifyError(parsed.error)}`);
		Object.assign(kept, { [name]: parsed.data });
	}
	const { iso, virtio_win, openssh } = kept as Pick<
		WindowsVersionsToml,
		keyof typeof keptSections
	>;

	const [tools, npm, warnings] = await Promise.all([
		resolveWindowsTools(fetch, hash),
		resolveNpm(fetch, npmNames(WINDOWS_NPM_PACKAGES, prev?.npm)),
		virtioWinWarnings(fetch, virtio_win.version),
	]);
	const next = windowsVersionsFromToml(
		windowsVersionsSchema.parse({ iso, virtio_win, tools, npm, openssh }),
	);
	return {
		text: formatWindowsVersionsToml(next),
		changes: diffVersions(prev, windowsVersionsToToml(next)),
		warnings,
	};
}
