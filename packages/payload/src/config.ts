// The Payload config of the platform (S8 §7): one config for api, worker
// (Local API, plain Node) and web (Next). No React imports here: admin
// components are referenced by import-map path strings from apps/web.
import { fileURLToPath } from "node:url";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { buildConfig, type EmailAdapter, type SanitizedConfig } from "payload";
import { ApiKeys } from "./collections/api-keys.ts";
import { Memberships } from "./collections/memberships.ts";
import { PoolTargets } from "./collections/pool-targets.ts";
import { Sizes } from "./collections/sizes.ts";
import { SshKeys } from "./collections/ssh-keys.ts";
import { TeamNotices } from "./collections/team-notices.ts";
import { Teams } from "./collections/teams.ts";
import { Templates } from "./collections/templates.ts";
import { Users } from "./collections/users.ts";
import { PlatformDefaults } from "./globals/platform-defaults.ts";

export interface SbxPayloadOptions {
	databaseUrl: string;
	/** PAYLOAD_SECRET. */
	secret: string;
	/** SBX_OPERATOR_GROUPS (S8 §5.5). */
	operatorGroups: string[];
	/** SBX_APP_ORIGIN: the only origin of unsafe requests (S8 §5.6). */
	appOrigin?: string;
	/** Size of the pg pool of the adapter (default 10). */
	poolMax?: number;
}

/** Postgres schema owned by Payload. */
export const PAYLOAD_SCHEMA = "payload";

/** Migrations of the payload schema (committed, applied by src/migrate.ts). */
export const PAYLOAD_MIGRATIONS_DIR: string = fileURLToPath(
	new URL("./migrations", import.meta.url),
);

/** Settings of the platform kept in config.custom.sbx (read by the auth strategy). */
export interface SbxCustomConfig {
	operatorGroups: string[];
}

const noEmail: EmailAdapter = () => ({
	name: "none",
	defaultFromAddress: "noreply@invalid",
	defaultFromName: "sbx",
	sendEmail: async () => {
		throw new Error("email is not configured");
	},
});

export function buildSbxConfig(o: SbxPayloadOptions): Promise<SanitizedConfig> {
	const sbx: SbxCustomConfig = { operatorGroups: [...o.operatorGroups] };
	return buildConfig({
		secret: o.secret,
		telemetry: false,
		db: postgresAdapter({
			schemaName: PAYLOAD_SCHEMA,
			idType: "uuidv7",
			// Schema changes only through committed migrations, in dev too (S8 §12).
			push: false,
			migrationDir: PAYLOAD_MIGRATIONS_DIR,
			// No prodMigrations: migrations are applied by the web-migrate job,
			// never at start (S8 §12).
			// The database is provisioned by the deployment.
			disableCreateDatabase: true,
			pool: { connectionString: o.databaseUrl, max: o.poolMax ?? 10 },
		}),
		// The platform sends no email (S8 §6.3); this also keeps Payload from
		// warning about a missing adapter at every start.
		email: noEmail,
		graphQL: { disable: true },
		// /api/* of app.<domain> belongs to the api service (S7 §5.1).
		routes: { api: "/cms-api", admin: "/admin" },
		csrf: o.appOrigin ? [o.appOrigin] : [],
		cookiePrefix: "__Host-payload",
		admin: { user: "users" },
		typescript: { autoGenerate: false },
		collections: [
			Users,
			Teams,
			Memberships,
			ApiKeys,
			TeamNotices,
			SshKeys,
			Templates,
			Sizes,
			PoolTargets,
		],
		globals: [PlatformDefaults],
		custom: { sbx },
	});
}
