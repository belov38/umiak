-- Build and verification VMs share the provider allocator, but are owned by
-- their durable build job rather than a runtime machine/reconciliation loop.
ALTER TABLE runtime.vmid_leases ADD COLUMN build_job_id text REFERENCES runtime.node_build_jobs(id);
CREATE INDEX vmid_leases_build_job_idx ON runtime.vmid_leases(build_job_id) WHERE build_job_id IS NOT NULL;
