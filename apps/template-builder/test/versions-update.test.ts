import { createHash } from "node:crypto";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecipe, loadVersions, versionsSchema } from "../src/recipe.ts";
import {
	compareDebVersions,
	type Fetch,
	formatVersionsToml,
	resolveLatest,
	updateVersionsFile,
} from "../src/versions-update.ts";

const upstream = resolve(import.meta.dirname, "fixtures/upstream");
const templates = resolve(import.meta.dirname, "fixtures/templates");

const NPM = [
	"@anthropic-ai/claude-code",
	"@openai/codex",
	"opencode-ai",
	"@google/gemini-cli",
	"pnpm",
];

const FIXTURE_BY_URL: Record<string, string> = {
	"https://cloud-images.ubuntu.com/minimal/releases/resolute/":
		"ubuntu-minimal-index.html",
	"https://cloud-images.ubuntu.com/minimal/releases/resolute/release-20261024/SHA256SUMS":
		"ubuntu-minimal-SHA256SUMS",
	"https://nodejs.org/dist/index.json": "node-index.json",
	"https://nodejs.org/dist/v26.13.0/SHASUMS256.txt": "node-SHASUMS256.txt",
	"https://go.dev/dl/?mode=json": "go-dl.json",
	"https://api.github.com/repos/oven-sh/bun/releases/latest": "bun-latest.json",
	"https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt":
		"bun-SHASUMS256.txt",
	"https://api.github.com/repos/astral-sh/uv/releases/latest": "uv-latest.json",
	"https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz.sha256":
		"uv-sha256.txt",
	"https://api.github.com/repos/cli/cli/releases/latest": "gh-latest.json",
	"https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_checksums.txt":
		"gh-checksums.txt",
	"https://static.rust-lang.org/dist/channel-rust-stable.toml":
		"rust-channel-stable.toml",
	"https://static.rust-lang.org/rustup/release-stable.toml":
		"rustup-release-stable.toml",
	"https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init.sha256":
		"rustup-init.sha256",
	"https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages":
		"docker-Packages",
	"https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages":
		"chrome-Packages",
	"https://registry.npmjs.org/@anthropic-ai/claude-code/latest":
		"npm-anthropic-ai__claude-code.json",
	"https://registry.npmjs.org/@openai/codex/latest": "npm-openai__codex.json",
	"https://registry.npmjs.org/opencode-ai/latest": "npm-opencode-ai.json",
	"https://registry.npmjs.org/@google/gemini-cli/latest":
		"npm-google__gemini-cli.json",
	"https://registry.npmjs.org/pnpm/latest": "npm-pnpm.json",
};

function respond(status: number, body: string) {
	return { status, text: async () => body };
}

/** Serves the recorded upstream excerpts; `bodies` replaces or adds responses by URL. */
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

const NOW = new Date("2026-10-30T13:45:12Z");

