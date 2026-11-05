-- Desktop uses WebSocket through the owner ingress; relay credential renewal was retired.
ALTER TABLE runtime.sandbox_desktops DROP COLUMN turn_issued_at, DROP COLUMN turn_attempted_at;
