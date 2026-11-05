import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

// Debian support was deferred (docs/specs/s23-debian-template.md) after
// 0.4.0-edge.20261105.3 had seeded it into the catalog. Remove the catalog
// entry and retire any Debian builds so nothing offers or schedules it.
export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
        DELETE FROM payload.pool_targets WHERE template = 'debian';
        UPDATE payload.platform_defaults SET default_template = 'linux' WHERE default_template = 'debian';
        DELETE FROM payload.templates WHERE slug = 'debian';
        DO $migration$
        BEGIN
          IF to_regclass('runtime.template_builds') IS NOT NULL THEN
            UPDATE runtime.template_builds SET status = 'retired'
              WHERE template_slug = 'debian' AND status IN ('building', 'active', 'deprecated');
          END IF;
        END
        $migration$;
        SELECT pg_notify('sbx_config', '*');
        SELECT pg_notify('umiak_config', '*');
    `);
}
// Nothing to restore: the template stays deferred.
export async function down(_args: MigrateDownArgs): Promise<void> {}
