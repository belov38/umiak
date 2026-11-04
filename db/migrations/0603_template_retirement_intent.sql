-- A retirement is resumable even when its console dies after PVE accepted delete.
ALTER TABLE runtime.node_build_jobs
 ADD COLUMN retiring_build_id uuid REFERENCES runtime.template_builds(id),
 ADD COLUMN pve_task_upid text,
 ADD COLUMN pve_delete_requested_at timestamptz;
CREATE UNIQUE INDEX node_build_jobs_retiring_build_uq ON runtime.node_build_jobs(retiring_build_id)
 WHERE retiring_build_id IS NOT NULL;
