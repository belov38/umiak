import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { layerRecipeDescriptor } from "../../../infra/templates/layer-recipe.mjs";
import { validateBuildAptProxy } from "./build-apt-proxy.ts";
import { defaultDownloadFetch, fetchBaseImage } from "./image.ts";
import {
	type CapturedFile,
	copyCapturedFiles,
	validateCapturedFiles,
} from "./layer-files.ts";
import { materializeCapturedApt } from "./offline-layer.ts";
import { renderOfflineSeed } from "./offline-seed.ts";
import { CAPTURE_MAC, probeQemu, QemuVM } from "./qemu.ts";
import {
	type LinuxRecipe,
	loadRecipe,
	loadVerifyScript,
	loadVersions,
	REBOOT_STEP,
	recipeDigest,
} from "./recipe.ts";
import { type GuestIo, mountSeed, rebootGuest, runStep } from "./runner.ts";
import { collectFacts, type ImageFacts, sealGuest } from "./seal.ts";
import { makeIso, renderSeed } from "./seed.ts";

const exec = promisify(execFile);

/** QEMU-only boot config: independent of cloud-image interface naming. No install secrets. */
export function qemuBootSeed(
	seed: Map<string, string | Buffer>,
	online: boolean,
	proxyOptions?: { url: string; snapshot: string },
): void {
	const proxy = validateBuildAptProxy(proxyOptions?.url);
	if (proxy && !online)
		throw Error("Build apt proxy is forbidden on offline replay");
	const config = parse(String(seed.get("user-data")));
	config.output = { all: "| tee -a /var/log/cloud-init-output.log /dev/ttyS0" };
	config.bootcmd ??= [];
	config.bootcmd.unshift([
		"bash",
		"-c",
		"echo UMIak-boot-diagnostics; cat /proc/cmdline; ip -br address; ip route; cat /etc/resolv.conf; lsblk -f; true",
	]);
	if (online) {
		const check = readFileSync(
			new URL(
				"../../../infra/templates/linux/capture-network-check.sh",
				import.meta.url,
			),
			"utf8",
		);
		config.bootcmd.push([
			"bash",
			"-euc",
			`mkdir -p /usr/local/lib/umiak-build
cat > /usr/local/lib/umiak-build/capture-network-check <<'UMIAK_NETWORK_CHECK'
${check}
UMIAK_NETWORK_CHECK
chmod 0755 /usr/local/lib/umiak-build/capture-network-check
cat > /etc/apt/apt.conf.d/00umiak-network-check <<'UMIAK_APT_CHECK'
APT::Update::Pre-Invoke { "/usr/local/lib/umiak-build/capture-network-check"; };
DPkg::Pre-Invoke { "/usr/local/lib/umiak-build/capture-network-check"; };
UMIAK_APT_CHECK
`,
		]);
	}
	if (proxy) {
		if (!/^\d{8}T\d{6}Z$/.test(proxyOptions?.snapshot ?? ""))
			throw Error("Invalid apt proxy snapshot");
		config.bootcmd.push([
			"python3",
			"-I",
			"/mnt/seed/build/build-apt-proxy.py",
			"configure",
			proxyOptions?.snapshot,
			proxy,
		]);
	}
	seed.set(
		"user-data",
		`#cloud-config\n${stringify(config, proxy ? { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" } : {})}`,
	);
	if (online)
		seed.set(
			"network-config",
			// cloud-init parses with PyYAML (YAML 1.1): an unquoted MAC such as
			// 52:54:00:25:00:01 is a base-60 integer there, so the match never
			// finds the NIC and the capture VM stays offline. Quote every string.
			stringify(
				{
					version: 2,
					ethernets: {
						capture: {
							match: { macaddress: CAPTURE_MAC },
							"set-name": "capture0",
							dhcp4: true,
						},
					},
				},
				{ defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" },
			),
		);
}
async function saveBootSeed(
	seed: Map<string, string | Buffer>,
	directory: string,
): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of ["user-data", "meta-data", "network-config"]) {
		const value = seed.get(name);
		if (value === undefined) throw Error(`Boot seed omits ${name}`);
		await writeFile(join(directory, name), value);
	}
}

