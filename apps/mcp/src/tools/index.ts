// Every tool of the server in the order tools/list publishes (S11 8.1-8.7).
// Each toolset task appends its tools in the order of the spec.
import type { ToolDef } from "../registry.ts";
import { CATALOG_TOOLS } from "./catalog.ts";
import { SANDBOX_TOOLS } from "./sandboxes.ts";

export { CATALOG_TOOLS } from "./catalog.ts";
export {
	sandboxView,
	waitSandbox,
} from "./sandbox-view.ts";
export { SANDBOX_TOOLS } from "./sandboxes.ts";

export const ALL_TOOLS: readonly ToolDef[] = [
	...CATALOG_TOOLS,
	...SANDBOX_TOOLS,
];
