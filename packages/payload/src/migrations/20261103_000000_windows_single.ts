// S17: consolidate catalog identity without changing existing VM/build IDs.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
    INSERT INTO payload.templates
      (id, slug, name, os, enabled, default_size, allowed_sizes, login_user, capabilities, sort_order)
    VALUES (uuidv7(), 'windows', 'Windows 11', 'windows', true, '4gb', '["4gb", "8gb"]',
      'user', '["exec", "files", "ssh", "desktop"]', 1)
    ON CONFLICT (slug) DO UPDATE SET name = 'Windows 11', os = 'windows',
      default_size = '4gb', allowed_sizes = '["4gb", "8gb"]',
      capabilities = '["exec", "files", "ssh", "desktop"]';
    DELETE FROM payload.pool_targets WHERE template = 'windows-desktop';
    UPDATE payload.platform_defaults SET default_template = 'windows' WHERE default_template = 'windows-desktop';
    DELETE FROM payload.templates WHERE slug = 'windows-desktop';

    DO $migration$
    BEGIN
      -- Empty installs can migrate Payload before the runtime schema exists.
      IF to_regclass('runtime.template_builds') IS NOT NULL THEN
        -- Snapshot the original identity once, before changing catalog slugs.
        -- NULL denotes a build that existed before the metadata column.
        UPDATE runtime.template_builds SET headless = (os = 'windows' AND template_slug = 'windows')
          WHERE headless IS NULL;
        UPDATE runtime.template_builds SET status = 'retired'
          WHERE os = 'windows' AND headless = true;
        UPDATE runtime.template_builds b SET status = 'deprecated'
          WHERE b.template_slug IN ('windows', 'windows-desktop') AND b.status = 'active'
          AND EXISTS (SELECT 1 FROM runtime.template_builds d WHERE d.node_id = b.node_id
            AND d.pve_vmid = 595 AND d.version = '20261101.7' AND d.os = 'windows');
        -- Custom installations may use other slots/versions. Prefer their
        -- active desktop build over the old canonical headless identity.
        UPDATE runtime.template_builds b SET status = 'deprecated'
          WHERE b.template_slug = 'windows' AND b.status = 'active'
          AND EXISTS (SELECT 1 FROM runtime.template_builds d WHERE d.node_id = b.node_id
            AND d.template_slug = 'windows-desktop' AND d.status = 'active');
        UPDATE runtime.template_builds SET template_slug = 'windows'
          WHERE template_slug = 'windows-desktop';
        UPDATE runtime.template_builds SET status = 'active', promoted_at = COALESCE(promoted_at, now())
          WHERE id IN (SELECT DISTINCT ON (node_id) id FROM runtime.template_builds
            WHERE template_slug = 'windows' AND pve_vmid = 595 AND version = '20261101.7'
            ORDER BY node_id, created_at, id);
        UPDATE runtime.sandboxes SET template_slug = 'windows' WHERE template_slug = 'windows-desktop';
      END IF;
    END $migration$;
    SELECT pg_notify('umiak_config', '*');
  `);
}

// Reverting catalog identity would make new Windows desktops ambiguous. Restore
// the old application/config together from backup if a full rollback is needed.
export async function down(_args: MigrateDownArgs): Promise<void> {}
