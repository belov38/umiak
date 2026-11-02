// Setup file of every test file: after the file, its validated responses go
// to the coverage directory of the global setup (one JSON file per test
// file, even when nothing was validated, so the teardown can tell a full run).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
import {
	type CoverageRecord,
	validatedResponses,
} from "./conformance-coverage.ts";

// vitest requires a destructuring pattern for the hook's context.
// biome-ignore lint/correctness/noEmptyPattern: the context is not used
afterAll(({}, suite) => {
	const dir = inject("umiakConformanceDir");
	const file = suite.file?.filepath;
	if (!dir || file === undefined) return;
	const record: CoverageRecord = {
		file,
		operations: Object.fromEntries(validatedResponses),
	};
	const name = createHash("sha256").update(file).digest("hex").slice(0, 32);
	writeFileSync(join(dir, `${name}.json`), JSON.stringify(record));
});
