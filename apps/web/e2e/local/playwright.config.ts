import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "local.e2e.ts",
	workers: 1,
	timeout: 120_000,
	use: { baseURL: "http://localhost:14180", headless: true },
});
