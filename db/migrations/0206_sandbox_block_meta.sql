-- Operator blocks of S8 C3 (S8 §17.2 S4): when and by whom a sandbox or a
-- hosted port was blocked. `blocked`/`block_reason` and the `sbx_routes`
-- notification on their change are in 0204 (sandboxes) and 0201 (any
-- hosted_ports change). Plain SQL: the migration runner wraps the file in a
-- transaction.

ALTER TABLE runtime.sandboxes
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN blocked_by uuid,  -- the operator (Payload user id)
  ADD CONSTRAINT sandboxes_block_reason_check
    CHECK (block_reason IS NULL OR block_reason IN ('operator', 'abuse'));

ALTER TABLE runtime.hosted_ports
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN blocked_by uuid,
  ADD CONSTRAINT hosted_ports_block_reason_check
    CHECK (block_reason IS NULL OR block_reason IN ('operator', 'abuse'));
