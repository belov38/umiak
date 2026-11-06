import type { GuestIo } from "../../apps/template-builder/src/runner.ts";

interface SourceFile {
	url: string;
	sha256: string;
	sizeBytes: number;
	chunks: { sha256: string; sizeBytes: number }[];
}
export function deriveLinuxSourceSubset(options: {
	source: SourceFile;
	cache: string;
	guest?: GuestIo;
	commit: string;
}): Promise<
	SourceFile & {
		originalArchive: {
			url: string;
			sha256: string;
			sizeBytes: number;
			commit: string;
		};
		derivation: Record<string, unknown>;
	}
>;
