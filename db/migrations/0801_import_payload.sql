-- S24 cutover is incompatible with image-only rollback: declare dbCompatible=false.
-- Explicit mappings preserve source IDs, hashes, nulls and operator edits.
DO $import$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='payload') THEN
  IF to_regclass('payload.users') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing users); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.teams') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing teams); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.memberships') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing memberships); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.api_keys') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing api_keys); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.ssh_keys') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing ssh_keys); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.templates') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing templates); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.sizes') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing sizes); restore/upgrade the source release first'; END IF;
  IF to_regclass('payload.platform_defaults') IS NULL THEN RAISE EXCEPTION 'S24: incomplete Payload schema (missing platform_defaults); restore/upgrade the source release first'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='payload' AND table_name='platform_defaults' AND column_name='sso_port_policy') THEN
   RAISE EXCEPTION 'S24: source is older than owner-only migration; update source first';
  END IF;
  IF (SELECT count(*) FROM payload.platform_defaults) <> 1 THEN RAISE EXCEPTION 'S24: expected exactly one source platform-defaults row'; END IF;
  LOCK TABLE payload.users, payload.teams, payload.memberships, payload.api_keys, payload.ssh_keys, payload.templates, payload.sizes, payload.platform_defaults IN SHARE MODE;
  INSERT INTO runtime.users (id, email, name, idp_subject, preferred_username, groups, is_operator, active, deactivated_reason, deactivated_at, default_team_id, personal_team_id, last_login_at, updated_at, created_at) SELECT id, email, name, idp_subject, preferred_username, groups, COALESCE(is_operator, false), COALESCE(active, true), deactivated_reason::text, deactivated_at, default_team_id, personal_team_id, last_login_at, updated_at, created_at FROM payload.users;
  IF (SELECT count(*) FROM runtime.users) <> (SELECT count(*) FROM payload.users) THEN RAISE EXCEPTION 'S24: users import count mismatch'; END IF;
  INSERT INTO runtime.teams (id, name, personal, created_by_id, quota_max_active_sandboxes, quota_max_ram_mb, quota_max_saved_snapshots, updated_at, created_at) SELECT id, name, personal, created_by_id, quota_max_active_sandboxes, quota_max_ram_mb, quota_max_saved_snapshots, updated_at, created_at FROM payload.teams;
  IF (SELECT count(*) FROM runtime.teams) <> (SELECT count(*) FROM payload.teams) THEN RAISE EXCEPTION 'S24: teams import count mismatch'; END IF;
  INSERT INTO runtime.memberships (id, user_id, team_id, role, invited_by_id, updated_at, created_at) SELECT id, user_id, team_id, role::text, invited_by_id, updated_at, created_at FROM payload.memberships;
  IF (SELECT count(*) FROM runtime.memberships) <> (SELECT count(*) FROM payload.memberships) THEN RAISE EXCEPTION 'S24: memberships import count mismatch'; END IF;
  INSERT INTO runtime.api_keys (id, name, team_id, created_by_id, kind, sandbox, secret_hash, prefix, last4, scopes, expires_at, created_via, last_used_at, rotated_at, revoked_at, revoked_by_id, revoked_by_key_id, updated_at, created_at) SELECT id, name, team_id, created_by_id, kind::text, sandbox, secret_hash, prefix, last4, scopes, expires_at, created_via::text, last_used_at, rotated_at, revoked_at, revoked_by_id, revoked_by_key_id, updated_at, created_at FROM payload.api_keys;
  IF (SELECT count(*) FROM runtime.api_keys) <> (SELECT count(*) FROM payload.api_keys) THEN RAISE EXCEPTION 'S24: api_keys import count mismatch'; END IF;
  INSERT INTO runtime.ssh_keys (id, user_id, name, public_key, fingerprint, type, last_used_at, updated_at, created_at) SELECT id, user_id, name, public_key, fingerprint, type, last_used_at, updated_at, created_at FROM payload.ssh_keys;
  IF (SELECT count(*) FROM runtime.ssh_keys) <> (SELECT count(*) FROM payload.ssh_keys) THEN RAISE EXCEPTION 'S24: ssh_keys import count mismatch'; END IF;
  INSERT INTO runtime.templates (id, slug, name, description, os, enabled, default_size, allowed_sizes, login_user, capabilities, sort_order, updated_at, created_at) SELECT id, slug, name, description, os::text, enabled, default_size, allowed_sizes, login_user, capabilities, sort_order, updated_at, created_at FROM payload.templates;
  IF (SELECT count(*) FROM runtime.templates) <> (SELECT count(*) FROM payload.templates) THEN RAISE EXCEPTION 'S24: templates import count mismatch'; END IF;
  INSERT INTO runtime.sizes (id, slug, vcpu, memory_mb, sort_order, updated_at, created_at) SELECT id, slug, vcpu, memory_mb, sort_order, updated_at, created_at FROM payload.sizes;
  IF (SELECT count(*) FROM runtime.sizes) <> (SELECT count(*) FROM payload.sizes) THEN RAISE EXCEPTION 'S24: sizes import count mismatch'; END IF;
  INSERT INTO runtime.platform_defaults (id, ttl_seconds, max_ttl_seconds, idle_timeout_seconds, stopped_retention_days, error_retention_days, recover_min_interval_seconds, default_template, public_ports_enabled, rate_limits_requests_per_second, rate_limits_burst, rate_limits_starts_per_minute, default_quota_max_active_sandboxes, default_quota_max_ram_mb, default_quota_max_saved_snapshots, new_shared_team_quota_max_active_sandboxes, new_shared_team_quota_max_ram_mb, new_shared_team_quota_max_saved_snapshots, max_owned_teams_per_user, updated_at, created_at, public_desktop_enabled) SELECT id, ttl_seconds, max_ttl_seconds, idle_timeout_seconds, stopped_retention_days, error_retention_days, recover_min_interval_seconds, default_template, public_ports_enabled, rate_limits_requests_per_second, rate_limits_burst, rate_limits_starts_per_minute, default_quota_max_active_sandboxes, default_quota_max_ram_mb, default_quota_max_saved_snapshots, new_shared_team_quota_max_active_sandboxes, new_shared_team_quota_max_ram_mb, new_shared_team_quota_max_saved_snapshots, max_owned_teams_per_user, updated_at, created_at, public_desktop_enabled FROM payload.platform_defaults;
  IF (SELECT count(*) FROM runtime.platform_defaults) <> (SELECT count(*) FROM payload.platform_defaults) THEN RAISE EXCEPTION 'S24: platform_defaults import count mismatch'; END IF;
 ELSE
  INSERT INTO runtime.platform_defaults(id,ttl_seconds,max_ttl_seconds,idle_timeout_seconds,stopped_retention_days,error_retention_days,recover_min_interval_seconds,default_template,public_ports_enabled,public_desktop_enabled,rate_limits_requests_per_second,rate_limits_burst,rate_limits_starts_per_minute,default_quota_max_active_sandboxes,default_quota_max_ram_mb,default_quota_max_saved_snapshots,new_shared_team_quota_max_active_sandboxes,new_shared_team_quota_max_ram_mb,new_shared_team_quota_max_saved_snapshots,max_owned_teams_per_user)
   VALUES(uuidv7(),NULL,604800,900,1,1,600,'linux',true,false,20,100,30,10000,8192,10,10000,8192,10,3);
  INSERT INTO runtime.sizes(slug,vcpu,memory_mb,sort_order) VALUES('2gb',2,2048,0),('4gb',4,4096,1),('8gb',8,8192,2);
  INSERT INTO runtime.templates(slug,name,os,enabled,default_size,allowed_sizes,login_user,capabilities,sort_order) VALUES
   ('linux','Ubuntu 26.04','linux',true,'2gb','["2gb"]','user','["exec","files","ssh"]',0),
   ('windows','Windows 11','windows',true,'4gb','["4gb","8gb"]','user','["exec","files","ssh","desktop"]',1),
   ('linux-desktop','Linux Desktop','linux',true,'4gb','["4gb","8gb"]','user','["exec","files","ssh","desktop"]',2);
 END IF;
END $import$;
