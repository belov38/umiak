-- Remember policy denial transitions so direct media is revoked once, including public viewers.
ALTER TABLE runtime.sandbox_desktops ADD COLUMN policy_revoked boolean NOT NULL DEFAULT false;
