-- Historical S17 runtime transition, retained as a pre-S24 regression fixture.
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
