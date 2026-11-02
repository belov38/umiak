import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecipe, loadVersions } from "../src/recipe.ts";
import { type Fetch, updateVersionsFile } from "../src/versions-update.ts";
import {
	formatWindowsVersionsToml,
	type HashDownload,
	resolveWindowsTools,
	virtioWinWarnings,
	WINDOWS_NPM_PACKAGES,
} from "../src/versions-update-windows.ts";

const upstream = resolve(import.meta.dirname, "fixtures/upstream");
const templates = resolve(import.meta.dirname, "fixtures/templates");

const PWSH_RELEASES =
	"https://api.github.com/repos/PowerShell/PowerShell/releases?per_page=30";
const PYTHON_RELEASES =
	"https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false";
const PYTHON_FILES =
	"https://www.python.org/api/v2/downloads/release_file/?release=1170";
const PVE_WIKI = "https://pve.proxmox.com/wiki/Windows_VirtIO_Drivers";
const VIRTIO_STABLE =
	"https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/";

const FIXTURE_BY_URL: Record<string, string> = {
	[PWSH_RELEASES]: "windows/pwsh-releases.json",
	"https://api.github.com/repos/git-for-windows/git/releases/latest":
		"windows/git-latest.json",
	"https://api.github.com/repos/cli/cli/releases/latest":
		"windows/gh-latest.json",
	"https://api.github.com/repos/astral-sh/uv/releases/latest":
		"windows/uv-latest.json",
	"https://api.github.com/repos/oven-sh/bun/releases/latest":
		"windows/bun-latest.json",
	"https://nodejs.org/dist/index.json": "node-index.json",
	"https://nodejs.org/dist/v26.13.0/SHASUMS256.txt":
		"windows/node-SHASUMS256.txt",
	"https://go.dev/dl/?mode=json": "go-dl.json",
	[PYTHON_RELEASES]: "windows/python-releases.json",
	[PYTHON_FILES]: "windows/python-release-files.json",
	[PVE_WIKI]: "windows/pve-virtio-wiki.html",
	[VIRTIO_STABLE]: "windows/virtio-win-stable.html",
	"https://registry.npmjs.org/@anthropic-ai/claude-code/latest":
		"npm-anthropic-ai__claude-code.json",
	"https://registry.npmjs.org/@openai/codex/latest": "npm-openai__codex.json",
	"https://registry.npmjs.org/opencode-ai/latest": "npm-opencode-ai.json",
	"https://registry.npmjs.org/@google/gemini-cli/latest":
		"npm-google__gemini-cli.json",
};

function respond(status: number, body: string) {
	return { status, text: async () => body };
}

function fixtureFetch(bodies: Record<string, string | number> = {}): Fetch {
	return async (url) => {
		const over = bodies[url];
		if (typeof over === "number") return respond(over, "");
		if (typeof over === "string") return respond(200, over);
		const file = FIXTURE_BY_URL[url];
		if (!file) return respond(404, `no fixture for ${url}`);
		return respond(200, readFileSync(join(upstream, file), "utf8"));
	};
}

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(join(upstream, file), "utf8"));
}

/** Records every URL it is asked to hash; fails the test when nothing should be downloaded. */
function fakeHash(values: Record<string, string> = {}): HashDownload & {
	urls: string[];
} {
	const urls: string[] = [];
	const fn = async (url: string) => {
		urls.push(url);
		const v = values[url];
		if (!v) throw new Error(`unexpected download ${url}`);
		return v;
	};
	return Object.assign(fn, { urls });
}

