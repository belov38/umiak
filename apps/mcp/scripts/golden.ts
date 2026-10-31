// Golden tool list (S11 14.1): the published tools/list of the server with
// every toolset, listed as a person, not pinned. A change to a name, a
// description, a schema or an annotation shows up as a diff of this file in
// the same PR.
//
//   mise exec -- node apps/mcp/scripts/golden.ts      rewrites the file
//   UPDATE_GOLDEN=1 mise exec -- pnpm --filter @sbx/mcp test golden
//                                                      the same, from the test
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publishedJsonSchemaOf, type ToolDef } from "../src/registry.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";

export const GOLDEN_PATH = fileURLToPath(
	new URL("../golden/tools-list.json", import.meta.url),
);

export interface GoldenTool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolDef["annotations"];
}

export interface Golden {
	tools: GoldenTool[];
}

/** What tools/list publishes for `tools`, with the fields clients read. */
export function buildGolden(tools: readonly ToolDef[] = ALL_TOOLS): Golden {
	return {
		tools: tools.map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: publishedJsonSchemaOf(t, false),
			annotations: { ...t.annotations },
		})),
	};
}

/** 2-space JSON with a trailing newline (the file is outside Biome's reach). */
export function formatGolden(g: Golden): string {
	return `${JSON.stringify(g, null, 2)}\n`;
}

export function writeGolden(): void {
	writeFileSync(GOLDEN_PATH, formatGolden(buildGolden()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeGolden();
	console.log(`wrote ${GOLDEN_PATH}`);
}
