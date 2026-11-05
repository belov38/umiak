-- Source fixture derived from Payload initial SQL at 21c0e169, with the
-- owner-only/desktop/nullable-key schema changes applied. This is a synthetic
-- source-schema fixture, not a dump of the published image or live stand.
CREATE SCHEMA payload;
CREATE TYPE payload.enum_users_deactivated_reason AS ENUM ('operator');
CREATE TYPE payload.enum_memberships_role AS ENUM ('owner','member');
CREATE TYPE payload.enum_api_keys_kind AS ENUM ('team','sandbox');
CREATE TYPE payload.enum_api_keys_created_via AS ENUM ('api','cli','dashboard');
CREATE TYPE payload.enum_templates_os AS ENUM ('linux','windows');
CREATE TYPE payload.enum_platform_defaults_sso_port_policy AS ENUM ('any','team');
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
ALTER TABLE payload.api_keys ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE payload.platform_defaults DROP COLUMN sso_port_policy, DROP COLUMN sso_policy_epoch;
ALTER TABLE payload.platform_defaults ADD COLUMN public_desktop_enabled boolean DEFAULT false;
