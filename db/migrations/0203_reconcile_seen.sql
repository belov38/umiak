-- Reconcile (S6 §11.2): first time the controller saw a VM or an LV of a
-- provider. S1 lists carry no creation time, so the 10 min grace for "fresh"
-- objects is measured from first_seen_at. name is '<node_id>/<vmid>' for kind
-- 'vm' and '<node_id>/<lv name>' for kind 'lv'. Rows of objects that are no
-- longer listed are deleted by the controller. Plain SQL: the migration runner
-- wraps the file in a transaction.

CREATE TABLE runtime.reconcile_seen (
  provider_id   uuid NOT NULL REFERENCES runtime.providers (id),
  kind          text NOT NULL CHECK (kind IN ('vm', 'lv')),
  name          text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, kind, name)
);
