import assert from "node:assert/strict";
import { test } from "node:test";
import { clientGuard } from "./ingress.mjs";

test("local ingress defaults and mapped addresses", () => {
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
