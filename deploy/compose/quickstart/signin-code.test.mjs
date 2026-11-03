import assert from "node:assert/strict";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { printSigninCode } from "./signin-code.mjs";

test("host command prints a usable code and preserves existing access", async () => {
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	const first = await store.claim(await store.init());
	const lines = [];
	const issued = await printSigninCode(store, (line) => lines.push(line));
	assert.ok(lines[0].includes(issued.code));
	assert.match(lines[1], /Expires:/);
	assert.ok(await store.signin(issued.code, "console-test"));
	assert.equal(await store.authenticate(first), true);
});
