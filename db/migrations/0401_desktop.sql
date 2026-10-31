-- S10 desktop policy and hashed single-use tickets. Runner supplies the transaction.
CREATE TABLE runtime.sandbox_desktops (
 sandbox_id uuid PRIMARY KEY REFERENCES runtime.sandboxes(id) ON DELETE CASCADE,
 access text NOT NULL DEFAULT 'token' CHECK(access IN ('token','sso','public')),
 auth_epoch int NOT NULL DEFAULT 1 CHECK(auth_epoch > 0),
 blocked boolean NOT NULL DEFAULT false,
 block_reason text,
 turn_issued_at timestamptz,
 last_stop_operation_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE runtime.desktop_tickets (
 ticket_hash bytea PRIMARY KEY,
 sandbox_id uuid NOT NULL REFERENCES runtime.sandbox_desktops(sandbox_id) ON DELETE CASCADE,
 label text NOT NULL,
 user_id text,
 api_key_id text,
 auth_epoch int NOT NULL,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX desktop_tickets_created_idx ON runtime.desktop_tickets(created_at);
CREATE INDEX desktop_tickets_principal_idx ON runtime.desktop_tickets(user_id,api_key_id);
CREATE FUNCTION runtime.desktop_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sb uuid; slug_value text;
BEGIN
 IF TG_OP='DELETE' THEN sb:=OLD.sandbox_id; ELSE sb:=NEW.sandbox_id; END IF;
 SELECT slug INTO slug_value FROM runtime.sandboxes WHERE id=sb;
 IF slug_value IS NOT NULL THEN PERFORM pg_notify('sbx_routes',slug_value); END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER desktop_notify AFTER INSERT OR UPDATE OR DELETE ON runtime.sandbox_desktops
 FOR EACH ROW EXECUTE FUNCTION runtime.desktop_notify();
