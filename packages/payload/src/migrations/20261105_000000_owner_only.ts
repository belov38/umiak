import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

/** Corporate port policy is no longer configurable; owner sessions authorize access. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`ALTER TABLE payload.platform_defaults DROP COLUMN sso_port_policy, DROP COLUMN sso_policy_epoch;
 DROP TYPE payload.enum_platform_defaults_sso_port_policy;
 SELECT pg_notify('umiak_config', '*'); SELECT pg_notify('umiak_routes', '*');`);
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`CREATE TYPE payload.enum_platform_defaults_sso_port_policy AS ENUM ('any', 'team');
 ALTER TABLE payload.platform_defaults ADD COLUMN sso_port_policy payload.enum_platform_defaults_sso_port_policy NOT NULL DEFAULT 'team', ADD COLUMN sso_policy_epoch numeric DEFAULT 0;`);
}
