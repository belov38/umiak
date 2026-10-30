import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["@sbx/db/testing/global-setup"],
		// A hang guard only: tests wait on conditions (budgets of 30 s each),
		// and under a full parallel `pnpm -r test` on a loaded machine a test
		// with several waits legitimately takes longer than 30 s.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
