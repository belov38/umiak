import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@payload-config": fileURLToPath(
				new URL("./src/payload.config.ts", import.meta.url),
			),
			"@/": fileURLToPath(new URL("./src/", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		globalSetup: ["@sbx/db/testing/global-setup"],
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
