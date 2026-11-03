import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";
export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(
		sql`UPDATE payload.templates SET name='Windows 11' WHERE slug='windows' AND name IN ('Windows 11 Desktop', 'windows', 'windows-desktop'); SELECT pg_notify('umiak_config', '*');`,
	);
}
export async function down(_args: MigrateDownArgs): Promise<void> {}
