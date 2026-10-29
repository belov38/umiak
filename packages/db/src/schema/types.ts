import { customType, timestamp } from "drizzle-orm/pg-core";

/** bytea as a Node Buffer (drizzle-orm 0.45 has no built-in bytea). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType: () => "bytea",
});

/** timestamptz as a Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });
