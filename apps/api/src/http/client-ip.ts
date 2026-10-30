// Client address for the request log (S7 §7.1): from `X-Forwarded-For` only
// when the connection comes from SBX_API_TRUSTED_PROXY_CIDRS (ingress,
// Tailscale Serve via the Docker bridge, oauth2-proxy), else the address of
// the connection. Rate limits are per principal, not per address.
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) as plain IPv4. */
function normalize(address: string): string {
	const a = address.trim();
	const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
	return m !== null ? (m[1] as string) : a;
}

export class TrustedProxies {
	readonly #list = new BlockList();
	readonly #empty: boolean;

	constructor(cidrs: string[]) {
		for (const c of cidrs) {
			const [addr, prefix] = c.split("/") as [string, string];
			const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
			this.#list.addSubnet(addr, Number(prefix), family);
		}
		this.#empty = cidrs.length === 0;
	}

	trusts(address: string): boolean {
		if (this.#empty) return false;
		const a = normalize(address);
		const family = isIP(a);
		if (family === 0) return false;
		return this.#list.check(a, family === 6 ? "ipv6" : "ipv4");
	}

	/**
	 * The client: walking `X-Forwarded-For` from the right while the hop is a
	 * trusted proxy, the first untrusted hop (proxies append, so entries left
	 * of it may be forged). Without a trusted peer the peer itself.
	 */
	clientOf(
		peer: string | undefined,
		forwardedFor: string | undefined,
	): string | undefined {
		if (peer === undefined) return undefined;
		let client = normalize(peer);
		if (!this.trusts(client) || forwardedFor === undefined) return client;
		const hops = forwardedFor
			.split(",")
			.map((h) => normalize(h))
			.filter((h) => h !== "");
		for (let i = hops.length - 1; i >= 0; i--) {
			const hop = hops[i] as string;
			if (isIP(hop) === 0) break;
			client = hop;
			if (!this.trusts(hop)) break;
		}
		return client;
	}
}

/** Sets `clientIp` (undefined outside a real socket, e.g. `app.request`). */
export function clientIp(proxies: TrustedProxies): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const env = c.env as { incoming?: IncomingMessage } | undefined;
		const peer = env?.incoming?.socket?.remoteAddress;
		c.set("clientIp", proxies.clientOf(peer, c.req.header("x-forwarded-for")));
		await next();
	};
}
