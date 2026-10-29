import { defineConfig } from "vitest/config";

// Workspace packages with a build step (@sbx/agent-client, @sbx/proto) are
// resolved from their TypeScript sources ("source" export condition), as in
// agent-client's own tests; no build is needed to run these tests.
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
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
