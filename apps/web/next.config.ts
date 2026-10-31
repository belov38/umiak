import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

const config: NextConfig = {
	// Image for S12: node .next/standalone/apps/web/server.js (S8 §14.1).
	output: "standalone",
	// Trace dependencies from the repo root (pnpm workspace).
	outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
	// Workspace packages ship TypeScript sources with `.ts` import extensions.
	transpilePackages: ["@sbx/auth", "@sbx/config", "@sbx/payload", "@sbx/sdk"],
	// Types are checked by `pnpm typecheck` (TypeScript 7 has no JS API for Next).
	typescript: { ignoreBuildErrors: true },
	poweredByHeader: false,
	reactStrictMode: true,
	// No generated AGENTS.md in the app directory.
	agentRules: false,
	experimental: {
		// forbidden()/unauthorized() render 403/401 pages with those statuses.
		authInterrupts: true,
	},
};

export default withPayload(config, { devBundleServerPackages: false });
