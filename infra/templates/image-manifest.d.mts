export interface ImageBlob {
	sha256: string;
	sizeBytes: number;
}
export interface ImageFile extends ImageBlob {
	path: string;
	mode: number;
}
export interface ImageManifest {
	format: "umiak-linux-layer/v1";
	version: string;
	slug: "linux" | "linux-desktop";
	channel: "stable" | "edge";
	arch: "amd64";
	distro: "ubuntu";
	release: "26.04";
	sourceCommit: string;
	recipeSha256: string;
	base: { url: string; serial: string; sha256: string };
	aptSnapshot: string;
	agent: { version: string; sha256: string };
	builderApi: 1;
	minPlatform: string;
	maxPlatform: string;
	minAgent: string;
	bootTrust: "smbios-ca-sha256-v1";
	archive: ImageBlob & {
		compressedBytes: number;
		rawSha256: string;
		chunks: ImageBlob[];
	};
	files: ImageFile[];
	inventory: ImageBlob;
	sources: { repository: string; digest: string };
	verification: {
		ok: true;
		offlineReplay: true;
		aptCacheProxyUsed?: boolean;
		buildHost?: "local-staged";
		approvedSha?: string;
	};
}
export interface ImagePointer {
	format: "umiak-linux-channel/v1";
	channel: "stable" | "edge";
	sequence: number;
	version: string;
	images: Record<"linux" | "linux-desktop", string>;
}
export const IMAGE_LIMITS: Readonly<
	Record<
		| "metadata"
		| "chunk"
		| "archive"
		| "file"
		| "files"
		| "chunks"
		| "inventory",
		number
	>
>;
export function verifyImageManifest(options: {
	bytes: Buffer;
	signature: Buffer;
	keys: string[];
	platform: string;
	agent: string;
	channel: string;
	slug: string;
}): ImageManifest;
export function verifyImagePointer(options: {
	bytes: Buffer;
	signature: Buffer;
	keys: string[];
	channel: string;
	minimumSequence?: number;
}): ImagePointer;

export function validateImageManifest(
	manifest: unknown,
	options: Pick<
		Parameters<typeof verifyImageManifest>[0],
		"slug" | "channel" | "platform" | "agent"
	>,
): ImageManifest;
