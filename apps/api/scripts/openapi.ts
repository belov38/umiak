// Writes openapi/v1.json from the routes of the public app:
//   pnpm --filter @sbx/api openapi
import { writeFileSync } from "node:fs";
import {
	buildOpenApiDocument,
	createPublicApp,
	serializeOpenApiDocument,
} from "../src/index.ts";
import { makeTestDeps } from "../src/testing/index.ts";

const out = new URL("../openapi/v1.json", import.meta.url);
writeFileSync(
	out,
	serializeOpenApiDocument(
		buildOpenApiDocument(createPublicApp(makeTestDeps())),
	),
);
console.log(`wrote ${out.pathname}`);