describe("resolveLatest", () => {
	it("resolves every source from the recorded excerpts", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, NPM);
		expect(v).toEqual({
			base: {
				serial: "20261024",
				sha256:
					"6c083e6bea1573aab619c1dfa8d17bb7e3a8618fbd6cb57fa39d517b20062aa4",
			},
			apt: { snapshot: "20261030T000000Z" },
			docker: {
				docker_ce: "5:29.9.2-1~ubuntu.26.04~resolute",
				containerd_io: "2.4.2-3~ubuntu.26.04~resolute",
				compose_plugin: "5.6.1-1~ubuntu.26.04~resolute",
				buildx_plugin: "0.38.1-1~ubuntu.26.04~resolute",
			},
			tools: {
				node: {
					version: "26.13.0",
					sha256:
						"d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997",
				},
				go: {
					version: "1.27.3",
					sha256:
						"65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40",
				},
				bun: {
					version: "1.4.4",
					sha256:
						"bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
				},
				uv: {
					version: "0.13.6",
					sha256:
						"f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645",
				},
				gh: {
					version: "2.103.3",
					sha256:
						"4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
				},
				rust: {
					version: "1.99.1",
					rustup_version: "1.29.3",
					rustup_init_sha256:
						"b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55",
				},
			},
			chrome: {
				google_chrome_stable: {
					version: "156.0.8078.79-1",
					sha256:
						"be1a1e161419f5c8272432f6860912550d8e29985e925913fa800493a0d0c955",
				},
			},
			npm: {
				"@anthropic-ai/claude-code": "2.1.314",
				"@openai/codex": "0.166.0",
				"opencode-ai": "1.19.5",
				"@google/gemini-cli": "0.66.0",
				pnpm: "12.16.1",
			},
		});
	});

	it("floors the apt snapshot to the UTC day", async () => {
		const v = await resolveLatest(
			fixtureFetch(),
			new Date("2026-12-31T23:59:59.999Z"),
			NPM,
		);
		expect(v.apt.snapshot).toBe("20261231T000000Z");
	});

	it("picks the newest base serial regardless of listing order", async () => {
		const base = "https://cloud-images.ubuntu.com/minimal/releases/resolute/";
		const sums = readFileSync(
			join(upstream, "ubuntu-minimal-SHA256SUMS"),
			"utf8",
		);
		const v = await resolveLatest(
			fixtureFetch({
				[base]:
					'<a href="release-20261024/">x</a><a href="release-20261017/">x</a><a href="release-20261024.1/">x</a><a href="release-20260908/">x</a>',
				[`${base}release-20261024.1/SHA256SUMS`]: sums,
			}),
			NOW,
			NPM,
		);
		expect(v.base.serial).toBe("20261024.1");
	});

	it("takes the newest LTS node, skipping a newer non-LTS entry", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, NPM);
		// Fixture lists v27.0.0-alpha (lts: false) and v26.12.1 (lts: false) first.
		expect(v.tools.node.version).toBe("26.13.0");
	});

	it("takes the first stable go release", async () => {
		const go = JSON.stringify([
			{ version: "go1.28rc1", stable: false, files: [] },
			{
				version: "go1.27.3",
				stable: true,
				files: [
					{
						filename: "go1.27.3.linux-amd64.tar.gz",
						os: "linux",
						arch: "amd64",
						sha256: "a".repeat(64),
						kind: "archive",
					},
				],
			},
			{ version: "go1.26.9", stable: true, files: [] },
		]);
		const v = await resolveLatest(
			fixtureFetch({ "https://go.dev/dl/?mode=json": go }),
			NOW,
			NPM,
		);
		expect(v.tools.go).toEqual({ version: "1.27.3", sha256: "a".repeat(64) });
	});

	it("compares docker versions the Debian way, not lexically", async () => {
		const stanza = (pkg: string, ver: string) =>
			`Package: ${pkg}\nArchitecture: amd64\nVersion: ${ver}\n`;
		const packages = [
			stanza("docker-ce", "5:29.1.2-1~ubuntu.26.04~resolute"),
			stanza("docker-ce", "5:29.1.10-1~ubuntu.26.04~resolute"),
			stanza("docker-ce", "5:29.1.9-1~ubuntu.26.04~resolute"),
			stanza("docker-ce-cli", "5:30.0.0-1~ubuntu.26.04~resolute"),
			stanza("containerd.io", "2.4.2-3~ubuntu.26.04~resolute"),
			stanza("containerd.io", "2.4.2-10~ubuntu.26.04~resolute"),
			stanza("docker-compose-plugin", "5.6.1-1~ubuntu.26.04~resolute"),
			stanza("docker-buildx-plugin", "0.38.1-1~ubuntu.26.04~resolute"),
		].join("\n");
		const v = await resolveLatest(
			fixtureFetch({
				"https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages":
					packages,
			}),
			NOW,
			NPM,
		);
		expect(v.docker.docker_ce).toBe("5:29.1.10-1~ubuntu.26.04~resolute");
		expect(v.docker.containerd_io).toBe("2.4.2-10~ubuntu.26.04~resolute");
	});

	it("reads google-chrome-stable, not the newer beta entry", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, NPM);
		expect(v.chrome.google_chrome_stable.version).toBe("156.0.8078.79-1");
	});

	it("resolves only the requested npm packages", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, ["pnpm"]);
		expect(v.npm).toEqual({ pnpm: "12.16.1" });
	});

	it("names the URL when a request returns 404", async () => {
		const url = "https://nodejs.org/dist/index.json";
		await expect(
			resolveLatest(fixtureFetch({ [url]: 404 }), NOW, NPM),
		).rejects.toThrow(url);
	});

	it("names the URL when the fetch itself fails", async () => {
		const inner = fixtureFetch();
		const url = "https://go.dev/dl/?mode=json";
		const fetch: Fetch = (u) =>
			u === url ? Promise.reject(new Error("ECONNRESET")) : inner(u);
		await expect(resolveLatest(fetch, NOW, NPM)).rejects.toThrow(
			/go\.dev\/dl.*ECONNRESET/s,
		);
	});

	it("throws naming the file when a checksum entry is missing", async () => {
		const url = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";
		await expect(
			resolveLatest(
				fixtureFetch({
					[url]: `${"b".repeat(64)}  node-v26.13.0-win-x64.zip\n`,
				}),
				NOW,
				NPM,
			),
		).rejects.toThrow(/SHASUMS256.*node-v26\.13\.0-linux-x64\.tar\.xz/s);
	});

	it("throws when the release has no checksum asset", async () => {
		const url = "https://api.github.com/repos/cli/cli/releases/latest";
		await expect(
			resolveLatest(
				fixtureFetch({
					[url]: JSON.stringify({ tag_name: "v2.1.0", assets: [] }),
				}),
				NOW,
				NPM,
			),
		).rejects.toThrow(/releases\/latest.*gh_2\.1\.0_checksums\.txt/s);
	});

	it("throws when a docker package is not published", async () => {
		const url =
			"https://download.docker.com/linux/ubuntu/dists/resolute/stable/binary-amd64/Packages";
		await expect(
			resolveLatest(
				fixtureFetch({
					[url]: "Package: docker-ce\nVersion: 5:29.9.2-1~x\n",
				}),
				NOW,
				NPM,
			),
		).rejects.toThrow(/binary-amd64\/Packages.*containerd\.io/s);
	});
});

