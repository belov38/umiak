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
	await store.pairApprove(pair.id, pair.code);
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

test("pair capacity is isolated by source and approval requires short code", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.claim(await store.init());
	for (let n = 0; n < 5; n++) await store.pairStart({ source: "one" });
	await assert.rejects(store.pairStart({ source: "one" }), /pair_limit/);
	const pair = await store.pairStart({ source: "two", userAgent: "CLI" });
	assert.match(pair.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	assert.equal((await store.pairInfo(pair.id)).source, "two");
	await assert.rejects(store.pairApprove(pair.id, "wrong"), /invalid_pair/);
	await store.pairApprove(pair.id, pair.code);
	const token = await store.pairPoll(pair.id, pair.secret);
	assert.equal(await store.canApprove(token), false);
	assert.equal((await store.sessions()).length, 2);
	await store.revokeSession(
		(await store.sessions()).find((x) => x.kind === "cli").id,
	);
	assert.equal(await store.authenticate(token), false);
});

test("authentication and claim status do not acquire mutation transactions", async () => {
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	const token = await store.claim(await store.init());
	repo.transaction = () => {
		throw new Error("write attempted");
	};
	assert.equal(await store.authenticate(token), true);
	assert.equal(await store.claimed(), true);
});

test("legacy undifferentiated credentials are rejected after upgrade", async () => {
	const { createHash } = await import("node:crypto");
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	const token = await store.claim(await store.init());
	const id = createHash("sha256").update(token).digest("hex");
	repo.state.sessions[id] = Date.now() + 180 * 86400000;
	assert.equal(await store.authenticate(token), false);
	assert.equal(await store.canApprove(token), false);
});

test("sign-in codes expire, are consumed atomically and preserve other access", async () => {
	let now = 1000;
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo, { now: () => now });
	const first = await store.claim(await store.init(), "first.example");
	const pair = await store.pairStart();
	const issued = await store.signinCode();
	assert.match(issued.code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
	assert.ok(
		!JSON.stringify(repo.state).includes(issued.code.replaceAll("-", "")),
	);
	const results = await Promise.allSettled([
		store.signin(issued.code, "one", "second.example"),
		store.signin(issued.code, "two"),
	]);
	assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
	assert.equal(await store.authenticate(first), true);
	await store.pairApprove(pair.id, pair.code);
	assert.ok(await store.pairPoll(pair.id, pair.secret));
	const expired = await store.signinCode();
	now += 600001;
	await assert.rejects(store.signin(expired.code, "three"), /invalid_signin/);
});

test("failed sign-ins persist limits across stores and invalidate outstanding codes", async () => {
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	await store.claim(await store.init());
	const issued = await store.signinCode();
	for (let i = 0; i < 20; i++)
		await assert.rejects(
			store.signin("wrong", `source-${i}`),
			/invalid_signin/,
		);
	await assert.rejects(
		new OwnerStore(repo).signin(issued.code, "fresh"),
		/invalid_signin/,
	);
	const next = await store.signinCode();
	for (let i = 0; i < 20; i++)
		await assert.rejects(store.signin("wrong", "limited"), /invalid_signin/);
	await assert.rejects(store.signin(next.code, "limited"), /signin_limited/);
});

test("recovery invalidates unused sign-in codes even after reclaim", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.claim(await store.init());
	const issued = await store.signinCode();
	await store.claim(await store.recover());
	await assert.rejects(store.signin(issued.code, "new"), /invalid_signin/);
});

test("sessions retain creation hostname and record last HTTP use", async () => {
	let now = 1000;
	const store = new OwnerStore(new MemoryOwnerRepository(), { now: () => now });
	const token = await store.claim(await store.init(), "first.example");
	now = 62000;
	await store.touch(token);
	const session = (await store.sessions())[0];
	assert.equal(session.hostname, "first.example");
	assert.equal(session.created, 1000);
	assert.equal(session.lastUsed, 62000);
	const pair = await store.pairStart({ hostname: "cli.example" });
	await store.pairApprove(pair.id, pair.code);
	const cli = await store.pairPoll(pair.id, pair.secret);
	assert.equal((await store.session(cli)).hostname, "cli.example");
});

test("full source map never causes per-request owner writes; touch is minute-coalesced", async () => {
	let now = 1000;
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo, { now: () => now });
	const token = await store.claim(await store.init());
	repo.state.signinSources = {};
	for (let i = 0; i < 10000; i++)
		repo.state.signinSources[i] = { count: 1, expires: now + 600000 };
	for (let i = 0; i < 10000; i++)
		store.signinSources.set(String(i), { count: 1, expires: now + 600000 });
	let writes = 0;
	const transaction = repo.transaction.bind(repo);
	repo.transaction = (fn) => {
		writes++;
		return transaction(fn);
	};
	for (let i = 0; i < 1000; i++) {
		assert.ok(await store.authenticate(token));
		await store.touch(token);
	}
	assert.equal(writes, 0);
	now += 60001;
	await store.touch(token);
	assert.equal(writes, 1);
	await store.touch(token);
	assert.equal(writes, 1);
});

test("source buckets expire, cap new sources and never enter durable owner state", async () => {
	let now = 1000;
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo, { now: () => now });
	await store.claim(await store.init());
	for (let i = 0; i < 10000; i++)
		await assert.rejects(store.signin("bad", String(i)), /invalid_signin/);
	assert.equal(Object.keys(repo.state.signinSources ?? {}).length, 0);
	await assert.rejects(
		store.signin("bad", "overflow"),
		(e) => e.message === "signin_limited" && e.retryAfter === 600,
	);
	now += 600001;
	await assert.rejects(store.signin("bad", "overflow"), /invalid_signin/);
});

test("audit records source, hostname and issuer without code material", async () => {
	const events = [];
	const store = new OwnerStore(new MemoryOwnerRepository(), {
		audit: (e) => events.push(e),
	});
	await store.claim(await store.init());
	const issued = await store.signinCode({
		source: "192.0.2.1",
		hostname: "first.example",
		issuer: "browser",
	});
	await store.signin(issued.code, "192.0.2.2", "second.example");
	assert.deepEqual(events, [
		{
			event: "owner_signin_issued",
			source: "192.0.2.1",
			hostname: "first.example",
			issuer: "browser",
		},
		{
			event: "owner_signin_used",
			source: "192.0.2.2",
			hostname: "second.example",
			issuer: "browser",
		},
	]);
	assert.ok(!JSON.stringify(events).includes(issued.code));
});

test("startup drops legacy buckets while preserving the exact sessions object", async () => {
	const repo = new MemoryOwnerRepository();
	const store = new OwnerStore(repo);
	await store.claim(await store.init());
	const sessions = JSON.stringify(repo.state.sessions);
	repo.state.signinSources = {
		old: { count: 20, expires: Date.now() + 600000 },
	};
	assert.equal(await new OwnerStore(repo).init(), null);
	assert.equal(JSON.stringify(repo.state.sessions), sessions);
	assert.equal(repo.state.signinSources, undefined);
});
