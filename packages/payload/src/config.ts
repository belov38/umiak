// The Payload config of the platform (S8 §7): one config for api, worker
// (Local API, plain Node) and web (Next). No React imports here: admin
// components are referenced by import-map path strings from apps/web.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { parseAuthMode } from "@umiak/auth";
import { buildConfig, type EmailAdapter, type SanitizedConfig } from "payload";
import { nobody, operatorAccess, operatorOnly } from "./access.ts";
import { ApiKeys } from "./collections/api-keys.ts";
import { Memberships } from "./collections/memberships.ts";
import { PoolTargets } from "./collections/pool-targets.ts";
import { Sizes } from "./collections/sizes.ts";
import { SshKeys } from "./collections/ssh-keys.ts";
import { Teams } from "./collections/teams.ts";
import { Templates } from "./collections/templates.ts";
import { Users } from "./collections/users.ts";
import { PlatformDefaults } from "./globals/platform-defaults.ts";

export interface UmiakPayloadOptions {
	databaseUrl: string;
	/** PAYLOAD_SECRET. */
	secret: string;
	/** UMIAK_OPERATOR_GROUPS (S8 §5.5). */
	operatorGroups: string[];
	/** UMIAK_APP_ORIGIN: the only origin of unsafe requests (S8 §5.6). */
	appOrigin?: string;
	/** Size of the pg pool of the adapter (default 10). */
	poolMax?: number;
}

/** Postgres schema owned by Payload. */
export const PAYLOAD_SCHEMA = "payload";

/**
 * Migrations of the payload schema (committed, applied by src/migrate.ts).
 * Not `new URL("./migrations", import.meta.url)`: bundlers (Turbopack in
 * apps/web) turn that form into an asset reference.
 */
export const PAYLOAD_MIGRATIONS_DIR: string = join(
	dirname(fileURLToPath(import.meta.url)),
	"migrations",
);

/** Settings of the platform kept in config.custom.umiak (read by the auth strategy). */
export interface UmiakCustomConfig {
	operatorGroups: string[];
}

const noEmail: EmailAdapter = () => ({
	name: "none",
	defaultFromAddress: "noreply@invalid",
	defaultFromName: "Umiak",
	sendEmail: async () => {
		throw new Error("email is not configured");
	},
});

/**
 * Payload's own collections. payload-locked-documents takes any signed-in
 * user by default (/cms-api would show every member who edits what in
 * /admin): operators only, as /admin. payload-migrations (no REST
 * endpoints) is closed too. payload-preferences stays: Payload scopes it to
 * the user of the request.
 */
function restrictInternalCollections(config: SanitizedConfig): SanitizedConfig {
	for (const c of config.collections) {
		if (c.slug === "payload-locked-documents") {
			c.access = { ...c.access, ...operatorAccess };
		} else if (c.slug === "payload-migrations") {
			c.access = {
				...c.access,
				read: operatorOnly,
				create: nobody,
				update: nobody,
				delete: nobody,
			};
		}
	}
	return config;
}

export async function buildUmiakConfig(
	o: UmiakPayloadOptions,
): Promise<SanitizedConfig> {
	const umiak: UmiakCustomConfig = { operatorGroups: [...o.operatorGroups] };
	const config = await buildConfig({
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
		cookiePrefix:
			parseAuthMode() === "owner" && o.appOrigin?.startsWith("http:")
				? "payload"
				: "__Host-payload",
		// avatar "default": no Gravatar request (an external origin, and it
		// would hand every user's email hash to a third party).
		admin: {
			user: "users",
			avatar: "default",
			components: {
				beforeNavLinks: ["/src/components/admin/brand#Logo"],
				...(parseAuthMode() === "owner"
					? {
							logout: {
								Button: "/src/components/admin/owner-logout#OwnerLogout",
							},
						}
					: {}),
				graphics: {
					Logo: "/src/components/admin/brand#Logo",
					Icon: "/src/components/admin/brand#Icon",
				},
			},
			meta: {
				titleSuffix: " — Umiak",
				icons: [{ rel: "icon", type: "image/svg+xml", url: "/icon.svg" }],
			},
		},
		typescript: { autoGenerate: false },
		collections: [
			Users,
			Teams,
			Memberships,
			ApiKeys,
			SshKeys,
			Templates,
			Sizes,
			PoolTargets,
		],
		globals: [PlatformDefaults],
		custom: { umiak },
	});
	return restrictInternalCollections(config);
}