const EXPECTED_TOOLS = {
	pwsh: {
		version: "7.6.9",
		url: "https://github.com/PowerShell/PowerShell/releases/download/v7.6.9/PowerShell-7.6.9-win-x64.msi",
		sha256: "50d33c7494aaf82b987cfd4de3f232d04f91fdd4c0deeca8a669cced3e7cf8f9",
	},
	git: {
		version: "2.56.0.windows.4",
		url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/Git-2.56.0.4-64-bit.exe",
		sha256: "4961a4a8cc778d8b6e00a5819e5fe4d078b754555aff7aedc2d77a5d74c2de80",
	},
	node: {
		version: "26.13.0",
		url: "https://nodejs.org/dist/v26.13.0/node-v26.13.0-x64.msi",
		sha256: "0e5ee99c7cbf922887f04af268e3665990748945336a44956f47cc0df695b6df",
	},
	python: {
		version: "3.15.2",
		url: "https://www.python.org/ftp/python/3.15.2/python-3.15.2-amd64.exe",
		sha256: "06e225a228191b0f4d1dcf6905fbb21bf9f6970d13a2ec63137ab9bee76f15aa",
	},
	go: {
		version: "1.27.3",
		url: "https://go.dev/dl/go1.27.3.windows-amd64.msi",
		sha256: "89ec8325f667c674fe1b94a5a88e26932aa12323589881927ff54da99d4b7faa",
	},
	bun: {
		version: "1.4.4",
		url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-windows-x64.zip",
		sha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
	},
	uv: {
		version: "0.13.6",
		url: "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip",
		sha256: "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f",
	},
	gh: {
		version: "2.103.3",
		url: "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_windows_amd64.msi",
		sha256: "5073112b7abb5ffbba24b76aee7e89269af531218c0a42751f5f0bfb6440c2cc",
	},
};

describe("resolveWindowsTools", () => {
	it("resolves every tool from the recorded excerpts without downloading", async () => {
		const hash = fakeHash();
		const tools = await resolveWindowsTools(fixtureFetch(), hash);
		expect(tools).toEqual(EXPECTED_TOOLS);
		expect(hash.urls).toEqual([]);
	});

	it("picks the newest LTS PowerShell, skipping prereleases and newer non-LTS releases", async () => {
		const releases = readJson("windows/pwsh-releases.json") as {
			tag_name: string;
			assets: { name: string }[];
		}[];
		// A stable 7.8.0 without the PowerShell-LTS msixbundle is not LTS.
		const nonLts = {
			tag_name: "v7.8.0",
			prerelease: false,
			draft: false,
			assets: [
				{
					name: "PowerShell-7.8.0-win-x64.msi",
					browser_download_url: "https://example.invalid/x.msi",
					digest: `sha256:${"e".repeat(64)}`,
				},
			],
		};
		const tools = await resolveWindowsTools(
			fixtureFetch({ [PWSH_RELEASES]: JSON.stringify([nonLts, ...releases]) }),
			fakeHash(),
		);
		expect(tools.pwsh.version).toBe("7.6.9");
	});

	it("takes the newest Python 3 release by version, not the is_latest flag", async () => {
		const tools = await resolveWindowsTools(fixtureFetch(), fakeHash());
		// The fixture also flags 2.7.18 as is_latest and lists 3.15.1 and 3.14.10.
		expect(tools.python.version).toBe("3.15.2");
	});

	it("downloads and hashes the Python installer when python.org publishes no sha256", async () => {
		const files = (
			readJson("windows/python-release-files.json") as {
				url: string;
				sha256_sum: string;
			}[]
		).map((f) => ({ ...f, sha256_sum: "" }));
		const url = EXPECTED_TOOLS.python.url;
		const hash = fakeHash({ [url]: "f".repeat(64) });
		const tools = await resolveWindowsTools(
			fixtureFetch({ [PYTHON_FILES]: JSON.stringify(files) }),
			hash,
		);
		expect(tools.python.sha256).toBe("f".repeat(64));
		expect(hash.urls).toEqual([url]);
	});

	it("downloads and hashes a GitHub asset without a digest", async () => {
		const gh = readJson("windows/gh-latest.json") as {
			assets: { digest: string | null }[];
		};
		for (const a of gh.assets) a.digest = null;
		const url = EXPECTED_TOOLS.gh.url;
		const hash = fakeHash({ [url]: "d".repeat(64) });
		const tools = await resolveWindowsTools(
			fixtureFetch({
				"https://api.github.com/repos/cli/cli/releases/latest":
					JSON.stringify(gh),
			}),
			hash,
		);
		expect(tools.gh.sha256).toBe("d".repeat(64));
		expect(hash.urls).toEqual([url]);
	});

	it("throws naming the release when the Windows asset is missing", async () => {
		await expect(
			resolveWindowsTools(
				fixtureFetch({
					"https://api.github.com/repos/oven-sh/bun/releases/latest":
						JSON.stringify({ tag_name: "bun-v1.4.4", assets: [] }),
				}),
				fakeHash(),
			),
		).rejects.toThrow(/oven-sh\/bun.*bun-windows-x64\.zip/s);
	});

	it("throws when the node SHASUMS256.txt has no msi entry", async () => {
		await expect(
			resolveWindowsTools(
				fixtureFetch({
					"https://nodejs.org/dist/v26.13.0/SHASUMS256.txt": `${"b".repeat(64)}  node-v26.13.0-linux-x64.tar.xz\n`,
				}),
				fakeHash(),
			),
		).rejects.toThrow(/node-v26\.13\.0-x64\.msi/);
	});

	it("rejects an unexpected Git for Windows tag", async () => {
		await expect(
			resolveWindowsTools(
				fixtureFetch({
					"https://api.github.com/repos/git-for-windows/git/releases/latest":
						JSON.stringify({ tag_name: "v2.56.0", assets: [] }),
				}),
				fakeHash(),
			),
		).rejects.toThrow(/v2\.56\.0/);
	});
});

