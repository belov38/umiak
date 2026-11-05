-- S21 immutable content identities and durable cross-node transfer journal.
ALTER TABLE runtime.template_builds ADD COLUMN source_build_id uuid REFERENCES runtime.template_builds(id);
ALTER TABLE runtime.template_builds ADD COLUMN manifest jsonb;
ALTER TABLE runtime.template_builds ADD COLUMN checksums jsonb;
CREATE TABLE runtime.volume_transfers (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 kind text NOT NULL CHECK(kind IN ('template','machine','snapshot')),
 source_id uuid NOT NULL,
 source_node_id uuid NOT NULL REFERENCES runtime.nodes(id),
 target_node_id uuid NOT NULL REFERENCES runtime.nodes(id),
 target_storage_id uuid NOT NULL REFERENCES runtime.storages(id),
 target_vmid int,
 phase text NOT NULL DEFAULT 'preparing',
 progress jsonb NOT NULL DEFAULT '{}',
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(kind,source_id,target_node_id)
);
