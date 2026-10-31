// Generates a migration of the payload schema from the current config:
//   node packages/payload/src/create-migration.ts <name>
// No database is needed: the diff is taken against the latest .json snapshot
// in src/migrations. Exits 0 without a file when nothing changed. Payload's
// generator writes `import { MigrateUpArgs, ... }` and an index without
// extensions; both are rewritten for Node type stripping.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BasePayload } from "payload";
import { buildSbxConfig, PAYLOAD_MIGRATIONS_DIR } from "./config.ts";

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
	console.error("usage: node src/create-migration.ts <name in [a-z0-9_]>");
	process.exit(1);
}

const config = await buildSbxConfig({
	databaseUrl: "postgres://unused@127.0.0.1:1/unused",
	secret: "create-migration",
	operatorGroups: [],
});
const payload = await new BasePayload().init({
	config,
	disableDBConnect: true,
	disableOnInit: true,
});
await payload.db.createMigration({
	migrationName: name,
	payload,
	skipEmpty: true,
});

const files = (await readdir(PAYLOAD_MIGRATIONS_DIR))
	.filter((f) => /^\d{8}_\d{6}_[a-z0-9_]+\.ts$/.test(f))
	.sort();
const latest = files.at(-1);
// createMigration exits when nothing changed, so `latest` is the new file.
if (latest) {
	const file = path.join(PAYLOAD_MIGRATIONS_DIR, latest);
	const src = await readFile(file, "utf8");
	const IMPORT_RE =
		/^import \{ MigrateUpArgs, MigrateDownArgs, sql \} from '@payloadcms\/db-postgres'/m;
	if (!IMPORT_RE.test(src)) {
		// Payload changed its template: the value imports of types would break
		// the migration under type stripping, so stop instead of leaving it.
		console.error(
			`${file}: the generated import line is not the expected one; fix it to type imports by hand and update create-migration.ts`,
		);
		process.exit(1);
	}
	await writeFile(
		file,
		src
			.replace(
				IMPORT_RE,
				"import { type MigrateDownArgs, type MigrateUpArgs, sql } from '@payloadcms/db-postgres'",
			)
			.replaceAll("({ db, payload, req }: Migrate", "({ db }: Migrate"),
	);
}

const entries = files.map((f) => {
	const base = f.slice(0, -3);
	return { base, ident: `m${base}` };
});
await writeFile(
	path.join(PAYLOAD_MIGRATIONS_DIR, "index.ts"),
	`// Migrations of the payload schema in order. Written by
// src/create-migration.ts (Payload's own index has imports without the .ts
// extension that Node type stripping needs).
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";
${entries.map((e) => `import * as ${e.ident} from "./${e.base}.ts";`).join("\n")}

export interface PayloadMigration {
	name: string;
	up: (args: MigrateUpArgs) => Promise<void>;
	down: (args: MigrateDownArgs) => Promise<void>;
}

export const migrations: PayloadMigration[] = [
${entries
	.map(
		(e) =>
			`\t{\n\t\tup: ${e.ident}.up,\n\t\tdown: ${e.ident}.down,\n\t\tname: "${e.base}",\n\t},`,
	)
	.join("\n")}
];
`,
);
console.log(
	`created ${latest}; format it with \`pnpm exec biome check --write\``,
);
process.exit(0);