describe("virtioWinWarnings", () => {
	it("warns that stable is newer than the pinned version", async () => {
		const w = await virtioWinWarnings(fixtureFetch(), "0.1.271");
		expect(w).toEqual([
			"virtio-win: stable 0.1.302 is newer than pinned 0.1.271 (not changed; raise it by hand after a green verify)",
		]);
	});

	it("warns when the Proxmox wiki recommends another version", async () => {
		const w = await virtioWinWarnings(fixtureFetch(), "0.1.266");
		expect(w).toContain(
			"virtio-win: the Proxmox wiki recommends 0.1.271, pinned 0.1.266 (not changed)",
		);
	});

	it("is silent when pinned is the recommended and the stable version", async () => {
		const stable = readFileSync(
			join(upstream, "windows/virtio-win-stable.html"),
			"utf8",
		).replaceAll("0.1.302", "0.1.271");
		const w = await virtioWinWarnings(
			fixtureFetch({ [VIRTIO_STABLE]: stable }),
			"0.1.271",
		);
		expect(w).toEqual([]);
	});

	it("turns failed checks into warnings", async () => {
		const w = await virtioWinWarnings(
			fixtureFetch({ [PVE_WIKI]: 503, [VIRTIO_STABLE]: "<html></html>" }),
			"0.1.271",
		);
		expect(w).toHaveLength(2);
		expect(w[0]).toMatch(/could not check.*Windows_VirtIO_Drivers.*503/);
		expect(w[1]).toMatch(/could not check.*stable-virtio/);
	});
});

