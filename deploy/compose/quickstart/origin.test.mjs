import assert from "node:assert/strict";
import test from "node:test";
import { requestContext } from "./origin.mjs";

const req = (host, headers = {}, peer = "192.168.1.5") => ({
	headers: { host, ...headers },
	socket: { remoteAddress: peer },
});
test("direct HTTP enforces Host allowlist and ignores forged proxy headers", () => {
	assert.equal(
		requestContext(
			req("192.168.1.10:4180", {
				"x-forwarded-proto": "https",
				"x-forwarded-host": "evil.test",
				"x-forwarded-for": "8.8.8.8",
			}),
			{},
		).origin,
		"http://192.168.1.10:4180",
	);
	assert.throws(() => requestContext(req("evil.example"), {}), /host/);
	assert.equal(
		requestContext(req("lab.home:4180"), {
			UMIAK_QUICKSTART_ALLOWED_HOSTS: "lab.home",
		}).origin,
		"http://lab.home:4180",
	);
});
test("trusted generic proxy supplies HTTPS origin and client, public URL pins origin", () => {
	const request = req(
		"internal:4180",
		{
			"x-forwarded-proto": "https",
			"x-forwarded-host": "lab.example:8443",
			"x-forwarded-for": "203.0.113.10",
		},
		"127.0.0.1",
	);
	assert.deepEqual(requestContext(request, {}), {
		origin: "https://lab.example:8443",
		clientAddress: "203.0.113.10",
		proxied: true,
	});
	assert.throws(
		() =>
			requestContext(request, { UMIAK_PUBLIC_URL: "https://other.example" }),
		/host/,
	);
	assert.equal(
		requestContext(request, { UMIAK_PUBLIC_URL: "https://lab.example:8443" })
			.origin,
		"https://lab.example:8443",
	);
});
test("invalid forwarded protocol and malformed host fail closed", () => {
	assert.throws(() =>
		requestContext(
			req("localhost", { "x-forwarded-proto": "https,http" }, "127.0.0.1"),
			{},
		),
	);
	for (const host of ["evil/path", "user@localhost", "localhost#x"])
		assert.throws(() => requestContext(req(host), {}));
});

test("trusted forwarding still rejects shell and URL authority metacharacters", () => {
	for (const host of ["bad'host", "bad`host", "bad;host", "-invalid.example"])
		assert.throws(
			() =>
				requestContext(
					req(
						"localhost",
						{ "x-forwarded-proto": "https", "x-forwarded-host": host },
						"127.0.0.1",
					),
					{},
				),
			/host/,
		);
});
