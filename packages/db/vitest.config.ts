import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["./src/testing/global-setup.ts"],
		// A hang guard only: the container guard tests wait for docker and a
		// watchdog, which takes seconds on a loaded machine.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