describe("updateVersionsFile: windows", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	function copyTemplates(): string {
		const dir = mkdtempSync(join(tmpdir(), "umiak-tpl-winversions-"));
		dirs.push(dir);
		cpSync(templates, dir, { recursive: true });
		return dir;
	}
	const run = (
		dir: string,
		bodies: Record<string, string | number> = {},
		hash = fakeHash(),
	) =>
		updateVersionsFile({
			templatesDir: dir,
			slug: "windows-fixture",
			fetch: fixtureFetch(bodies),
			hashDownload: hash,
		});

	it("updater picks LTS node and writes stable output", async () => {
		const dir = copyTemplates();
		const file = join(dir, "windows-fixture", "versions.toml");
		const before = loadVersions(loadRecipe(dir, "windows-fixture", "windows"));

		const res = await run(dir);

		// node-index.json lists v27.0.0-alpha and v26.12.1 (both lts: false) first.
		expect(res.changes).toContain("tools.pwsh.version: 7.6.8 -> 7.6.9");
		expect(res.changes).toContain("tools.python.version: 3.15.1 -> 3.15.2");
		expect(res.changes).toContain("npm.@openai/codex: (none) -> 0.166.0");
		expect(res.changes.some((c) => c.startsWith("tools.node"))).toBe(false);
		expect(res.changes.some((c) => c.startsWith("iso."))).toBe(false);
		expect(res.changes.some((c) => c.startsWith("virtio_win."))).toBe(false);
		expect(res.changes.some((c) => c.startsWith("openssh."))).toBe(false);
		expect(res.warnings).toEqual([
			"virtio-win: stable 0.1.302 is newer than pinned 0.1.271 (not changed; raise it by hand after a green verify)",
		]);

		const text = readFileSync(file, "utf8");
		expect(text).toBe(res.text);
		const after = loadVersions(loadRecipe(dir, "windows-fixture", "windows"));
		expect(after.tools).toEqual(EXPECTED_TOOLS);
		expect(after.iso).toEqual(before.iso);
		expect(after.virtioWin).toEqual(before.virtioWin);
		expect(after.openssh).toEqual(before.openssh);
		expect(Object.keys(after.npm).sort()).toEqual(
			[...WINDOWS_NPM_PACKAGES].sort(),
		);
		expect(after.npm).not.toHaveProperty("pnpm");

		// Deterministic: formatting the parsed result reproduces the file byte for byte.
		expect(formatWindowsVersionsToml(after)).toBe(text);
		const again = await run(dir);
		expect(again.changes).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(text);
	});

	it("keeps the empty iso sha256 and documents how it is filled", async () => {
		const dir = copyTemplates();
		const res = await run(dir);
		expect(res.text).toContain('sha256 = ""');
		expect(res.text).toMatch(/--accept-iso-sha256/);
		const raw = parseToml(res.text) as { iso: { sha256: string } };
		expect(raw.iso.sha256).toBe("");
	});

	it("writes no product_key when it is null and keeps extra npm pins", async () => {
		const dir = copyTemplates();
		const file = join(dir, "windows-fixture", "versions.toml");
		writeFileSync(
			file,
			readFileSync(file, "utf8")
				.replace('product_key = "generic-pro"\n', "")
				.replace("[npm]\n", '[npm]\n"left-pad" = "1.0.0"\n'),
		);
		const res = await run(dir, {
			"https://registry.npmjs.org/left-pad/latest": JSON.stringify({
				version: "1.3.0",
			}),
		});
		expect(res.text).not.toMatch(/^product_key =/m);
		expect(res.changes).toContain("npm.left-pad: 1.0.0 -> 1.3.0");
		expect(
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")).iso
				.productKey,
		).toBeNull();
	});

	it("refuses to run without the hand-written [iso] and [virtio_win]", async () => {
		const dir = copyTemplates();
		const file = join(dir, "windows-fixture", "versions.toml");
		const before = readFileSync(file, "utf8");
		writeFileSync(file, before.replace(/\[iso\][^[]*/, ""));
		await expect(run(dir)).rejects.toThrow(/\[iso\]/);
		writeFileSync(file, before.replace(/\[virtio_win\][^[]*/, ""));
		await expect(run(dir)).rejects.toThrow(/\[virtio_win\]/);
	});

	it("does not touch the file when a source fails", async () => {
		const dir = copyTemplates();
		const file = join(dir, "windows-fixture", "versions.toml");
		const before = readFileSync(file, "utf8");
		await expect(run(dir, { [PYTHON_RELEASES]: 500 })).rejects.toThrow(
			"python.org",
		);
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});
