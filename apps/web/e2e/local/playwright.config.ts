import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "local.e2e.ts",
	workers: 1,
	outputDir: "../../test-results-local",
	timeout: 120_000,
	use: {
		baseURL: process.env.UMIAK_E2E_APP_URL ?? "http://localhost:14180",
		headless: true,
	},
});
