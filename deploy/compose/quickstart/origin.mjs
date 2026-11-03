import net from "node:net";
import { hostname } from "node:os";
import { clientGuard } from "../local/ingress.mjs";

function authority(value, protocol) {
	if (typeof value !== "string" || !value || /[\s/@\\#?]/.test(value))
		throw Error("invalid_host");
	const url = new URL(`${protocol}://${value}`);
	if (
		url.host !== value.toLowerCase() ||
		!url.hostname ||
		url.username ||
		url.password
	)
		throw Error("invalid_host");
	const name = url.hostname.replace(/^\[|\]$/g, "");
	if (
		!net.isIP(name) &&
		!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(name)
	)
		throw Error("invalid_host");
	return url;
}
export function requestContext(req, env = process.env, proxyListener = false) {
	const trusted = clientGuard(
		env.UMIAK_TRUSTED_PROXY_CIDRS || "127.0.0.0/8,::1/128",
		"",
		{ UMIAK_LOCAL_DENIED_CIDRS: "" },
	);
	const proxied =
		proxyListener && req.headers["x-forwarded-proto"] !== undefined;
	const proto = proxied ? req.headers["x-forwarded-proto"] || "http" : "http";
	if (!["http", "https"].includes(proto)) throw Error("invalid_proxy_protocol");
	const host = proxied
		? req.headers["x-forwarded-host"] || req.headers.host
		: req.headers.host;
	const url = authority(host, proto);
	const publicUrl = env.UMIAK_PUBLIC_URL ? new URL(env.UMIAK_PUBLIC_URL) : null;
	if (
		publicUrl &&
		(!["http:", "https:"].includes(publicUrl.protocol) ||
			publicUrl.username ||
			publicUrl.password ||
			publicUrl.pathname !== "/" ||
			publicUrl.search ||
			publicUrl.hash)
	)
		throw Error("invalid_public_url");
	const allowed = new Set([
		"localhost",
		hostname().toLowerCase(),
		...(env.UMIAK_QUICKSTART_ALLOWED_HOSTS || "")
			.split(",")
			.map((x) => x.trim().toLowerCase())
			.filter(Boolean),
		...(publicUrl ? [publicUrl.hostname] : []),
	]);
	const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, ""));
	// The dedicated proxy listener is an origin boundary. Pin its external Host with PUBLIC_URL
	// when the proxy itself does not restrict incoming hosts.
	if (proxied && publicUrl && url.origin !== publicUrl.origin)
		throw Error("proxy_host_forbidden");
	if (
		!proxied &&
		!literal &&
		!allowed.has(url.hostname) &&
		!allowed.has(url.host)
	)
		throw Error("host_forbidden");
	let clientAddress = req.socket?.remoteAddress;
	if (proxied && req.headers["x-forwarded-for"]) {
		const chain = String(req.headers["x-forwarded-for"])
			.split(",")
			.map((x) => x.trim());
		if (chain.some((x) => !net.isIP(x)))
			throw Error("invalid_forwarded_address");
		for (const address of chain.reverse()) {
			clientAddress = address;
			if (!trusted(address)) break;
		}
	}
	return { origin: url.origin, clientAddress, proxied };
}
