-- Translate the pending post-.3 Debian deferral without touching other edits.
DELETE FROM runtime.pool_targets WHERE template='debian';
UPDATE runtime.platform_defaults SET default_template='linux' WHERE default_template='debian';
DELETE FROM runtime.templates WHERE slug='debian';
UPDATE runtime.template_builds SET status='retired' WHERE template_slug='debian' AND status IN ('building','active','deprecated');
