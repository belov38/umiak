import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`
   DELETE FROM "payload"."payload_locked_documents_rels" WHERE "team_notices_id" IS NOT NULL;
  ALTER TABLE "payload"."payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_team_notices_fk";

  DROP INDEX "payload"."payload_locked_documents_rels_team_notices_id_idx";
  ALTER TABLE "payload"."payload_locked_documents_rels" DROP COLUMN "team_notices_id";
  DROP TABLE "payload"."team_notices";
  DROP TYPE "payload"."enum_team_notices_kind";`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`
   CREATE TYPE "payload"."enum_team_notices_kind" AS ENUM('member_deactivated');
  CREATE TABLE "payload"."team_notices" (
    "id" uuid PRIMARY KEY NOT NULL,
    "team_id" uuid NOT NULL,
    "kind" "payload"."enum_team_notices_kind" NOT NULL,
    "user_id" uuid,
    "api_keys" jsonb,
    "acknowledged_by_id" uuid,
    "acknowledged_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  ALTER TABLE "payload"."payload_locked_documents_rels" ADD COLUMN "team_notices_id" uuid;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "team_notices_team_idx" ON "payload"."team_notices" USING btree ("team_id");
  CREATE INDEX "team_notices_user_idx" ON "payload"."team_notices" USING btree ("user_id");
  CREATE INDEX "team_notices_acknowledged_by_idx" ON "payload"."team_notices" USING btree ("acknowledged_by_id");
  CREATE INDEX "team_notices_updated_at_idx" ON "payload"."team_notices" USING btree ("updated_at");
  CREATE INDEX "team_notices_created_at_idx" ON "payload"."team_notices" USING btree ("created_at");
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_team_notices_fk" FOREIGN KEY ("team_notices_id") REFERENCES "payload"."team_notices"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_team_notices_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("team_notices_id");`);
}
