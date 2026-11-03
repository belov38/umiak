-- S19 owns 0600-0699. Retain topology and build history after node removal.
ALTER TABLE runtime.nodes ADD COLUMN retired_at timestamptz;
CREATE TABLE runtime.node_build_jobs (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  node_id uuid NOT NULL REFERENCES runtime.nodes(id),
  template_slug text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'interrupted', 'succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX node_build_jobs_open_uq ON runtime.node_build_jobs(node_id)
  WHERE status IN ('running', 'interrupted');
