// Per test file record of the responses that passed the conformance check,
// by operationId. The setup file (`conformance-setup.ts`) writes it to the
// directory of the global setup (`conformance-global.ts`) after each test
// file; the global teardown fails the run when an operation of the document
// was never validated.

export interface OperationCount {
	/** Validated success answers (status < 400; each NDJSON frame counts). */
	ok: number;
	/** Validated error answers (status >= 400). */
	error: number;
}

/** Validated responses of this test file, by operationId. */
export const validatedResponses = new Map<string, OperationCount>();

/** Counts a response that `assertConforms` accepted. */
export function recordValidated(
	operationId: string | null,
	status: number,
): void {
	if (operationId === null) return;
	let c = validatedResponses.get(operationId);
	if (c === undefined) {
		c = { ok: 0, error: 0 };
		validatedResponses.set(operationId, c);
	}
	if (status >= 400) c.error += 1;
	else c.ok += 1;
}

/** One file of the coverage directory. */
export interface CoverageRecord {
	/** Absolute path of the test file. */
	file: string;
	operations: Record<string, OperationCount>;
}

declare module "vitest" {
	export interface ProvidedContext {
		/** Directory of the per-file coverage records; empty when off. */
		umiakConformanceDir: string;
	}
}
