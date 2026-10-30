// Migrations of the payload schema in order. Written by
// src/create-migration.ts (Payload's own index has imports without the .ts
// extension that Node type stripping needs).
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
