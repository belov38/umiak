-- A failed EndStreams RPC must be retried after policy revocation.
ALTER TABLE runtime.sandbox_desktops ADD COLUMN pending_disconnect boolean NOT NULL DEFAULT false;
