// HEAD requests run the GET handler (Hono routes HEAD as GET) and Hono then
// answers `new Response(null, res)` without cancelling the handler's body.
// A streamed body (an agent download, an NDJSON stream) would keep running
// and hold its resources, so it is cancelled here: the cancel reaches the
// source (agent fetch, stream registry cleanup).
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";

export function cancelHeadBodies(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		await next();
		if (c.req.method !== "HEAD") return;
		const body = c.res.body;
		if (body === null) return;
		await body.cancel().catch(() => {});
		c.res = new Response(null, c.res);
	};
}
