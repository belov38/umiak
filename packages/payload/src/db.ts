import type { PostgresAdapter } from "@payloadcms/db-postgres";
import type { Payload } from "payload";

/** The pg pool of the Postgres adapter of a Payload instance. */
export function dbPool(payload: Payload): PostgresAdapter["pool"] {
	return (payload.db as unknown as PostgresAdapter).pool;
}
