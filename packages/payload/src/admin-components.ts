// Admin components of apps/web, referenced by import-map path (relative to
// the import map baseDir, the apps/web directory). Strings only: api and
// worker load the same config without React.

/**
 * JSON fields as a plain textarea. Payload's own JSON editor (Monaco) loads
 * its code from cdn.jsdelivr.net, which the CSP of web blocks (S8 §5.6, §19:
 * nothing from a CDN).
 */
export const JSON_FIELD_COMPONENT =
	"/src/components/admin/json-field#JsonField";

export const jsonFieldAdmin = {
	components: { Field: JSON_FIELD_COMPONENT },
} as const;
