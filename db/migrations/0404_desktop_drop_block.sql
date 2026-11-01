-- The operator block lives on runtime.sandboxes; the per-desktop copy was never written.
ALTER TABLE runtime.sandbox_desktops DROP COLUMN blocked, DROP COLUMN block_reason;
