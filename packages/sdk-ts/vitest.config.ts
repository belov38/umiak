import { defineConfig } from "vitest/config";

// The facade tests run apps/api in process. Workspace packages with a build
// step (@umiak/agent-client, @umiak/proto) are resolved from their TypeScript
// sources ("source" export condition), as in the api's own tests.
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
		globalSetup: ["@umiak/db/testing/global-setup"],
		// A hang guard only: tests wait on conditions; under a full parallel
		// `pnpm -r test` on a loaded machine one can take longer than 30 s.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
