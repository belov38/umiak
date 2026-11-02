// Client address for the request log (S7 §7.1): from `X-Forwarded-For` only
// when the connection comes from UMIAK_API_TRUSTED_PROXY_CIDRS (ingress,
// a TLS proxy on the host, via the Docker bridge, oauth2-proxy), else the
// address of the connection. Rate limits are per principal, not per address.
import type { IncomingMessage } from "node:http";
import type { TrustedProxies } from "@umiak/auth";

export { TrustedProxies } from "@umiak/auth";

import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";

/** Sets `clientIp` (undefined outside a real socket, e.g. `app.request`). */
export function clientIp(proxies: TrustedProxies): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const env = c.env as { incoming?: IncomingMessage } | undefined;
		const peer = env?.incoming?.socket?.remoteAddress;
		c.set("clientIp", proxies.clientOf(peer, c.req.header("x-forwarded-for")));
		await next();
	};
}
