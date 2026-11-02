import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyIsolation } from "./setup-host.mjs";

const gateway = [{ cidr: "192.168.68.90" }];
const rules = [
	{
		type: "out",
		action: "ACCEPT",
		dest: "+umiak-gateway",
		proto: "tcp",
		dport: "443",
	},
	{ type: "out", action: "DROP", dest: "+umiak-deny" },
	{ type: "out", action: "DROP", dest: "+umiak-deny6" },
];
const sets = {
	"umiak-deny": [
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"100.64.0.0/10",
		"169.254.0.0/16",
		"224.0.0.0/4",
	].map((cidr) => ({ cidr })),
	"umiak-deny6": [{ cidr: "::/1" }, { cidr: "8000::/1" }],
};
test("referenced empty or incomplete deny sets never prove isolation", () => {
	assert.throws(() => verifyIsolation(rules, gateway, undefined, {}), /deny/);
	assert.throws(
		() =>
			verifyIsolation(rules, gateway, undefined, { ...sets, "umiak-deny": [] }),
		/deny/,
	);
	assert.throws(
		() =>
			verifyIsolation(rules, gateway, undefined, {
				...sets,
				"umiak-deny6": [{ cidr: "::/1" }],
			}),
		/deny/,
	);
	assert.throws(
		() =>
			verifyIsolation(rules, gateway, undefined, {
				...sets,
				"umiak-deny": sets["umiak-deny"].filter(
					(x) => x.cidr !== "100.64.0.0/10",
				),
			}),
		/deny/,
	);
});
test("broad accepts, restricted denies and reversed gateway precedence are rejected", () => {
	assert.throws(
		() =>
			verifyIsolation(
				[{ type: "out", action: "ACCEPT" }, ...rules],
				gateway,
				undefined,
				sets,
			),
		/ACCEPT/,
	);
	assert.throws(
		() =>
			verifyIsolation(
				[
					...rules,
					{
						type: "out",
						action: "ACCEPT",
						dest: "192.168.0.0/16",
						proto: "tcp",
						dport: "22",
					},
				],
				gateway,
				undefined,
				sets,
			),
		/ACCEPT/,
	);
	assert.throws(
		() =>
			verifyIsolation(
				[rules[0], { ...rules[1], proto: "tcp" }, rules[2]],
				gateway,
				undefined,
				sets,
			),
		/deny/,
	);
	assert.throws(
		() =>
			verifyIsolation(
				[rules[1], rules[0], rules[2]],
				gateway,
				"192.168.68.90",
				sets,
			),
		/precede/,
	);
});
test("S1 CIDR sets and S10 restricted UDP3478 exception are accepted", () => {
	assert.equal(verifyIsolation(rules, gateway, "192.168.68.90", sets), true);
	assert.equal(
		verifyIsolation(
			[
				rules[0],
				{
					type: "out",
					action: "ACCEPT",
					dest: "+umiak-gateway",
					proto: "udp",
					dport: "3478",
				},
				...rules.slice(1),
			],
			gateway,
			"192.168.68.90",
			sets,
		),
		true,
	);
});
test("a broad gateway IPSet cannot grant HTTPS access to the home network", () => {
	assert.throws(
		() =>
			verifyIsolation(
				rules,
				[{ cidr: "192.168.68.0/24" }],
				"192.168.68.90",
				sets,
			),
		/individual/,
	);
});
test("PVE position fields determine precedence even when response rows are unsorted", () => {
	assert.throws(
		() =>
			verifyIsolation(
				[
					{ ...rules[0], pos: 1 },
					{ ...rules[1], pos: 0 },
					{ ...rules[2], pos: 2 },
				],
				gateway,
				"192.168.68.90",
				sets,
			),
		/precede/,
	);
});
