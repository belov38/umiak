-- S7 additions to the S6 tables (S7 §20.2 items 2, 3, operator blocks of S8 C3).
-- Plain SQL: the migration runner wraps the file in a transaction.

-- Commands: guest user, tags, argv (no shell) and the agent's pid (S7 §9.6).
ALTER TABLE runtime.commands
  ADD COLUMN "user" text NOT NULL DEFAULT 'user',
  ADD COLUMN tags   jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN argv   jsonb,
  ADD COLUMN pid    int;

-- GET /commands?status= (S7 §9.4).
CREATE INDEX commands_sandbox_status_idx ON runtime.commands (sandbox_id, status);

-- Hosted ports: proxy options (S4 §8.1, S7 §11.2) and operator blocks (S8).
ALTER TABLE runtime.hosted_ports
  ADD COLUMN host_rewrite text NOT NULL DEFAULT 'preserve'
    CHECK (host_rewrite IN ('preserve', 'localhost')),
  ADD COLUMN app_protocol text NOT NULL DEFAULT 'http1'
    CHECK (app_protocol IN ('http1', 'h2c')),
  ADD COLUMN blocked      boolean NOT NULL DEFAULT false,
  ADD COLUMN block_reason text;

-- Sandbox block by an operator (S8): every port of the sandbox is blocked.
ALTER TABLE runtime.sandboxes
  ADD COLUMN blocked      boolean NOT NULL DEFAULT false,
  ADD COLUMN block_reason text;

-- Routes of a sandbox also change when its block changes (S7 O7), so the
-- sandboxes trigger of 0201 notifies sbx_routes on blocked/block_reason too.
CREATE OR REPLACE FUNCTION runtime.sandboxes_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('sbx_sandboxes', NEW.id::text);
    RETURN NULL;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state OR NEW.health IS DISTINCT FROM OLD.health THEN
    PERFORM pg_notify('sbx_sandboxes', NEW.id::text);
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     OR NEW.machine_id IS DISTINCT FROM OLD.machine_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.blocked IS DISTINCT FROM OLD.blocked
     OR NEW.block_reason IS DISTINCT FROM OLD.block_reason THEN
    PERFORM pg_notify('sbx_routes', OLD.slug);
    IF NEW.slug IS DISTINCT FROM OLD.slug THEN
      PERFORM pg_notify('sbx_routes', NEW.slug);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
