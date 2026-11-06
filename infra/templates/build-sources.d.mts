export interface BinarySources {
	binarySha256: string;
	binaryName: string;
	binaryVersion: string;
	sourcePackage?: string;
	sourceVersion?: string;
	sourceCommit?: string;
	sources: string[];
}
export function buildSourceCompanion(options: {
	capture: {
		directory: string;
		aptSnapshot: string;
		recipe: { slug: string };
		files: { path: string; sha256: string }[];
	};
	cache: string;
	directory: string;
	version: string;
	sourceCommit: string;
	auditGuest?: import("../../apps/template-builder/src/runner.ts").GuestIo;
}): Promise<{
	reference: { repository: string; digest: string };
	mapping: BinarySources[];
	sourceSubsets: unknown[];
	dockerBinaries: {
		binarySha256: string;
		path: string;
		sourceRequirement: string;
	}[];
	measurements: {
		sourceBytes: number;
		sourceFiles: number;
		sourceChunks: number;
		sourceCaptureMs: number;
	};
}>;