describe("compareDebVersions", () => {
	it.each([
		["1.0~rc1", "1.0", -1],
		["1.0", "1.0~rc1", 1],
		["1.0~~", "1.0~", -1],
		["1:0.9", "2.0", 1],
		["5:29.1.2-1~x", "5:29.1.10-1~x", -1],
		["5:29.9.2-1~ubuntu.26.04~resolute", "5:29.9.2-1~ubuntu.26.04~resolute", 0],
		["2.4.2-3~u", "2.4.2-10~u", -1],
		["1.0-1", "1.0", 1],
		["1.0a", "1.0", 1],
		["1.0+b1", "1.0", 1],
		["156.0.8078.79-1", "156.0.8078.9-1", 1],
		["0:1.0", "1.0", 0],
	])("compare(%s, %s) has sign %i", (a, b, sign) => {
		expect(Math.sign(compareDebVersions(a, b))).toBe(sign);
		expect(Math.sign(compareDebVersions(b, a))).toBe(sign === 0 ? 0 : -sign);
	});
});

describe("formatVersionsToml", () => {
	it("round-trips through the versions schema", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, NPM);
		const text = formatVersionsToml(v);
		expect(text.startsWith("# Generated by umiak-tpl versions --update;")).toBe(
			true,
		);
		expect(versionsSchema.parse(parseToml(text))).toEqual(v);
	});

	it("round-trips the optional umiak table and is deterministic", async () => {
		const v = {
			...(await resolveLatest(fixtureFetch(), NOW, NPM)),
			umiak: { cli: { version: "0.1.0", sha256: "c".repeat(64) } },
		};
		const text = formatVersionsToml(v);
		expect(versionsSchema.parse(parseToml(text))).toEqual(v);
		expect(formatVersionsToml(versionsSchema.parse(parseToml(text)))).toBe(
			text,
		);
	});

	it("omits [umiak] when absent", async () => {
		const v = await resolveLatest(fixtureFetch(), NOW, NPM);
		expect(formatVersionsToml(v)).not.toContain("[umiak]");
	});
});