const captureRoot = "/var/lib/umiak-layer-capture";
export function assertOfflineReplayFacts(
	captured: ImageFacts,
	replayed: ImageFacts,
): void {
	const sorted = (v: Record<string, unknown>) =>
		JSON.stringify(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
	if (
		captured.kernel !== replayed.kernel ||
		captured.systemd !== replayed.systemd ||
		sorted(captured.packages) !== sorted(replayed.packages) ||
		sorted(captured.tools) !== sorted(replayed.tools)
	)
		throw Error("Offline replay package/tool/kernel facts differ from capture");
}
export async function describeLayerFiles(
	directory: string,
): Promise<CapturedFile[]> {
	const files: CapturedFile[] = [];
	async function visit(relative: string): Promise<void> {
		for (const entry of await readdir(join(directory, relative), {
			withFileTypes: true,
		})) {
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				const full = join(directory, path),
					info = await stat(full);
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(full)) hash.update(chunk);
				files.push({
					path,
					sizeBytes: info.size,
					sha256: hash.digest("hex"),
					mode: info.mode & 0o111 ? 0o755 : 0o644,
				});
			} else throw Error("Offline layer contains a link or special file");
		}
	}
	await visit("");
	files.sort((a, b) => a.path.localeCompare(b.path));
	validateCapturedFiles(files);
	return files;
}
async function must(
	io: GuestIo,
	cmd: string[],
	input?: string,
): Promise<string> {
	const result = await io.exec(cmd, {
		...(input === undefined ? {} : { input }),
		timeoutMs: 10 * 60_000,
	});
	if (result.exitCode !== 0)
		throw Error(
			`Offline guest operation failed: ${cmd[0]} (${result.exitCode}): ${result.stderr.slice(-2048)}`,
		);
	return result.stdout;
}
export async function runLayerRecipe(
	io: GuestIo,
	recipe: LinuxRecipe,
	o: {
		mode: "capture" | "replay";
		log: (text: string) => void;
		signal?: AbortSignal;
	},
): Promise<void> {
	await mountSeed(io, o.mode === "capture" ? "cidata" : "umiak-layer");
	for (const step of recipe.steps) {
		o.signal?.throwIfAborted();
		if (step === "90-cleanup") {
			await runStep(io, {
				name: "offline-browser",
				script: "/mnt/seed/build/offline-cdp.sh",
				log: o.log,
			});
			if (o.mode === "capture") break;
		}
		if (step === REBOOT_STEP) {
			await rebootGuest(io, {
				seedLabel: o.mode === "capture" ? "cidata" : "umiak-layer",
			});
			continue;
		}
		await runStep(io, {
			name: step,
			script: `/mnt/seed/build/steps/${step}.sh`,
			log: o.log,
		});
	}
}
export interface LayerCaptureOptions {
	slug: "linux" | "linux-desktop";
	version: string;
	templatesDir: string;
	outputDir: string;
	cacheDir: string;
	agentBinary: string;
	agentVersion: string;
	unitsDirectory: string;
	updateKeysFile: string;
	umiakCli?: string;
	diagnosticsDirectory?: string;
	aptProxy?: string;
	afterCapture?: (capture: LayerCapture, guest: GuestIo) => Promise<void>;
	signal?: AbortSignal;
	log: (text: string) => void;
}
export interface LayerCapture {
	directory: string;
	recipe: LinuxRecipe;
	recipeSha256: string;
	base: { serial: string; sha256: string; url: string };
	aptSnapshot: string;
	agent: { version: string; sha256: string };
	facts: ImageFacts;
	files: CapturedFile[];
}
async function overlay(
	base: string,
	path: string,
	sizeGb: number,
	signal?: AbortSignal,
): Promise<void> {
	await exec(
		"qemu-img",
		[
			"create",
			"-q",
			"-f",
			"qcow2",
			"-F",
			"qcow2",
			"-b",
			resolve(base),
			path,
			`${sizeGb}G`,
		],
		{ ...(signal ? { signal } : {}), timeout: 60_000 },
	);
}
async function getCaptureFiles(io: GuestIo): Promise<CapturedFile[]> {
	const data = await io.readFile(`${captureRoot}/files.json`, 0, 1024 ** 2);
	if (data.length === 1024 ** 2)
		throw Error("Guest capture file inventory exceeds limit");
	const files = JSON.parse(data.toString()) as CapturedFile[];
	validateCapturedFiles(files);
	return files;
}
export async function captureLayer(
	o: LayerCaptureOptions,
): Promise<LayerCapture> {
	if (
		!/^\d{8}\.\d+(-edge\.\d{8}\.\d+)?$/.test(o.version) ||
		!["linux", "linux-desktop"].includes(o.slug)
	)
		throw Error("Invalid offline layer release identity");
	const aptProxy = validateBuildAptProxy(o.aptProxy);
	const recipe = loadRecipe(o.templatesDir, o.slug, "linux");
	const versions = loadVersions(recipe);
	const verify = loadVerifyScript(o.templatesDir, recipe.verify, "linux");
	const destination = resolve(o.outputDir);
	try {
		await lstat(destination);
		throw Error("Capture output already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let outputOwned = false;
	await mkdir(dirname(destination), { recursive: true });
	const job = await mkdtemp(join(dirname(destination), ".umiak-capture-"));
	let vm: QemuVM | undefined;
	try {
		await probeQemu(job);
		o.signal?.throwIfAborted();
		const image = await fetchBaseImage({
			fetch: defaultDownloadFetch,
			cacheDir: o.cacheDir,
			base: versions.base,
			keyFile: join(o.templatesDir, "keys/ubuntu-cloud-images.asc"),
		});
		const seed = renderSeed({
			recipe,
			versions,
			buildId: randomUUID(),
			version: o.version,
			agentPackage: "",
			agentVersion: o.agentVersion,
			updateKeys: await readFile(o.updateKeysFile),
			genericAgent: { binary: o.agentBinary, unitsDirectory: o.unitsDirectory },
			layerCapture: true,
			manifestBase: { templateSlug: o.slug, version: o.version },
			...(o.umiakCli ? { umiakCli: o.umiakCli } : {}),
		});
		seed.set("build/verify.sh", verify);
		qemuBootSeed(
			seed,
			true,
			aptProxy ? { url: aptProxy, snapshot: versions.apt.snapshot } : undefined,
		);
		const diagnosticsDirectory =
			o.diagnosticsDirectory ??
			join(dirname(destination), "diagnostics", o.slug, "capture");
		await saveBootSeed(seed, diagnosticsDirectory);
		const disk = join(job, "capture.qcow2"),
			seedPath = join(job, "seed.raw");
		makeIso(seed, seedPath);
		await overlay(image.path, disk, recipe.disk.sizeGb, o.signal);
		vm = new QemuVM({
			disk,
			seed: seedPath,
			qga: join(job, "qga"),
			qmp: join(job, "qmp"),
			network: true,
			diagnosticsDirectory,
		});
		const stop = () => {
			void vm?.close();
		};
		o.signal?.addEventListener("abort", stop, { once: true });
		try {
			await vm.ready(20 * 60_000);
			const networkProof = await must(vm.guest, [
				"bash",
				"-euc",
				`/usr/local/lib/umiak-build/capture-network-check
networkctl status capture0 --no-pager
cat /run/systemd/netif/leases/*
grep -h '^ADDRESS=10.0.2.' /run/systemd/netif/leases/*
`,
			]);
			await writeFile(
				join(diagnosticsDirectory, "dhcp-lease.log"),
				networkProof,
			);
			await runLayerRecipe(vm.guest, recipe, {
				mode: "capture",
				log: o.log,
				...(o.signal ? { signal: o.signal } : {}),
			});
			await runStep(vm.guest, {
				name: "capture-inputs",
				script: "/mnt/seed/build/capture-layer.sh",
				log: o.log,
			});
			const files = await getCaptureFiles(vm.guest);
			const raw = join(job, "raw");
			await copyCapturedFiles(vm.guest, captureRoot, raw, files, o.signal);
			const facts = await collectFacts(vm.guest, verify);
			seed.set(
				"build/layer-recipe.json",
				layerRecipeDescriptor(recipe, versions, facts),
			);
			await mkdir(destination);
			outputOwned = true;
			for (const [path, bytes] of seed) {
				if (!path.startsWith("build/")) continue;
				const full = join(destination, path);
				await mkdir(dirname(full), { recursive: true });
				await writeFile(full, bytes, { flag: "wx" });
			}
			// Merge entry by entry: build/ already holds the host-written seed
			// descriptors, and cp(errorOnExist) rejects an existing directory even
			// when no file collides. A colliding file still fails the build.
			for (const name of ["inputs", "licenses", "build"]) {
				await mkdir(join(destination, name), { recursive: true });
				for (const entry of await readdir(join(raw, name))) {
					if (name === "inputs" && entry === "apt-capture") continue;
					await cp(join(raw, name, entry), join(destination, name, entry), {
						recursive: true,
						errorOnExist: true,
						force: false,
					});
				}
			}
			const fetches = (await readFile(join(raw, "inputs/fetch.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { url: string; sha256: string });
			await materializeCapturedApt({
				rawDirectory: raw,
				layerDirectory: destination,
				directDebs: new Set(
					fetches
						.filter((f) => new URL(f.url).pathname.endsWith(".deb"))
						.map((f) => f.sha256),
				),
			});
			const binaryHash = createHash("sha256")
				.update(await readFile(o.agentBinary))
				.digest("hex");
			const captured: LayerCapture = {
				directory: destination,
				recipe,
				recipeSha256: recipeDigest(recipe),
				base: {
					...versions.base,
					url: `https://cloud-images.ubuntu.com/minimal/releases/resolute/release-${versions.base.serial}/ubuntu-26.04-minimal-cloudimg-amd64.img`,
				},
				aptSnapshot: versions.apt.snapshot,
				agent: { version: o.agentVersion, sha256: binaryHash },
				facts,
				files: await describeLayerFiles(destination),
			};
			await o.afterCapture?.(captured, vm.guest);
			return captured;
		} finally {
			o.signal?.removeEventListener("abort", stop);
		}
	} catch (error) {
		if (outputOwned) await rm(destination, { recursive: true, force: true });
		throw error;
	} finally {
		try {
			await vm?.collectDiagnostics();
		} catch {
			/* Diagnostics never replace the build error. */
		}
		await vm?.close();
		await rm(job, { recursive: true, force: true });
	}
}
async function layerMedia(
	directory: string,
	path: string,
	files: CapturedFile[],
	signal?: AbortSignal,
): Promise<number> {
	const bytes = Math.max(
		64 * 1024 ** 2,
		Math.ceil(
			(files.reduce((n, f) => n + f.sizeBytes, 0) * 1.25 + 32 * 1024 ** 2) /
				1024 ** 2,
		) *
			1024 ** 2,
	);
	const file = await open(path, "wx", 0o600);
	try {
		await file.truncate(bytes);
	} finally {
		await file.close();
	}
	await exec(
		"mke2fs",
		["-q", "-t", "ext4", "-F", "-L", "umiak-layer", "-d", directory, path],
		{
			...(signal ? { signal } : {}),
			timeout: 10 * 60_000,
			maxBuffer: 1024 ** 2,
		},
	);
	return bytes;
}
/** Fresh official base + immutable inputs, with no NIC at the hypervisor boundary. */
export async function replayLayer(o: {
	capture: LayerCapture;
	basePath: string;
	workDirectory: string;
	diagnosticsDirectory?: string;
	log: (text: string) => void;
	signal?: AbortSignal;
}): Promise<{
	ok: true;
	offlineReplay: true;
	durationMs: number;
	layerMediaBytes: number;
	facts: ImageFacts;
}> {
	const job = await mkdtemp(join(resolve(o.workDirectory), ".umiak-replay-"));
	let vm: QemuVM | undefined;
	const started = Date.now();
	try {
		await probeQemu(job);
		const baseHash = createHash("sha256");
		for await (const chunk of createReadStream(o.basePath))
			baseHash.update(chunk);
		if (baseHash.digest("hex") !== o.capture.base.sha256)
			throw Error("Official base hash changed before replay");
		const files = await describeLayerFiles(o.capture.directory);
		if (JSON.stringify(files) !== JSON.stringify(o.capture.files))
			throw Error("Captured layer changed before offline replay");
		const media = join(job, "layer.raw"),
			seed = join(job, "seed.raw"),
			disk = join(job, "replay.qcow2");
		const layerMediaBytes = await layerMedia(
			o.capture.directory,
			media,
			files,
			o.signal,
		);
		const bootSeed = renderOfflineSeed(randomBytes(12).toString("hex"));
		qemuBootSeed(bootSeed, false);
		const diagnosticsDirectory =
			o.diagnosticsDirectory ??
			join(
				resolve(o.workDirectory),
				"diagnostics",
				o.capture.recipe.slug,
				"replay",
			);
		await saveBootSeed(bootSeed, diagnosticsDirectory);
		makeIso(bootSeed, seed);
		await overlay(o.basePath, disk, o.capture.recipe.disk.sizeGb, o.signal);
		vm = new QemuVM({
			disk,
			seed,
			layer: media,
			qga: join(job, "qga"),
			qmp: join(job, "qmp"),
			network: false,
			diagnosticsDirectory,
		});
		const stop = () => {
			void vm?.close();
		};
		o.signal?.addEventListener("abort", stop, { once: true });
		try {
			await vm.ready(10 * 60_000);
			await must(vm.guest, [
				"bash",
				"-euc",
				'test -z "$(ip -o route show default)"; test "$(ls /sys/class/net | wc -l)" -eq 1',
			]);
			await runLayerRecipe(vm.guest, o.capture.recipe, {
				mode: "replay",
				log: o.log,
				...(o.signal ? { signal: o.signal } : {}),
			});
			const verify = await readFile(
				join(o.capture.directory, "build/verify.sh"),
				"utf8",
			);
			const facts = await collectFacts(vm.guest, verify);
			assertOfflineReplayFacts(o.capture.facts, facts);
			await sealGuest(vm.guest, { sparse: true });
			await must(vm.guest, [
				"bash",
				"-euc",
				'test ! -s /etc/machine-id; test ! -e /var/lib/systemd/random-seed; test ! -e /var/lib/umiak-agent/identity.json; test -z "$(find /etc/ssh -name "ssh_host_*" -print -quit)"; test ! -e /usr/local/lib/umiak-agent/current/trust/tunnel-ca.pem; test ! -e /etc/umiak-offline-replay; test ! -e /etc/apt/sources.list.d/umiak-offline.sources; test -e /etc/cloud/cloud-init.disabled',
			]);
			return {
				ok: true,
				offlineReplay: true,
				durationMs: Date.now() - started,
				layerMediaBytes,
				facts,
			};
		} finally {
			o.signal?.removeEventListener("abort", stop);
		}
	} finally {
		try {
			await vm?.collectDiagnostics();
		} catch {
			/* Diagnostics never replace the build error. */
		}
		await vm?.close();
		await rm(job, { recursive: true, force: true });
	}
}
