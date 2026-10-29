-- Tunnel registry schema (S2). Owned by S2 / gateway (range 0100-0199).
-- The worker (S6) writes only tunnel_credentials.bs_hash (at machine creation)
-- and tunnel_credentials.retired_at (at delete); gateway writes the rest.
-- Plain SQL: the migration runner wraps the file in a transaction.

CREATE SCHEMA tunnel;

CREATE TABLE tunnel.gateway_instances (
  id               text PRIMARY KEY,
  internal_url     text NOT NULL,
  state            text NOT NULL CHECK (state IN ('active', 'draining')),
  started_at       timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL,
  drain_started_at timestamptz
);

CREATE TABLE tunnel.tunnel_sessions (
  machine_id        uuid PRIMARY KEY,
  instance_id       text NOT NULL,
  epoch             bigint NOT NULL,
  conn_id           text NOT NULL,
  agent_instance_id text NOT NULL,
  boot_id           text NOT NULL,
  vmgenid           text NOT NULL,
  agent_version     text NOT NULL,
  proto_version     text NOT NULL,
  capabilities      text[] NOT NULL DEFAULT '{}',
  state             text NOT NULL CHECK (state IN ('connected', 'disconnected')),
  connected_at      timestamptz NOT NULL,
  disconnected_at   timestamptz
);

CREATE INDEX tunnel_sessions_instance_id_idx ON tunnel.tunnel_sessions (instance_id);

CREATE TABLE tunnel.tunnel_credentials (
  machine_id    uuid PRIMARY KEY,
  bs_hash       bytea NOT NULL,
  mt_hash       bytea,
  mt_next_hash  bytea,
  mt_issued_at  timestamptz,
  retired_at    timestamptz
);

-- NOTIFY tunnel_sessions, '<machine_id>' on every session change and on retire.
CREATE FUNCTION tunnel.notify_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('tunnel_sessions', NEW.machine_id::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER tunnel_sessions_notify
  AFTER INSERT OR UPDATE ON tunnel.tunnel_sessions
  FOR EACH ROW EXECUTE FUNCTION tunnel.notify_session();

CREATE TRIGGER tunnel_credentials_retired_notify
  AFTER UPDATE OF retired_at ON tunnel.tunnel_credentials
  FOR EACH ROW EXECUTE FUNCTION tunnel.notify_session();

-- NOTIFY gateway_instances, '<id>' when an instance appears, disappears or
-- changes state (non-owner pods learn that an owner started draining).
CREATE FUNCTION tunnel.notify_instance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('gateway_instances', OLD.id);
  ELSE
    PERFORM pg_notify('gateway_instances', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER gateway_instances_notify
  AFTER INSERT OR DELETE OR UPDATE OF state, drain_started_at ON tunnel.gateway_instances
  FOR EACH ROW EXECUTE FUNCTION tunnel.notify_instance();
