// S10 desktop defaults: PlatformDefaults.publicDesktopEnabled, the 8gb size,
// 4 vCPU for 4gb (S10 section 15.1; S9 seeded 2) and the linux-desktop and
// windows-desktop templates.
// Operator-edited records are kept: inserts skip existing slugs and the 4gb
// update applies only to the untouched S9 seed value. IF NOT EXISTS: dev stands that ran
// the pre-rebase S10 migration 20261031_105048_desktop_defaults already have the column.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
    ALTER TABLE "payload"."platform_defaults" ADD COLUMN IF NOT EXISTS "public_desktop_enabled" boolean DEFAULT false;

    INSERT INTO "payload"."sizes" ("id", "slug", "vcpu", "memory_mb", "sort_order")
    VALUES (uuidv7(), '4gb', 4, 4096, 1), (uuidv7(), '8gb', 8, 8192, 2)
    ON CONFLICT ("slug") DO NOTHING;
    UPDATE "payload"."sizes" SET "vcpu" = 4 WHERE "slug" = '4gb' AND "vcpu" = 2;

    INSERT INTO "payload"."templates" (
      "id", "slug", "name", "os", "enabled", "default_size", "allowed_sizes",
      "login_user", "capabilities", "sort_order"
    ) VALUES (
      uuidv7(), 'linux-desktop', 'Linux Desktop', 'linux', true, '4gb', '["4gb", "8gb"]',
      'user', '["exec", "files", "ssh", "desktop"]', 2
    ), (
      uuidv7(), 'windows-desktop', 'Windows 11 Desktop', 'windows', true, '4gb', '["4gb", "8gb"]',
      'user', '["exec", "files", "ssh", "desktop"]', 3
    ) ON CONFLICT ("slug") DO NOTHING;

    SELECT pg_notify('sbx_config', '*');
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`
    ALTER TABLE "payload"."platform_defaults" DROP COLUMN IF EXISTS "public_desktop_enabled";`);
}
