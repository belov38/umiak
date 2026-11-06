import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import type { OfflineLayerRequest } from "@umiak/pve";
import {
	type ImageManifest,
	verifyImageManifest,
} from "../../../infra/templates/image-manifest.mjs";
import {
	type LayerRecipeDescriptor,
	parseLayerRecipe,
} from "../../../infra/templates/layer-recipe.mjs";
import { type LinuxRecipe, type Versions, versionsSchema } from "./recipe.ts";

const verifiedLayers = new WeakSet<object>();
export interface VerifiedOfflineLayer {
	manifest: ImageManifest;
	bytes: Buffer;
	signature: Buffer;
	descriptor: LayerRecipeDescriptor;
	descriptorBytes: Buffer;
	verifyScript: string;
	versions: Versions;
	manifestSha256: string;
}
export function assertVerifiedLayer(layer: VerifiedOfflineLayer): void {
	if (!verifiedLayers.has(layer))
		throw Error("Offline layer must be authenticated before building");
}
export function verifyOfflineLayer(o: {
	bytes: Buffer;
	signature: Buffer;
	descriptor: Buffer;
	verifyScript: Buffer;
	keys: string[];
	platform: string;
	agent: string;
	channel: string;
	slug: string;
}): VerifiedOfflineLayer {
	const m = verifyImageManifest(o);
	const bound = (path: string, bytes: Buffer) => {
		const file = m.files.find((f) => f.path === path);
		if (
			!file ||
			bytes.length !== file.sizeBytes ||
			createHash("sha256").update(bytes).digest("hex") !== file.sha256
		)
			throw Error(`Offline layer ${path} does not match signed metadata`);
	};
	bound("build/layer-recipe.json", o.descriptor);
	bound("build/verify.sh", o.verifyScript);
	const descriptor = parseLayerRecipe(o.descriptor, m.slug);
	const versions = versionsSchema.parse(descriptor.versions);
	if (
		versions.base.serial !== m.base.serial ||
		versions.base.sha256 !== m.base.sha256 ||
		versions.apt.snapshot !== m.aptSnapshot
	)
		throw Error("Offline layer recipe/base identity mismatch");
	for (const step of descriptor.steps) {
		if (
			step !== "reboot" &&
			!m.files.some((f) => f.path === `build/steps/${step}.sh`)
		)
			throw Error("Offline layer omits a recipe step");
	}
	if (
		!m.files.some(
			(f) =>
				f.path === "build/generic-agent/umiak-agent" &&
				f.sha256 === m.agent.sha256,
		) ||
		m.files.some((f) => f.sha256 === m.base.sha256)
	)
		throw Error("Offline layer agent/base input boundary mismatch");
	if (descriptor.facts.tools.claude !== null)
		throw Error("Offline layer must not bundle Claude Code");
	if (
		(descriptor.facts.tools.bun ?? null) !== null ||
		(descriptor.facts.tools.bunx ?? null) !== null ||
		m.files.some((f) => f.sha256 === versions.tools.bun.sha256)
	)
		throw Error("Offline layer must not bundle Bun");
	if ((descriptor.facts.tools.opencode ?? null) !== null)
		throw Error("Offline layer must not bundle OpenCode");
	const layer: VerifiedOfflineLayer = {
		manifest: m,
		bytes: Buffer.from(o.bytes),
		signature: Buffer.from(o.signature),
		descriptor,
		descriptorBytes: Buffer.from(o.descriptor),
		verifyScript: o.verifyScript.toString("utf8"),
		versions,
		manifestSha256: createHash("sha256").update(o.bytes).digest("hex"),
	};
	verifiedLayers.add(layer);
	return Object.freeze(layer);
}
export function offlineRecipe(
	layer: VerifiedOfflineLayer,
	vmid: number,
): LinuxRecipe {
	assertVerifiedLayer(layer);
	const r = layer.descriptor;
	return {
		slug: r.slug,
		os: "linux",
		source: r.source,
		extends: null,
		disk: r.disk,
		hw: r.hw,
		buildVm: r.buildVm,
		steps: r.steps,
		bootTimeoutS: r.bootTimeoutS,
		verify: r.verify,
		cloudinit: false,
		firmwareDisks: {},
		offline: [],
		options: { vsBuildtools: false },
		installTimeoutS: 2400,
		stepTimeoutsMin: {},
		seal: "umiak-agent",
		vmids: [vmid],
		dir: "",
		stepDirs: [],
	};
}
function readBoundedFile(path: string, max: number): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > max)
			throw Error("Offline layer control file exceeds limit");
		const bytes = readFileSync(fd);
		if (bytes.length > max)
			throw Error("Offline layer control file exceeds limit");
		return bytes;
	} finally {
		closeSync(fd);
	}
}
export function loadOfflineLayer(
	file: string,
	o: {
		keysFile?: string;
		keys?: string[];
		platform: string;
		agent: string;
		channel: string;
		slug: string;
	},
): VerifiedOfflineLayer {
	let envelope: {
		manifest: string;
		signature: string;
		descriptor: string;
		verifyScript: string;
	};
	try {
		envelope = JSON.parse(readBoundedFile(file, 6 * 1024 ** 2).toString());
	} catch {
		throw Error("Invalid offline layer control file");
	}
	const decode = (name: keyof typeof envelope) => {
		const value = envelope[name];
		if (typeof value !== "string" || value.length > 2 * 1024 ** 2)
			throw Error("Invalid offline layer control field");
		const bytes = Buffer.from(value, "base64");
		if (bytes.toString("base64") !== value)
			throw Error("Invalid offline layer base64 field");
		return bytes;
	};
	const key = o.keysFile
		? readBoundedFile(o.keysFile, 1024 ** 2).toString()
		: readFileSync(
				new URL(
					"../../../infra/templates/keys/recipe-publisher.pub",
					import.meta.url,
				),
				"utf8",
			);
	const keys =
		o.keys ?? (key.trimStart().startsWith("[") ? JSON.parse(key) : [key]);
	if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string"))
		throw Error("Invalid configured publisher keys");
	return verifyOfflineLayer({
		...o,
		bytes: decode("manifest"),
		signature: decode("signature"),
		descriptor: decode("descriptor"),
		verifyScript: decode("verifyScript"),
		keys,
	});
}

export function layerNodeRequest(
	layer: VerifiedOfflineLayer,
	o: { jobId: string; vmid: number; mediaStorage: string },
): OfflineLayerRequest {
	assertVerifiedLayer(layer);
	return {
		...o,
		manifest: JSON.parse(layer.bytes.toString()),
		signature: layer.signature.toString("base64"),
		platform: process.env.UMIAK_PLATFORM_VERSION || "0.1.0",
		agent: process.env.UMIAK_AGENT_VERSION || "0.1.0",
		channel: layer.manifest.channel,
		slug: layer.manifest.slug,
	};
}
