-- S24: API-owned configuration. The old Payload schema remains unused.
CREATE TABLE runtime."users" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"email" text NOT NULL,
  	"name" text,
  	"idp_subject" text,
  	"preferred_username" text,
  	"groups" jsonb,
  	"is_operator" boolean DEFAULT false NOT NULL,
  	"active" boolean DEFAULT true NOT NULL,
  	"deactivated_reason" text,
  	"deactivated_at" timestamp(3) with time zone,
  	"default_team_id" uuid,
  	"personal_team_id" uuid,
  	"last_login_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."teams" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"name" text NOT NULL,
  	"personal" boolean DEFAULT false,
  	"created_by_id" uuid,
  	"quota_max_active_sandboxes" numeric,
  	"quota_max_ram_mb" numeric,
  	"quota_max_saved_snapshots" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."memberships" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"user_id" uuid NOT NULL,
  	"team_id" uuid NOT NULL,
  	"role" text DEFAULT 'member' NOT NULL,
  	"invited_by_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."api_keys" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"name" text NOT NULL,
  	"team_id" uuid,
  	"created_by_id" uuid,
  	"kind" text DEFAULT 'team' NOT NULL,
  	"sandbox" text,
  	"secret_hash" text NOT NULL,
  	"prefix" text NOT NULL,
  	"last4" text NOT NULL,
  	"scopes" jsonb NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"created_via" text NOT NULL,
  	"last_used_at" timestamp(3) with time zone,
  	"rotated_at" timestamp(3) with time zone,
  	"revoked_at" timestamp(3) with time zone,
  	"revoked_by_id" uuid,
  	"revoked_by_key_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."ssh_keys" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"user_id" uuid NOT NULL,
  	"name" text NOT NULL,
  	"public_key" text NOT NULL,
  	"fingerprint" text NOT NULL,
  	"type" text NOT NULL,
  	"last_used_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."templates" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"slug" text NOT NULL,
  	"name" text,
  	"description" text,
  	"os" text NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"default_size" text NOT NULL,
  	"allowed_sizes" jsonb NOT NULL,
  	"login_user" text DEFAULT 'user',
  	"capabilities" jsonb,
  	"sort_order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

CREATE TABLE runtime."sizes" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"slug" text NOT NULL,
  	"vcpu" numeric NOT NULL,
  	"memory_mb" numeric NOT NULL,
  	"sort_order" numeric DEFAULT 0,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );


CREATE TABLE runtime."platform_defaults" (
  	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  	"ttl_seconds" numeric,
  	"max_ttl_seconds" numeric DEFAULT 604800 NOT NULL,
  	"idle_timeout_seconds" numeric DEFAULT 900,
  	"stopped_retention_days" numeric,
  	"error_retention_days" numeric DEFAULT 7 NOT NULL,
  	"recover_min_interval_seconds" numeric DEFAULT 600 NOT NULL,
  	"default_template" text DEFAULT 'linux' NOT NULL,
  	"public_ports_enabled" boolean DEFAULT true,
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
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone,
  "public_desktop_enabled" boolean DEFAULT false
  );
ALTER TABLE runtime.users ADD FOREIGN KEY (default_team_id) REFERENCES runtime.teams(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.users ADD FOREIGN KEY (personal_team_id) REFERENCES runtime.teams(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.teams ADD FOREIGN KEY (created_by_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.memberships ADD FOREIGN KEY (user_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.memberships ADD FOREIGN KEY (team_id) REFERENCES runtime.teams(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.memberships ADD FOREIGN KEY (invited_by_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.api_keys ADD FOREIGN KEY (team_id) REFERENCES runtime.teams(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.api_keys ADD FOREIGN KEY (created_by_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.api_keys ADD FOREIGN KEY (revoked_by_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.api_keys ADD FOREIGN KEY (revoked_by_key_id) REFERENCES runtime.api_keys(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime.ssh_keys ADD FOREIGN KEY (user_id) REFERENCES runtime.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX users_email_idx ON runtime.users (email);
CREATE UNIQUE INDEX users_idp_subject_idx ON runtime.users (idp_subject);
CREATE UNIQUE INDEX api_keys_secret_hash_idx ON runtime.api_keys (secret_hash);
CREATE UNIQUE INDEX ssh_keys_fingerprint_idx ON runtime.ssh_keys (fingerprint);
CREATE UNIQUE INDEX templates_slug_idx ON runtime.templates (slug);
CREATE UNIQUE INDEX sizes_slug_idx ON runtime.sizes (slug);
CREATE UNIQUE INDEX memberships_pair_idx ON runtime.memberships(user_id,team_id);
CREATE UNIQUE INDEX platform_defaults_singleton_idx ON runtime.platform_defaults((true));
