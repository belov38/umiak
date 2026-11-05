import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
        UPDATE payload.templates SET name='Ubuntu 26.04' WHERE slug='linux' AND name IN ('linux', 'Linux', 'Ubuntu');
        INSERT INTO payload.templates (id, slug, name, os, enabled, default_size, allowed_sizes, login_user, capabilities, sort_order)
        VALUES (uuidv7(), 'debian', 'Debian 13', 'linux', true, '2gb', '["2gb"]', 'user', '["exec", "files", "ssh"]', 1)
        ON CONFLICT (slug) DO NOTHING;
        SELECT pg_notify('sbx_config', '*');
        SELECT pg_notify('umiak_config', '*');
    `);
}
// Preserve sandboxes and operator edits on downgrade.
export async function down(_args: MigrateDownArgs): Promise<void> {}
