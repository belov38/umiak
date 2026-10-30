import { defineConfig } from "vitest/config";

// The CLI tests spawn `bun src/main.ts` against apps/api in process. Workspace
// packages with a build step (@sbx/agent-client, @sbx/proto) are resolved
// from their TypeScript sources ("source" export condition), as in the api's
// own tests.
const source = "source";

export default defineConfig({
	resolve: {
		conditions: [source, "module", "browser", "development|production"],
	},
	ssr: {
		resolve: {
			conditions: [source, "module", "node", "development|production"],
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["@sbx/db/testing/global-setup"],
		// A hang guard only: tests wait on conditions and spawn the CLI, which
		// takes seconds on a loaded machine under a full parallel `pnpm -r test`.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
