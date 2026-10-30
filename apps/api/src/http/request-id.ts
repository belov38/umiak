// Request-Id (S7 §5.5): our own `req_<ulid>` on every response; a client's
// `Request-Id` (up to 128 of [A-Za-z0-9._-]) is only logged next to ours.
import { newPublicUlid } from "@sbx/auth";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";

export const REQUEST_ID_HEADER = "Request-Id";

const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const id = newPublicUlid("request");
		c.set("requestId", id);
		const client = c.req.header(REQUEST_ID_HEADER);
		c.set(
			"clientRequestId",
			client !== undefined && CLIENT_REQUEST_ID_RE.test(client)
				? client
				: undefined,
		);
		c.header(REQUEST_ID_HEADER, id);
		await next();
		// Responses built outside `c` (a proxied fetch, a WebSocket upgrade)
		// do not carry the prepared header.
		if (c.res.headers.get(REQUEST_ID_HEADER) !== id) {
			try {
				c.res.headers.set(REQUEST_ID_HEADER, id);
			} catch {
				// Immutable headers: copy the response.
				c.res = new Response(c.res.body, c.res);
				c.res.headers.set(REQUEST_ID_HEADER, id);
			}
		}
	};
}
