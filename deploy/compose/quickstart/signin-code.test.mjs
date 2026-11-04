import assert from "node:assert/strict";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { printSigninCode, runSigninCode } from "./signin-code.mjs";

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

test("--link prints the one-click path form that signs in", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository(), {
		audit: () => {},
	});
	await store.claim(await store.init());
	const lines = [];
	assert.equal(
		await runSigninCode(store, (line) => lines.push(line), { link: true }),
		0,
	);
	assert.match(lines[0], /^\/signin#[A-Z2-7-]+$/);
	assert.match(lines[1], /Expires:/);
	assert.ok(await store.signin(lines[0].slice("/signin#".length), "link"));
});

test("ten outstanding codes produce a friendly console message", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository(), {
		audit: () => {},
	});
	await store.claim(await store.init());
	for (let i = 0; i < 10; i++) await store.signinCode();
	const lines = [];
	assert.equal(await runSigninCode(store, (line) => lines.push(line)), 2);
	assert.match(lines.join("\n"), /10 sign-in codes are already outstanding/);
	assert.doesNotMatch(lines.join("\n"), /Error:|owner_signin_issued/);
});

test("console help works without a database and never issues a code", async () => {
	const { execFileSync } = await import("node:child_process");
	const output = execFileSync(
		process.execPath,
		["deploy/compose/quickstart/signin-code.mjs", "--help"],
		{ encoding: "utf8", env: { ...process.env, DATABASE_URL: "invalid" } },
	);
	assert.match(output, /Usage: umiak-signin/);
	assert.doesNotMatch(
		output,
		/owner_signin_issued|One-time owner sign-in code:/,
	);
});
