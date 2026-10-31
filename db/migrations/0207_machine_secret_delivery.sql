-- Windows files survive a hard stop. Existing machines have no durable wipe
-- confirmation, so fail closed until a clean stop or an empty delivery.
ALTER TABLE runtime.machines
  ADD COLUMN secret_files_on_disk boolean NOT NULL DEFAULT false,
  ADD COLUMN secrets_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN provisioned_secrets_generation integer NOT NULL DEFAULT 0;

UPDATE runtime.machines m SET secret_files_on_disk = true
FROM runtime.template_builds b
WHERE m.template_build_id = b.id AND b.os = 'windows'
  AND m.sandbox_id IS NOT NULL AND m.state <> 'deleted';
