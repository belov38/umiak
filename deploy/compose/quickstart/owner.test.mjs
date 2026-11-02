import assert from "node:assert/strict";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";

test("claim is atomic, one-time, persists across stores and stores only digests", async () => {
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	const code = await store.init();
	assert.match(code, /^[A-Za-z0-9_-]{43}$/);
	await assert.rejects(store.claim("bad"), /invalid_claim/);
	const results = await Promise.allSettled([
		store.claim(code),
		store.claim(code),
	]);
	assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
	const token = results.find((x) => x.status === "fulfilled").value;
	assert.equal(await store.authenticate(token), true);
	assert.equal(await new OwnerStore(repo).init(), null);
	assert.ok(!JSON.stringify(repo.state).includes(token));
	assert.ok(!JSON.stringify(repo.state).includes(code));
	await store.revoke(token);
	assert.equal(await store.authenticate(token), false);
});

test("pair requires owner approval and correct polling secret; delivered only once", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	await store.claim(code);
	const pair = await store.pairStart();
	assert.equal(await store.pairPoll(pair.id, pair.secret), null);
	await assert.rejects(store.pairPoll(pair.id, "bad"), /invalid_pair/);
	await store.pairApprove(pair.id);
	const token = await store.pairPoll(pair.id, pair.secret);
	assert.equal(await store.authenticate(token), true);
	await assert.rejects(store.pairPoll(pair.id, pair.secret), /invalid_pair/);
});

test("pair and session expiration are enforced", async () => {
	let now = 0;
	const store = new OwnerStore(new MemoryOwnerRepository(), {
		now: () => now,
		sessionMs: 100,
		pairMs: 50,
	});
	const code = await store.init();
	const token = await store.claim(code);
	const pair = await store.pairStart();
	now = 51;
	await assert.rejects(store.pairApprove(pair.id), /invalid_pair/);
	now = 101;
	assert.equal(await store.authenticate(token), false);
});

test("console recovery invalidates every existing session and pairing", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const first = await store.init();
	const session = await store.claim(first);
	const pair = await store.pairStart();
	const code = await store.recover();
	assert.equal(await store.authenticate(session), false);
	await assert.rejects(() => store.pairPoll(pair.id, pair.secret));
	assert.equal(await store.claimed(), false);
	assert.ok(await store.claim(code));
	await assert.rejects(() => store.claim(code));
});
