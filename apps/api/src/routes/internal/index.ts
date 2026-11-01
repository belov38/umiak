// Internal listener endpoints (S7 §12.1): the gateway's route lookup, SSH
// authorization, port SSO code exchange (S4 §6.1, §9.2, §8.4) and the agent
// events intake (S2 §9.6). Not in the public OpenAPI document. Errors carry
// `code` at the top level too (the gateway reads it).
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { registerAgentEventRoutes } from "./agent-events.ts";
import { registerDesktopInternalRoutes } from "./desktop.ts";
import { registerPortAuthRoutes } from "./port-auth.ts";
import { registerGatewayRouteRoutes } from "./routes.ts";
import { registerSshAuthorizeRoutes } from "./ssh-authorize.ts";

export function registerInternalRoutes(app: ApiApp, deps: ApiDeps): void {
	registerGatewayRouteRoutes(app, deps);
	registerDesktopInternalRoutes(app, deps);
	registerSshAuthorizeRoutes(app, deps);
	registerPortAuthRoutes(app, deps);
	registerAgentEventRoutes(app, deps);
}
