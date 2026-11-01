// The Payload config of web: the platform config of @umiak/payload from the
// environment (S8 §14.1), with the session cache of plan decision 8 (LISTEN
// umiak_identity, one connection per process). The admin import map lives in
// src/app/(payload)/admin/importMap.js (`pnpm generate:importmap`).
import { buildUmiakConfig } from "@umiak/payload";
import { isNextBuild, webEnv } from "./lib/env";

const env = webEnv();

export default buildUmiakConfig({
	databaseUrl: env.databaseUrl,
	secret: env.payloadSecret,
	operatorGroups: env.operatorGroups,
	appOrigin: env.appOrigin,
	// No database connection is opened during `next build`.
	...(isNextBuild()
		? {}
		: {
				sessionCache: {
					onListenError: (err: unknown) => {
						console.error("umiak_identity listener:", err);
					},
				},
			}),
});
