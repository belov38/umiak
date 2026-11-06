import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	raw: new Map<string, Buffer>(),
	seed: new Map<string, string | Buffer>(),
}));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn((...args: unknown[]) => {
			const callback = args.at(-1) as (
				error: null,
				stdout: string,
				stderr: string,
			) => void;
			callback(null, "", "");
			return {};
		}),
	};
});
vi.mock("../src/image.ts", () => ({
	defaultDownloadFetch: vi.fn(),
	fetchBaseImage: vi.fn(async () => ({ path: "/unused-official-base" })),
}));
vi.mock("../src/seed.ts", () => ({
	makeIso: vi.fn(),
	renderSeed: vi.fn(() => new Map(state.seed)),
}));
vi.mock("../src/runner.ts", () => ({
	mountSeed: vi.fn(),
	rebootGuest: vi.fn(),
	runStep: vi.fn(),
}));
vi.mock("../src/seal.ts", () => ({
	sealGuest: vi.fn(),
	collectFacts: vi.fn(async () => ({
		kernel: "fixture",
		systemd: "fixture",
		packages: {},
		tools: { claude: null, bun: null, bunx: null, opencode: null },
	})),
}));
vi.mock("../src/offline-layer.ts", () => ({
	materializeCapturedApt: vi.fn(async () => []),
}));
vi.mock("../src/qemu.ts", () => ({
	CAPTURE_MAC: "52:54:00:25:00:01",
	probeQemu: vi.fn(),
	QemuVM: class {
		guest = {
			exec: async () => ({
				exitCode: 0,
				stdout: "DHCP lease proof",
				stderr: "",
			}),
			ping: async () => true,
			readFile: async (path: string, offset: number, count: number) => {
				let bytes: Buffer;
				if (path.endsWith("/files.json"))
					bytes = Buffer.from(
						JSON.stringify(
							[...state.raw].map(([path, data]) => ({
								path,
								sha256: createHash("sha256").update(data).digest("hex"),
								sizeBytes: data.length,
								mode: 420,
							})),
						),
					);
				else
					bytes =
						state.raw.get(path.replace("/var/lib/umiak-layer-capture/", "")) ??
						Buffer.alloc(0);
				return bytes.subarray(offset, offset + count);
			},
		};
		async ready() {}
		async collectDiagnostics() {}
		async close() {}
	},
}));

import { captureLayer } from "../src/qemu-build.ts";

async function fixture(
	test: (
		root: string,
		directory: string,
		options: Parameters<typeof captureLayer>[0],
	) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "capture-materialize-"));
	try {
		const agent = join(root, "agent");
		await writeFile(agent, "generic agent fixture");
		const directory = join(root, "linux");
		state.seed = new Map([
			["user-data", "#cloud-config\nbootcmd: []\n"],
			["meta-data", "instance-id: fixture\n"],
			["network-config", "version: 2\nethernets: {}\n"],
			["build/descriptor.txt", "host-written descriptor"],
		]);
		state.raw = new Map(
			Object.entries({
				"build/apt-after/ubuntu.sources": "Types: deb\n",
				"licenses/packages.json": "[]",
				"licenses/deb/fixture.copyright": "original distribution notice",
				"inputs/fetch.jsonl": `${JSON.stringify({
					url: "https://example.invalid/tool.tar",
					sha256: "a".repeat(64),
				})}\n`,
				"inputs/by-sha256/fixture": "original tool input",
				"inputs/apt-capture/capture.json":
					"raw apt evidence handled separately",
			}).map(([path, data]) => [path, Buffer.from(data)]),
		);
		await test(root, directory, {
			slug: "linux",
			version: "20261106.1",
			templatesDir: resolve(import.meta.dirname, "../../../infra/templates"),
			outputDir: directory,
			cacheDir: join(root, "cache"),
			agentBinary: agent,
			agentVersion: "0.4.0",
			unitsDirectory: "unused",
			updateKeysFile: resolve(
				import.meta.dirname,
				"../../../services/guest-agent/packaging/trust/update-keys.pub",
			),
			log() {},
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
it("materializes capture entries beside pre-filled build descriptors and preserves licenses/inputs", async () => {
	await fixture(async (_root, directory, options) => {
		const capture = await captureLayer(options);
		expect(
			await readFile(join(directory, "build/descriptor.txt"), "utf8"),
		).toBe("host-written descriptor");
		expect(
			JSON.parse(
				await readFile(join(directory, "build/layer-recipe.json"), "utf8"),
			).slug,
		).toBe("linux");
		expect(
			await readFile(join(directory, "build/apt-after/ubuntu.sources"), "utf8"),
		).toBe("Types: deb\n");
		expect(
			await readFile(join(directory, "licenses/deb/fixture.copyright"), "utf8"),
		).toBe("original distribution notice");
		expect(
			await readFile(join(directory, "inputs/by-sha256/fixture"), "utf8"),
		).toBe("original tool input");
		await expect(
			lstat(join(directory, "inputs/apt-capture")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(capture.files.map((f) => f.path)).toContain("build/descriptor.txt");
		expect(capture.files.map((f) => f.path)).toContain(
			"licenses/packages.json",
		);
	});
});
it("fails on a colliding raw file, cleans only its owned output and preserves surrounding files", async () => {
	await fixture(async (root, directory, options) => {
		state.raw.set(
			"build/descriptor.txt",
			Buffer.from("guest must not overwrite host descriptor"),
		);
		await writeFile(join(root, "unrelated"), "keep");
		await expect(captureLayer(options)).rejects.toThrow(
			/already exists|EEXIST/,
		);
		await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "unrelated"), "utf8")).toBe("keep");
	});
});

it("keeps the build-time proxy URL out of the materialized layer tree", async () => {
	await fixture(async (_root, directory, options) => {
		const proxy = "http://192.0.2.1:3142";
		const capture = await captureLayer({ ...options, aptProxy: proxy });
		for (const file of capture.files)
			expect(
				(await readFile(join(directory, file.path))).includes(
					Buffer.from(proxy),
				),
			).toBe(false);
	});
});
