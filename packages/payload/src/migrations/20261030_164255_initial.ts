// Initial migration of the payload schema (S8 §7, §12). The DDL is generated
// by Payload (createMigration); the schema creation, the seeds and the copy of
// the S7 identity stand-in (S8 plan, decision 1) are written by hand.
import {
	type MigrateDownArgs,
	type MigrateUpArgs,
	sql,
} from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
	await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "payload"`);
	await db.execute(sql`
   CREATE TYPE "payload"."enum_users_deactivated_reason" AS ENUM('operator', 'idp_disabled', 'idp_deleted');
  CREATE TYPE "payload"."enum_memberships_role" AS ENUM('owner', 'member');
  CREATE TYPE "payload"."enum_api_keys_kind" AS ENUM('team', 'sandbox');
  CREATE TYPE "payload"."enum_api_keys_created_via" AS ENUM('api', 'cli', 'dashboard');
  CREATE TYPE "payload"."enum_team_notices_kind" AS ENUM('member_deactivated');
  CREATE TYPE "payload"."enum_templates_os" AS ENUM('linux', 'windows');
  CREATE TYPE "payload"."enum_platform_defaults_sso_port_policy" AS ENUM('any', 'team');
  CREATE TABLE "payload"."users" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"email" varchar NOT NULL,
  	"name" varchar,
  	"idp_subject" varchar,
  	"preferred_username" varchar,
  	"groups" jsonb,
  	"is_operator" boolean DEFAULT false,
  	"active" boolean DEFAULT true,
  	"deactivated_reason" "payload"."enum_users_deactivated_reason",
  	"deactivated_at" timestamp(3) with time zone,
  	"default_team_id" uuid,
  	"personal_team_id" uuid,
  	"last_login_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."teams" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"personal" boolean DEFAULT false,
  	"created_by_id" uuid,
  	"quota_max_active_sandboxes" numeric,
  	"quota_max_ram_mb" numeric,
  	"quota_max_saved_snapshots" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."memberships" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"user_id" uuid NOT NULL,
  	"team_id" uuid NOT NULL,
  	"role" "payload"."enum_memberships_role" DEFAULT 'member' NOT NULL,
  	"invited_by_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."api_keys" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"team_id" uuid NOT NULL,
  	"created_by_id" uuid,
  	"kind" "payload"."enum_api_keys_kind" DEFAULT 'team' NOT NULL,
  	"sandbox" varchar,
  	"secret_hash" varchar NOT NULL,
  	"prefix" varchar NOT NULL,
  	"last4" varchar NOT NULL,
  	"scopes" jsonb NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"created_via" "payload"."enum_api_keys_created_via" NOT NULL,
  	"last_used_at" timestamp(3) with time zone,
  	"rotated_at" timestamp(3) with time zone,
  	"revoked_at" timestamp(3) with time zone,
  	"revoked_by_id" uuid,
  	"revoked_by_key_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
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
  
  CREATE TABLE "payload"."ssh_keys" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"user_id" uuid NOT NULL,
  	"name" varchar NOT NULL,
  	"public_key" varchar NOT NULL,
  	"fingerprint" varchar NOT NULL,
  	"type" varchar NOT NULL,
  	"last_used_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."templates" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"slug" varchar NOT NULL,
  	"name" varchar,
  	"description" varchar,
  	"os" "payload"."enum_templates_os" NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"default_size" varchar NOT NULL,
  	"allowed_sizes" jsonb NOT NULL,
  	"login_user" varchar DEFAULT 'user',
  	"capabilities" jsonb,
  	"sort_order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."sizes" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"slug" varchar NOT NULL,
  	"vcpu" numeric NOT NULL,
  	"memory_mb" numeric NOT NULL,
  	"sort_order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."pool_targets" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"template" varchar NOT NULL,
  	"size" varchar NOT NULL,
  	"provider_id" varchar,
  	"target" numeric NOT NULL,
  	"max_age_hours" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."payload_kv" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload"."payload_locked_documents" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" uuid,
  	"teams_id" uuid,
  	"memberships_id" uuid,
  	"api_keys_id" uuid,
  	"team_notices_id" uuid,
  	"ssh_keys_id" uuid,
  	"templates_id" uuid,
  	"sizes_id" uuid,
  	"pool_targets_id" uuid
  );
  
  CREATE TABLE "payload"."payload_preferences" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" uuid
  );
  
  CREATE TABLE "payload"."payload_migrations" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload"."platform_defaults" (
  	"id" uuid PRIMARY KEY NOT NULL,
  	"ttl_seconds" numeric,
  	"max_ttl_seconds" numeric DEFAULT 604800 NOT NULL,
  	"idle_timeout_seconds" numeric DEFAULT 900,
  	"stopped_retention_days" numeric,
  	"error_retention_days" numeric DEFAULT 7 NOT NULL,
  	"recover_min_interval_seconds" numeric DEFAULT 600 NOT NULL,
  	"default_template" varchar DEFAULT 'linux' NOT NULL,
  	"public_ports_enabled" boolean DEFAULT true,
  	"sso_port_policy" "payload"."enum_platform_defaults_sso_port_policy" DEFAULT 'any' NOT NULL,
  	"rate_limits_requests_per_second" numeric DEFAULT 20,
  	"rate_limits_burst" numeric DEFAULT 100,
  	"rate_limits_starts_per_minute" numeric DEFAULT 30,
  	"default_quota_max_active_sandboxes" numeric,
  	"default_quota_max_ram_mb" numeric,
  	"default_quota_max_saved_snapshots" numeric,
  	"new_shared_team_quota_max_active_sandboxes" numeric,
  	"new_shared_team_quota_max_ram_mb" numeric,
  	"new_shared_team_quota_max_saved_snapshots" numeric,
  	"max_owned_teams_per_user" numeric DEFAULT 3,
  	"sso_policy_epoch" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "payload"."users" ADD CONSTRAINT "users_default_team_id_teams_id_fk" FOREIGN KEY ("default_team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."users" ADD CONSTRAINT "users_personal_team_id_teams_id_fk" FOREIGN KEY ("personal_team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."teams" ADD CONSTRAINT "teams_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."memberships" ADD CONSTRAINT "memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."memberships" ADD CONSTRAINT "memberships_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."api_keys" ADD CONSTRAINT "api_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."api_keys" ADD CONSTRAINT "api_keys_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."api_keys" ADD CONSTRAINT "api_keys_revoked_by_key_id_api_keys_id_fk" FOREIGN KEY ("revoked_by_key_id") REFERENCES "payload"."api_keys"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "payload"."teams"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."team_notices" ADD CONSTRAINT "team_notices_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "payload"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "payload"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_teams_fk" FOREIGN KEY ("teams_id") REFERENCES "payload"."teams"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_memberships_fk" FOREIGN KEY ("memberships_id") REFERENCES "payload"."memberships"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_api_keys_fk" FOREIGN KEY ("api_keys_id") REFERENCES "payload"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_team_notices_fk" FOREIGN KEY ("team_notices_id") REFERENCES "payload"."team_notices"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ssh_keys_fk" FOREIGN KEY ("ssh_keys_id") REFERENCES "payload"."ssh_keys"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_templates_fk" FOREIGN KEY ("templates_id") REFERENCES "payload"."templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sizes_fk" FOREIGN KEY ("sizes_id") REFERENCES "payload"."sizes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_pool_targets_fk" FOREIGN KEY ("pool_targets_id") REFERENCES "payload"."pool_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "payload"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "payload"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "users_email_idx" ON "payload"."users" USING btree ("email");
  CREATE UNIQUE INDEX "users_idp_subject_idx" ON "payload"."users" USING btree ("idp_subject");
  CREATE INDEX "users_default_team_idx" ON "payload"."users" USING btree ("default_team_id");
  CREATE INDEX "users_personal_team_idx" ON "payload"."users" USING btree ("personal_team_id");
  CREATE INDEX "users_updated_at_idx" ON "payload"."users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "payload"."users" USING btree ("created_at");
  CREATE INDEX "teams_created_by_idx" ON "payload"."teams" USING btree ("created_by_id");
  CREATE INDEX "teams_updated_at_idx" ON "payload"."teams" USING btree ("updated_at");
  CREATE INDEX "teams_created_at_idx" ON "payload"."teams" USING btree ("created_at");
  CREATE INDEX "memberships_user_idx" ON "payload"."memberships" USING btree ("user_id");
  CREATE INDEX "memberships_team_idx" ON "payload"."memberships" USING btree ("team_id");
  CREATE INDEX "memberships_invited_by_idx" ON "payload"."memberships" USING btree ("invited_by_id");
  CREATE INDEX "memberships_updated_at_idx" ON "payload"."memberships" USING btree ("updated_at");
  CREATE INDEX "memberships_created_at_idx" ON "payload"."memberships" USING btree ("created_at");
  CREATE UNIQUE INDEX "user_team_idx" ON "payload"."memberships" USING btree ("user_id","team_id");
  CREATE INDEX "api_keys_team_idx" ON "payload"."api_keys" USING btree ("team_id");
  CREATE INDEX "api_keys_created_by_idx" ON "payload"."api_keys" USING btree ("created_by_id");
  CREATE UNIQUE INDEX "api_keys_secret_hash_idx" ON "payload"."api_keys" USING btree ("secret_hash");
  CREATE INDEX "api_keys_revoked_by_idx" ON "payload"."api_keys" USING btree ("revoked_by_id");
  CREATE INDEX "api_keys_revoked_by_key_idx" ON "payload"."api_keys" USING btree ("revoked_by_key_id");
  CREATE INDEX "api_keys_updated_at_idx" ON "payload"."api_keys" USING btree ("updated_at");
  CREATE INDEX "api_keys_created_at_idx" ON "payload"."api_keys" USING btree ("created_at");
  CREATE INDEX "team_notices_team_idx" ON "payload"."team_notices" USING btree ("team_id");
  CREATE INDEX "team_notices_user_idx" ON "payload"."team_notices" USING btree ("user_id");
  CREATE INDEX "team_notices_acknowledged_by_idx" ON "payload"."team_notices" USING btree ("acknowledged_by_id");
  CREATE INDEX "team_notices_updated_at_idx" ON "payload"."team_notices" USING btree ("updated_at");
  CREATE INDEX "team_notices_created_at_idx" ON "payload"."team_notices" USING btree ("created_at");
  CREATE INDEX "ssh_keys_user_idx" ON "payload"."ssh_keys" USING btree ("user_id");
  CREATE UNIQUE INDEX "ssh_keys_fingerprint_idx" ON "payload"."ssh_keys" USING btree ("fingerprint");
  CREATE INDEX "ssh_keys_updated_at_idx" ON "payload"."ssh_keys" USING btree ("updated_at");
  CREATE INDEX "ssh_keys_created_at_idx" ON "payload"."ssh_keys" USING btree ("created_at");
  CREATE UNIQUE INDEX "templates_slug_idx" ON "payload"."templates" USING btree ("slug");
  CREATE INDEX "templates_updated_at_idx" ON "payload"."templates" USING btree ("updated_at");
  CREATE INDEX "templates_created_at_idx" ON "payload"."templates" USING btree ("created_at");
  CREATE UNIQUE INDEX "sizes_slug_idx" ON "payload"."sizes" USING btree ("slug");
  CREATE INDEX "sizes_updated_at_idx" ON "payload"."sizes" USING btree ("updated_at");
  CREATE INDEX "sizes_created_at_idx" ON "payload"."sizes" USING btree ("created_at");
  CREATE INDEX "pool_targets_updated_at_idx" ON "payload"."pool_targets" USING btree ("updated_at");
  CREATE INDEX "pool_targets_created_at_idx" ON "payload"."pool_targets" USING btree ("created_at");
  CREATE UNIQUE INDEX "template_size_providerId_idx" ON "payload"."pool_targets" USING btree ("template","size","provider_id");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload"."payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload"."payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload"."payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload"."payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload"."payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload"."payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload"."payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_teams_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("teams_id");
  CREATE INDEX "payload_locked_documents_rels_memberships_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("memberships_id");
  CREATE INDEX "payload_locked_documents_rels_api_keys_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("api_keys_id");
  CREATE INDEX "payload_locked_documents_rels_team_notices_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("team_notices_id");
  CREATE INDEX "payload_locked_documents_rels_ssh_keys_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("ssh_keys_id");
  CREATE INDEX "payload_locked_documents_rels_templates_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("templates_id");
  CREATE INDEX "payload_locked_documents_rels_sizes_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("sizes_id");
  CREATE INDEX "payload_locked_documents_rels_pool_targets_id_idx" ON "payload"."payload_locked_documents_rels" USING btree ("pool_targets_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload"."payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload"."payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload"."payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload"."payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload"."payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload"."payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload"."payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload"."payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload"."payload_migrations" USING btree ("created_at");`);
	await db.execute(SEED);
	await db.execute(COPY_IDENTITY);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
	await db.execute(sql`
   DROP TABLE "payload"."users" CASCADE;
  DROP TABLE "payload"."teams" CASCADE;
  DROP TABLE "payload"."memberships" CASCADE;
  DROP TABLE "payload"."api_keys" CASCADE;
  DROP TABLE "payload"."team_notices" CASCADE;
  DROP TABLE "payload"."ssh_keys" CASCADE;
  DROP TABLE "payload"."templates" CASCADE;
  DROP TABLE "payload"."sizes" CASCADE;
  DROP TABLE "payload"."pool_targets" CASCADE;
  DROP TABLE "payload"."payload_kv" CASCADE;
  DROP TABLE "payload"."payload_locked_documents" CASCADE;
  DROP TABLE "payload"."payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload"."payload_preferences" CASCADE;
  DROP TABLE "payload"."payload_preferences_rels" CASCADE;
  DROP TABLE "payload"."payload_migrations" CASCADE;
  DROP TABLE "payload"."platform_defaults" CASCADE;
  DROP TYPE "payload"."enum_users_deactivated_reason";
  DROP TYPE "payload"."enum_memberships_role";
  DROP TYPE "payload"."enum_api_keys_kind";
  DROP TYPE "payload"."enum_api_keys_created_via";
  DROP TYPE "payload"."enum_team_notices_kind";
  DROP TYPE "payload"."enum_templates_os";
  DROP TYPE "payload"."enum_platform_defaults_sso_port_policy";`);
}

// Defaults of S6 §5.11 (StaticConfigReader), S7 and S8 §7, and the PoC
// template, size and pool target (S6 §9.1). Ids are UUIDv7 (Postgres 18).
const SEED = sql`
  INSERT INTO "payload"."platform_defaults" (
    "id", "ttl_seconds", "max_ttl_seconds", "idle_timeout_seconds",
    "stopped_retention_days", "error_retention_days", "recover_min_interval_seconds",
    "default_template", "public_ports_enabled", "sso_port_policy",
    "rate_limits_requests_per_second", "rate_limits_burst", "rate_limits_starts_per_minute",
    "default_quota_max_active_sandboxes", "default_quota_max_ram_mb", "default_quota_max_saved_snapshots",
    "new_shared_team_quota_max_active_sandboxes", "new_shared_team_quota_max_ram_mb",
    "new_shared_team_quota_max_saved_snapshots",
    "max_owned_teams_per_user", "sso_policy_epoch", "updated_at", "created_at"
  ) VALUES (
    uuidv7(), NULL, 604800, 900,
    NULL, 7, 600,
    'linux', true, 'any',
    20, 100, 30,
    3, 6144, 10,
    3, 6144,
    10,
    3, 0, now(), now()
  );
  INSERT INTO "payload"."sizes" ("id", "slug", "vcpu", "memory_mb", "sort_order")
  VALUES (uuidv7(), '2gb', 2, 2048, 0);
  INSERT INTO "payload"."templates" (
    "id", "slug", "name", "os", "enabled", "default_size", "allowed_sizes",
    "login_user", "capabilities", "sort_order"
  ) VALUES (
    uuidv7(), 'linux', 'linux', 'linux', true, '2gb', '["2gb"]',
    'user', '["exec", "files", "ssh"]', 0
  );
  INSERT INTO "payload"."pool_targets" ("id", "template", "size", "target")
  VALUES (uuidv7(), 'linux', '2gb', 1);`;

// Copy of the S7 identity stand-in (db/migrations/0300, 0303) with the same
// UUIDs, when it exists. The identity schema stays in place (contract phase
// in a later release). Order follows the foreign keys: teams, users, the
// creator of personal teams, memberships (new ids), api keys, ssh keys.
// A user with an IdP subject has logged in: lastLoginAt = createdAt, so it is
// not taken for a stub (S8 §6.3).
const COPY_IDENTITY = sql`
DO $$
BEGIN
  IF to_regclass('identity.users') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "payload"."teams" ("id", "name", "personal", "created_at", "updated_at")
  SELECT t.id, t.name, t.personal, t.created_at, t.created_at
  FROM identity.teams t
  ON CONFLICT DO NOTHING;

  INSERT INTO "payload"."users" (
    "id", "email", "name", "idp_subject", "is_operator", "active",
    "default_team_id", "personal_team_id", "last_login_at", "created_at", "updated_at"
  )
  SELECT u.id, u.email, u.name, u.idp_subject, u.is_operator, u.active,
    u.default_team_id,
    (SELECT t.id FROM identity.memberships m JOIN identity.teams t ON t.id = m.team_id
     WHERE m.user_id = u.id AND m.role = 'owner' AND t.personal
     ORDER BY t.created_at LIMIT 1),
    CASE WHEN u.idp_subject IS NOT NULL THEN u.created_at END,
    u.created_at, u.created_at
  FROM identity.users u
  ON CONFLICT DO NOTHING;

  UPDATE "payload"."teams" p SET "created_by_id" = (
    SELECT m.user_id FROM identity.memberships m
    WHERE m.team_id = p.id AND m.role = 'owner'
    ORDER BY m.created_at LIMIT 1)
  WHERE p.personal AND p.created_by_id IS NULL
    AND EXISTS (SELECT 1 FROM identity.teams t WHERE t.id = p.id);

  INSERT INTO "payload"."memberships" ("id", "user_id", "team_id", "role", "created_at", "updated_at")
  SELECT uuidv7(), m.user_id, m.team_id, m.role::"payload"."enum_memberships_role",
    m.created_at, m.created_at
  FROM identity.memberships m
  ON CONFLICT DO NOTHING;

  INSERT INTO "payload"."api_keys" (
    "id", "name", "team_id", "created_by_id", "kind", "sandbox", "secret_hash",
    "prefix", "last4", "scopes", "expires_at", "created_via", "last_used_at",
    "revoked_at", "revoked_by_id", "revoked_by_key_id", "created_at", "updated_at"
  )
  SELECT k.id, k.name, k.team_id, k.created_by, k.kind::"payload"."enum_api_keys_kind",
    k.sandbox_id::text, k.secret_hash, k.prefix, k.last4, to_jsonb(k.scopes),
    k.expires_at, k.created_via::"payload"."enum_api_keys_created_via", k.last_used_at,
    k.revoked_at, k.revoked_by, k.revoked_by_key, k.created_at, k.created_at
  FROM identity.api_keys k
  ON CONFLICT DO NOTHING;

  -- rotated_at comes with 0303; the runners of the two schemas run in any order.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'identity' AND table_name = 'api_keys'
               AND column_name = 'rotated_at') THEN
    EXECUTE 'UPDATE "payload"."api_keys" p SET "rotated_at" = k.rotated_at
             FROM identity.api_keys k WHERE k.id = p.id AND k.rotated_at IS NOT NULL';
  END IF;

  INSERT INTO "payload"."ssh_keys" (
    "id", "user_id", "name", "public_key", "fingerprint", "type",
    "last_used_at", "created_at", "updated_at"
  )
  SELECT s.id, s.user_id, s.name, s.public_key, s.fingerprint, s.type,
    s.last_used_at, s.created_at, s.created_at
  FROM identity.ssh_keys s
  ON CONFLICT DO NOTHING;
END
$$;`;
