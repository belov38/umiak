// Migrations of the payload schema in order. Written by
// src/create-migration.ts (Payload's own index has imports without the .ts
// extension that Node type stripping needs).
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";
import * as m20261030_164255_initial from "./20261030_164255_initial.ts";
import * as m20261030_171459_api_keys_team_nullable from "./20261030_171459_api_keys_team_nullable.ts";
import * as m20261101_000000_windows_template from "./20261101_000000_windows_template.ts";
import * as m20261101_010000_desktop_defaults from "./20261101_010000_desktop_defaults.ts";

import * as m20261103_000000_windows_single from "./20261103_000000_windows_single.ts";

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
	{
		up: m20261030_171459_api_keys_team_nullable.up,
		down: m20261030_171459_api_keys_team_nullable.down,
		name: "20261030_171459_api_keys_team_nullable",
	},
	{
		up: m20261101_000000_windows_template.up,
		down: m20261101_000000_windows_template.down,
		name: "20261101_000000_windows_template",
	},
	{
		up: m20261101_010000_desktop_defaults.up,
		down: m20261101_010000_desktop_defaults.down,
		name: "20261101_010000_desktop_defaults",
	},
	{
		up: m20261103_000000_windows_single.up,
		down: m20261103_000000_windows_single.down,
		name: "20261103_000000_windows_single",
	},
];
