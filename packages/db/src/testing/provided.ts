// Values passed from global-setup.ts to test workers through vitest provide/inject.
declare module "vitest" {
	export interface ProvidedContext {
		/** Admin DSN of the test Postgres; empty when unavailable or skipped. */
		sbxPgAdminDsn: string;
		/** Why Postgres is unavailable; empty when it is available or skipped. */
		sbxPgError: string;
	}
}

export {};
