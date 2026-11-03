// S17: consolidate catalog identity without changing existing VM/build IDs.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
    WITH policy AS (
      SELECT
        COALESCE(NULLIF(CASE WHEN w.name NOT IN ('Windows 11', 'windows') THEN w.name END, ''),
          NULLIF(d.name, ''), NULLIF(w.name, ''), 'Windows 11') AS name,
        CASE WHEN w.id IS NULL AND d.id IS NULL THEN true
          ELSE COALESCE(w.enabled, false) OR COALESCE(d.enabled, false) END AS enabled,
        COALESCE(NULLIF(d.default_size, ''), NULLIF(w.default_size, ''), '4gb') AS default_size,
        COALESCE(w.allowed_sizes, '[]'::jsonb) || COALESCE(d.allowed_sizes, '[]'::jsonb) AS sizes,
        COALESCE(w.login_user, d.login_user, 'user') AS login_user,
        COALESCE(w.sort_order, d.sort_order, 1) AS sort_order
      FROM (SELECT 1) seed
      LEFT JOIN payload.templates w ON w.slug = 'windows'
      LEFT JOIN payload.templates d ON d.slug = 'windows-desktop'
    )
    INSERT INTO payload.templates
      (id, slug, name, os, enabled, default_size, allowed_sizes, login_user, capabilities, sort_order)
    SELECT uuidv7(), 'windows', name, 'windows', enabled, default_size,
      (SELECT jsonb_agg(value ORDER BY value) FROM (
        SELECT DISTINCT value FROM jsonb_array_elements(
          (CASE WHEN sizes = '[]'::jsonb THEN '["4gb", "8gb"]'::jsonb ELSE sizes END)
          || jsonb_build_array(default_size)) AS entry(value)
      ) merged), login_user, '["exec", "files", "ssh", "desktop"]', sort_order
    FROM policy
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, os = EXCLUDED.os,
      enabled = EXCLUDED.enabled, default_size = EXCLUDED.default_size,
      allowed_sizes = EXCLUDED.allowed_sizes,
      capabilities = EXCLUDED.capabilities;
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
        -- Preserve the newest currently active desktop per node. Never revive
        -- an inactive historical image just because it used a familiar slot.
        UPDATE runtime.template_builds b SET status = 'deprecated'
          WHERE b.template_slug IN ('windows', 'windows-desktop') AND b.status = 'active'
          AND b.id NOT IN (SELECT DISTINCT ON (node_id) id FROM runtime.template_builds
            WHERE template_slug IN ('windows', 'windows-desktop') AND headless = false AND status = 'active'
            ORDER BY node_id, created_at DESC, version DESC, id DESC);
        UPDATE runtime.template_builds SET template_slug = 'windows'
          WHERE template_slug = 'windows-desktop';
        UPDATE runtime.sandboxes SET template_slug = 'windows' WHERE template_slug = 'windows-desktop';
      END IF;
    END $migration$;
    SELECT pg_notify('umiak_config', '*');
  `);
}

// Reverting catalog identity would make new Windows desktops ambiguous. Restore
// the old application/config together from backup if a full rollback is needed.
export async function down(_args: MigrateDownArgs): Promise<void> {}
