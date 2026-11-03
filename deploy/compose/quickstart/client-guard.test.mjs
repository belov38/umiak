import assert from "node:assert/strict";
import { test } from "node:test";
import { clientGuard } from "./client-guard.mjs";

test("client guard defaults and mapped addresses", () => {
	const allow = clientGuard();
	for (const ip of [
		"127.0.0.1",
		"::1",
		"::ffff:192.168.1.3",
		"10.2.3.4",
		"172.16.0.1",
		"fd00::1",
	])
		assert.equal(allow(ip), true, ip);
	for (const ip of ["8.8.8.8", "172.32.0.1", "fe80::1", undefined, "bad"])
		assert.equal(allow(ip), false, ip);
});
test("explicit allowlist and invalid settings fail closed", () => {
	const allow = clientGuard("192.168.2.0/24");
	assert.equal(allow("192.168.2.3"), true);
	assert.equal(allow("127.0.0.1"), false);
	for (const value of ["", "0.0.0.0/99", "bad", "10.0.0.0/8/2"])
		assert.throws(() => clientGuard(value));
});

test("deny wins over LAN allow and real socket peers differ", async () => {
	const guard = clientGuard("127.0.0.0/8,::1/128", "::1/128");
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.writeHead(guard(req.socket.remoteAddress) ? 200 : 403);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "::", resolve));
	try {
		for (const [localAddress, expected] of [
			["127.0.0.1", 200],
			["::1", 403],
		]) {
			const status = await new Promise((resolve, reject) => {
				http
					.get(
						{
							host: localAddress,
							port: server.address().port,
							localAddress,
							headers: { "x-forwarded-for": "127.0.0.1" },
						},
						(res) => {
							res.resume();
							resolve(res.statusCode);
						},
					)
					.on("error", reject);
			});
			assert.equal(status, expected);
		}
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("default sandbox subnet is denied and malformed denylist fails startup", () => {
	assert.equal(clientGuard()("10.88.0.2"), false);
	for (const denied of ["bad", "192.168.1.2/33", "::/129", "10.0.0.0/8/2"])
		assert.throws(() => clientGuard(undefined, denied));
});

test("node addresses are automatically denied on ingress", () => {
	const allow = clientGuard(undefined, undefined, {
		UMIAK_PVE_URL: "https://192.168.68.116:8006",
		UMIAK_NODE_SSH_HOST: "fd00::12",
	});
	assert.equal(allow("192.168.68.116"), false);
	assert.equal(allow("fd00::12"), false);
	assert.equal(allow("192.168.68.20"), true);
});
