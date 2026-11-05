-- Adopt the unchanged startup DDL from owner.mjs, setup.mjs and
-- platform-updates.mjs. Existing JSON documents and singleton rows are opaque:
-- never seed, normalize or reset them here. Older images retain the same layout.
CREATE SCHEMA IF NOT EXISTS quickstart;

CREATE TABLE IF NOT EXISTS quickstart.owner (
    id integer PRIMARY KEY CHECK(id=1),
    state jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS quickstart.setup (
    id boolean PRIMARY KEY DEFAULT true CHECK(id),
    state jsonb NOT NULL DEFAULT '{"steps":{},"complete":false}'
);

CREATE TABLE IF NOT EXISTS quickstart.updates (
    id boolean PRIMARY KEY DEFAULT true CHECK(id),
    settings jsonb NOT NULL,
    status jsonb NOT NULL DEFAULT '{}',
    history jsonb NOT NULL DEFAULT '[]'
);
