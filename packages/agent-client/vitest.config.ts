import { defineConfig } from "vitest/config";

// Resolve workspace packages (@umiak/proto) from their TypeScript sources.
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
		globalSetup: ["test/helpers/pg-global-setup.ts"],
		// A hang guard only: under a full parallel `pnpm -r test` on a loaded
		// machine a test with a few waits can take longer than 20 s.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
