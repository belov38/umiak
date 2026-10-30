// Every tool of the server in the order tools/list publishes (S11 8.1-8.7).
// Each toolset task appends its tools in the order of the spec.
import type { ToolDef } from "../registry.ts";
import { CATALOG_TOOLS } from "./catalog.ts";
import { COMMAND_TOOLS } from "./commands.ts";
import { FILE_TOOLS } from "./files.ts";
import { PORT_TOOLS } from "./ports.ts";
import { SANDBOX_TOOLS } from "./sandboxes.ts";
import { SNAPSHOT_TOOLS } from "./snapshots.ts";

export { CATALOG_TOOLS } from "./catalog.ts";
export { COMMAND_TOOLS } from "./commands.ts";
export { FILE_TOOLS } from "./files.ts";
export { PORT_TOOLS } from "./ports.ts";
export {
	sandboxView,
	waitSandbox,
} from "./sandbox-view.ts";
export { SANDBOX_TOOLS } from "./sandboxes.ts";
export { SNAPSHOT_TOOLS } from "./snapshots.ts";

export const ALL_TOOLS: readonly ToolDef[] = [
	...CATALOG_TOOLS,
	...SANDBOX_TOOLS,
	...COMMAND_TOOLS,
	...FILE_TOOLS,
	...PORT_TOOLS,
	...SNAPSHOT_TOOLS,
];
