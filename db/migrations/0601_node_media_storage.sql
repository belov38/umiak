-- ISO/import storage is node-local just like template disks.
ALTER TABLE runtime.nodes ADD COLUMN media_storage text NOT NULL DEFAULT 'local';
