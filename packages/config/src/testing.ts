// Test helpers of @sbx/config (export "./testing"). Imports vitest: never
// import this from production code.
export {
	type ConfigContractOptions,
	type ConfigFixture,
	type ConfigReaderSubject,
	makeConfigFixture,
	runConfigReaderContract,
} from "../test/contract.ts";
