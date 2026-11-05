-- A resource may move back to a node later; retain each historical journal.
ALTER TABLE runtime.volume_transfers DROP CONSTRAINT volume_transfers_kind_source_id_target_node_id_key;
CREATE UNIQUE INDEX volume_transfers_open_uq ON runtime.volume_transfers(kind,source_id,target_node_id) WHERE phase NOT IN ('done','cancelled');
CREATE TABLE runtime.move_reservations (
 machine_id uuid PRIMARY KEY REFERENCES runtime.machines(id),
 operation_id uuid NOT NULL REFERENCES runtime.operations(id),
 node_id uuid NOT NULL REFERENCES runtime.nodes(id),
 storage_id uuid NOT NULL REFERENCES runtime.storages(id),
 memory_mb int NOT NULL CHECK(memory_mb>0)
);