describe("updateVersionsFile", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	function copyTemplates(): string {
		const dir = mkdtempSync(join(tmpdir(), "umiak-tpl-versions-"));
		dirs.push(dir);
		cpSync(templates, dir, { recursive: true });
		return dir;
	}

	const run = (dir: string, bodies: Record<string, string | number> = {}) =>
		updateVersionsFile({
			templatesDir: dir,
			slug: "linux-fixture",
			fetch: fixtureFetch(bodies),
			now: NOW,
		});

	it("rewrites the file, lists changed entries and keeps the umiak table", async () => {
		const dir = copyTemplates();
		const file = join(dir, "linux-fixture", "versions.toml");
		writeFileSync(
			file,
			`${readFileSync(file, "utf8")}\n[umiak]\ncli = { version = "0.1.0", sha256 = "${"c".repeat(64)}" }\n`,
		);

		const res = await run(dir);

		expect(res.changes).toContain(
			"apt.snapshot: 20261029T000000Z -> 20261030T000000Z",
		);
		expect(res.changes).toContain(
			"docker.docker_ce: 5:29.0.0-1~ubuntu.26.04~resolute -> 5:29.9.2-1~ubuntu.26.04~resolute",
		);
		expect(res.changes).toContain("npm.@openai/codex: (none) -> 0.166.0");
		expect(res.changes.some((c) => c.startsWith("base.serial"))).toBe(false);
		expect(res.changes.some((c) => c.startsWith("tools.node.version"))).toBe(
			false,
		);
		expect(res.changes.some((c) => c.startsWith("umiak"))).toBe(false);

		expect(readFileSync(file, "utf8")).toBe(res.text);
		const reloaded = loadVersions(loadRecipe(dir, "linux-fixture", "linux"));
		expect(reloaded.umiak?.cli.version).toBe("0.1.0");
		expect(reloaded.tools.go.sha256).toBe(
			"65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40",
		);
	});

	it("keeps explicitly pinned desktop artifacts when updating base tools", async () => {
		const dir = copyTemplates();
		const file = join(dir, "linux-fixture", "versions.toml");
		const pin = { version: "1.2.3", sha256: "a".repeat(64) };
		const desktop = { sunshine: pin, moonlight_web: pin, cua_driver: pin };
		const linux = () => {
			const recipe = loadRecipe(dir, "linux-fixture");
			if (recipe.os !== "linux") throw new Error("linux-fixture is not linux");
			return loadVersions(recipe);
		};
		writeFileSync(file, formatVersionsToml({ ...linux(), desktop }));
		const res = await run(dir);
		expect(linux().desktop).toEqual(desktop);
		expect(res.changes.some((c) => c.startsWith("desktop."))).toBe(false);
	});

	it("does not rewrite a file with incomplete desktop pins", async () => {
		const dir = copyTemplates();
		const file = join(dir, "linux-fixture", "versions.toml");
		const before = `${readFileSync(file, "utf8")}\n[desktop]\nsunshine = { version = "1.2.3", sha256 = "${"a".repeat(64)}" }\n`;
		writeFileSync(file, before);
		await expect(run(dir)).rejects.toThrow(/desktop/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("reports no changes on a second run", async () => {
		const dir = copyTemplates();
		await run(dir);
		const again = await run(dir);
		expect(again.changes).toEqual([]);
	});

	it("keeps extra npm packages already pinned in the file", async () => {
		const dir = copyTemplates();
		const file = join(dir, "linux-fixture", "versions.toml");
		writeFileSync(file, `${readFileSync(file, "utf8")}"left-pad" = "1.0.0"\n`);
		const res = await run(dir, {
			"https://registry.npmjs.org/left-pad/latest": JSON.stringify({
				name: "left-pad",
				version: "1.3.0",
			}),
		});
		expect(res.changes).toContain("npm.left-pad: 1.0.0 -> 1.3.0");
	});

	it("creates the file when it does not exist yet", async () => {
		const dir = copyTemplates();
		rmSync(join(dir, "linux-fixture", "versions.toml"));
		const res = await run(dir);
		expect(res.changes).toContain("base.serial: (none) -> 20261024");
		expect(
			loadVersions(loadRecipe(dir, "linux-fixture", "linux")).base.serial,
		).toBe("20261024");
	});

	it("does not touch the file when a source fails", async () => {
		const dir = copyTemplates();
		const file = join(dir, "linux-fixture", "versions.toml");
		const before = readFileSync(file, "utf8");
		await expect(
			run(dir, { "https://go.dev/dl/?mode=json": 500 }),
		).rejects.toThrow("go.dev");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
});

it("updates an inherited Debian recipe using Debian image and Docker pins", async () => {
	const dir = mkdtempSync(join(tmpdir(), "umiak-debian-update-"));
	const real = resolve(import.meta.dirname, "../../../infra/templates");
	cpSync(join(real, "linux"), join(dir, "linux"), { recursive: true });
	cpSync(join(real, "debian"), join(dir, "debian"), { recursive: true });
	const serial = "20261103-2651";
	const name = `debian-13-genericcloud-amd64-${serial}.qcow2`;
	const image = "test image";
	const sha512 = createHash("sha512").update(image).digest("hex");
	vi.stubGlobal(
		"fetch",
		async (url: string) =>
			new Response(
				url.endsWith("trixie/")
					? `<a href="${serial}/">`
					: url.endsWith("SHA512SUMS")
						? `${sha512}  ${name}`
						: image,
			),
	);
	try {
		const docker = readFileSync(
			join(upstream, "docker-Packages"),
			"utf8",
		).replaceAll("ubuntu.26.04~resolute", "debian.13~trixie");
		await updateVersionsFile({
			templatesDir: dir,
			slug: "debian",
			now: NOW,
			fetch: fixtureFetch({
				"https://download.docker.com/linux/debian/dists/trixie/stable/binary-amd64/Packages":
					docker,
			}),
		});
		const v = loadVersions(loadRecipe(dir, "debian", "linux"));
		expect(v.base.sha512).toBe(sha512);
		expect(v.base.sha256).toBe(
			createHash("sha256").update(image).digest("hex"),
		);
		expect(v.base.url).toContain(name);
		expect(v.docker.docker_ce).toContain("debian.13~trixie");
	} finally {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});
