import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["./src/testing/global-setup.ts"],
		testTimeout: 20_000,
		hookTimeout: 120_000,
	},
});
