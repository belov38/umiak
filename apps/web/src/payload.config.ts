// The Payload config of web: the platform config of @umiak/payload from the
// environment. Owner authorization is resolved on each request. The admin import map lives in
// src/app/(payload)/admin/importMap.js (`pnpm generate:importmap`).
import { buildUmiakConfig } from "@umiak/payload";
import { webEnv } from "./lib/env";

const env = webEnv();

export default buildUmiakConfig({
	databaseUrl: env.databaseUrl,
	secret: env.payloadSecret,
	operatorGroups: env.operatorGroups,
	appOrigin: env.appOrigin,
});
