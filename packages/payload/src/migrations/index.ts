// Migrations of the payload schema in order. Payload's writeMigrationIndex
// emits imports without extensions; under Node type stripping they need .ts,
// so this file is kept by hand: add each new migration here.
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";
import * as m20261030_164255_initial from "./20261030_164255_initial.ts";

export interface PayloadMigration {
	name: string;
	up: (args: MigrateUpArgs) => Promise<void>;
	down: (args: MigrateDownArgs) => Promise<void>;
}

export const migrations: PayloadMigration[] = [
	{
		up: m20261030_164255_initial.up,
		down: m20261030_164255_initial.down,
		name: "20261030_164255_initial",
	},
];
