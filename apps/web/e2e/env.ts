// Addresses and credentials of the E2E stack (deploy/compose/e2e.env).
// Overridable for a stack on other ports.
export const APP = process.env.UMIAK_E2E_APP_URL ?? "http://localhost:14180";
export const KEYCLOAK =
	process.env.UMIAK_E2E_KEYCLOAK_URL ?? "http://localhost:18180";
/** Public API listener of the e2e backend (API keys). */
export const PUBLIC_API =
	process.env.UMIAK_E2E_PUBLIC_API_URL ?? "http://localhost:18080";
/** Test-only control listener of the e2e backend. */
export const CONTROL =
	process.env.UMIAK_E2E_CONTROL_URL ?? "http://localhost:19099";
export const KEYCLOAK_ADMIN = process.env.KEYCLOAK_ADMIN ?? "admin";
export const KEYCLOAK_ADMIN_PASSWORD =
	process.env.KEYCLOAK_ADMIN_PASSWORD ?? "e2e-keycloak-admin";
/** 100 MiB with UMIAK_E2E_LARGE=1, else 70 MiB (above the 64 MiB single-PUT limit). */
export const UPLOAD_MIB = process.env.UMIAK_E2E_LARGE === "1" ? 100 : 70;
