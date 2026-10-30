// Generates src/gen/v1.d.ts from the committed OpenAPI document of apps/api.
//   pnpm --filter @sbx/sdk gen
//
// Open enums (S7 §5.9): every schema marked `x-extensible-enum: true` becomes
// `"a" | "b" | (string & {})` instead of a closed union. Known values still
// autocomplete, an unknown value from a newer server still type-checks, and the
// SDK never validates enum values at runtime. Nullable enums keep `null`.
//
// openapi-typescript builds the file with the TypeScript compiler API. The
// workspace TypeScript 7 has no JS API, so .pnpmfile.cjs gives
// openapi-typescript its own TypeScript 5, and the factory below is taken from
// that copy.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import openapiTS, {
	astToString,
	COMMENT_HEADER,
	type OpenAPI3,
	type SchemaObject,
	STRING,
	tsIntersection,
	tsLiteral,
	tsUnion,
} from "openapi-typescript";

const specUrl = new URL("../../../apps/api/openapi/v1.json", import.meta.url);
export const outputUrl = new URL("../src/gen/v1.d.ts", import.meta.url);

const ts = createRequire(import.meta.resolve("openapi-typescript"))(
	"typescript",
) as {
	factory: { createTypeLiteralNode(members: []): unknown };
};

type TypeNode = ReturnType<typeof tsLiteral>;

function openEnum(schema: SchemaObject): TypeNode | undefined {
	const marked = (schema as Record<string, unknown>)["x-extensible-enum"];
	if (marked !== true || !Array.isArray(schema.enum)) return undefined;
	const anyString = tsIntersection([
		STRING,
		ts.factory.createTypeLiteralNode([]) as TypeNode,
	]);
	return tsUnion([...schema.enum.map((v) => tsLiteral(v)), anyString]);
}

/** Returns the content of src/gen/v1.d.ts for the current OpenAPI document. */
export async function generateTypes(): Promise<string> {
	const spec = JSON.parse(await readFile(specUrl, "utf8")) as OpenAPI3;
	const ast = await openapiTS(spec, { transform: openEnum, silent: true });
	return COMMENT_HEADER + astToString(ast);
}

if (import.meta.main) {
	await writeFile(outputUrl, await generateTypes());
	console.log(`wrote ${fileURLToPath(outputUrl)}`);
}
