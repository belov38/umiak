// The value agent-harness-global.ts provides to the test workers.
declare module "vitest" {
	export interface ProvidedContext {
		/** Path of the built harness; `skip` says why it is not ("" when built). */
		umiakAgentHarness: { bin: string; skip: string };
	}
}

export {};
