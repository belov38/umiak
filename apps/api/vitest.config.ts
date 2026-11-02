import { defineConfig } from "vitest/config";

// Workspace packages with a build step (@umiak/agent-client, @umiak/proto) are
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
		globalSetup: [
			"@umiak/db/testing/global-setup",
			"./test/helpers/conformance-global.ts",
			"./test/helpers/agent-harness-global.ts",
		],
		setupFiles: ["./test/helpers/conformance-setup.ts"],
		// A hang guard only: tests wait on conditions (budgets of 30 s each),
		// and under a full parallel `pnpm -r test` on a loaded machine a test
		// with several waits legitimately takes longer than 30 s.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
