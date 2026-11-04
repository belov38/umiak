import assert from "node:assert/strict";
import test from "node:test";
import { takeHashCode } from "./claim-ui.mjs";

function run(hash) {
	const calls = [];
	const location = { hash, pathname: "/claim", search: "?x=1" };
	const history = { replaceState: (...args) => calls.push(args) };
	const code = new Function(
		"location",
		"history",
		`${takeHashCode};return takeHashCode()`,
	)(location, history);
	return { code, calls };
}

test("takeHashCode decodes the fragment and removes it from history", () => {
	const { code, calls } = run("#abc%2Fdef");
	assert.equal(code, "abc/def");
	assert.deepEqual(calls, [[null, "", "/claim?x=1"]]);
});

test("a malformed fragment is still removed and returned raw", () => {
	const { code, calls } = run("#%zz");
	assert.equal(code, "%zz");
	assert.equal(calls.length, 1);
});

test("no fragment leaves history alone", () => {
	const { code, calls } = run("");
	assert.equal(code, "");
	assert.equal(calls.length, 0);
});
