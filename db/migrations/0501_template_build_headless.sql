-- Existing builds remain unclassified until the catalog migration snapshots
-- their original identity. Newly registered builds use the current recipes.
ALTER TABLE runtime.template_builds ADD COLUMN IF NOT EXISTS headless boolean;
ALTER TABLE runtime.template_builds ALTER COLUMN headless SET DEFAULT false;
