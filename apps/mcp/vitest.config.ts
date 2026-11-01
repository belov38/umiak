import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages with a build step (@umiak/agent-client, @umiak/proto) are
// resolved from their TypeScript sources: their package.json exports carry a
// "source" condition. The api and the CLI enable that condition globally, but
// Vitest forwards the conditions to Node as `--conditions`, and third-party
// packages pulled in by the MCP client (eventsource, eventsource-parser) also
// ship a "source" condition pointing at .ts files under node_modules, which
// Node refuses to load. So the condition stays off and the workspace sources
// are aliased explicitly.
const packagesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"packages",
);

interface PackageJson {
	name: string;
	exports?: Record<string, { source?: string } | string>;
}

function workspaceSourceAliases() {
	const aliases: { find: RegExp; replacement: string }[] = [];
	for (const dir of readdirSync(packagesDir)) {
		const root = join(packagesDir, dir);
		let pkg: PackageJson;
		try {
			pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		} catch {
			continue;
		}
		for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
			if (typeof target === "string" || !target.source) continue;
			const name =
				subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
			aliases.push({
				find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
				replacement: join(root, target.source),
			});
		}
	}
	return aliases;
}

export default defineConfig({
	resolve: {
		alias: workspaceSourceAliases(),
		conditions: ["module", "browser", "development|production"],
	},
	ssr: {
		resolve: {
			conditions: ["module", "node", "development|production"],
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["@umiak/db/testing/global-setup"],
		// A hang guard only: tests wait on conditions and spawn processes, which
		// takes seconds on a loaded machine under a full parallel `pnpm -r test`.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
