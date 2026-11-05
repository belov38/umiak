import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

/** Corporate port policy is no longer configurable; owner sessions authorize access. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`DO $$ BEGIN
 IF to_regclass('runtime.hosted_ports') IS NOT NULL THEN
 UPDATE runtime.hosted_ports SET auth_epoch=auth_epoch+COALESCE((SELECT sso_policy_epoch FROM payload.platform_defaults LIMIT 1),0)+1;
 END IF;
 END $$;
 ALTER TABLE payload.platform_defaults DROP COLUMN sso_port_policy, DROP COLUMN sso_policy_epoch;
 DROP TYPE payload.enum_platform_defaults_sso_port_policy;
 ALTER TABLE payload.users ALTER COLUMN deactivated_reason TYPE text USING deactivated_reason::text;
 UPDATE payload.users SET deactivated_reason='operator' WHERE deactivated_reason IS NOT NULL;
 DROP TYPE payload.enum_users_deactivated_reason;
 CREATE TYPE payload.enum_users_deactivated_reason AS ENUM ('operator');
 ALTER TABLE payload.users ALTER COLUMN deactivated_reason TYPE payload.enum_users_deactivated_reason USING deactivated_reason::payload.enum_users_deactivated_reason;
 SELECT pg_notify('umiak_config', '*'); SELECT pg_notify('umiak_routes', '*');`);
}
export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`ALTER TABLE payload.users ALTER COLUMN deactivated_reason TYPE text USING deactivated_reason::text;
 DROP TYPE payload.enum_users_deactivated_reason;
 CREATE TYPE payload.enum_users_deactivated_reason AS ENUM ('operator','idp_disabled','idp_deleted');
 ALTER TABLE payload.users ALTER COLUMN deactivated_reason TYPE payload.enum_users_deactivated_reason USING deactivated_reason::payload.enum_users_deactivated_reason;
 CREATE TYPE payload.enum_platform_defaults_sso_port_policy AS ENUM ('any', 'team');
 ALTER TABLE payload.platform_defaults ADD COLUMN sso_port_policy payload.enum_platform_defaults_sso_port_policy NOT NULL DEFAULT 'team', ADD COLUMN sso_policy_epoch numeric DEFAULT 0;`);
}
