import { defineConfig } from "vitest/config";

// Resolve workspace packages (@sbx/proto) from their TypeScript sources.
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
		testTimeout: 20_000,
		hookTimeout: 120_000,
	},
});
