// Playwright E2E of the dashboard (S8 §15) against the compose E2E stack
// (deploy/compose/e2e.yaml). `pnpm --filter @sbx/web test:e2e` brings the
// stack up, runs this config and tears it down (run.ts); `pnpm exec
// playwright test -c e2e` runs against a stack that is already up.
import { defineConfig, devices } from "@playwright/test";
import { APP } from "./env.ts";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	globalSetup: "./global-setup.ts",
	// The scenarios share users and sandboxes of one run: one worker, in
	// file order.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 180_000,
	expect: { timeout: 30_000 },
	outputDir: "../test-results",
	reporter: [
		["list"],
		["html", { outputFolder: "../playwright-report", open: "never" }],
	],
	use: {
		baseURL: APP,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		actionTimeout: 30_000,
		navigationTimeout: 60_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
