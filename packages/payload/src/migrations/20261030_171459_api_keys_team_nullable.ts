// api-keys.team becomes nullable (expand only): deleting a team keeps its
// revoked keys for audit, the foreign key sets team_id to NULL (S8 §6.4).
// Required on create stays a field validation.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
   ALTER TABLE "payload"."api_keys" ALTER COLUMN "team_id" DROP NOT NULL;`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`
   ALTER TABLE "payload"."api_keys" ALTER COLUMN "team_id" SET NOT NULL;`);
}
