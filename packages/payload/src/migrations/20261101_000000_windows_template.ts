// S9 runtime catalog registration. The compose YAML only bootstraps build
// metadata; API and worker read templates and sizes from Payload (S8).
// Keep any operator-created records, including disabled Windows templates.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
    INSERT INTO "payload"."sizes" ("id", "slug", "vcpu", "memory_mb", "sort_order")
    VALUES (uuidv7(), '4gb', 2, 4096, 1)
    ON CONFLICT ("slug") DO NOTHING;

    INSERT INTO "payload"."templates" (
      "id", "slug", "name", "os", "enabled", "default_size", "allowed_sizes",
      "login_user", "capabilities", "sort_order"
    ) VALUES (
      uuidv7(), 'windows', 'Windows 11', 'windows', true, '4gb', '["4gb"]',
      'user', '["exec", "files", "ssh"]', 1
    ) ON CONFLICT ("slug") DO NOTHING;

    SELECT pg_notify('sbx_config', '*');
  `);
}

// Catalog entries may already be referenced by sandboxes or edited in /admin.
// Rolling back application code must leave them and their settings intact.
export async function down(_args: MigrateDownArgs): Promise<void> {}
