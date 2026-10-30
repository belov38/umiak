// KeyCache against invalidation races, with a scripted notifier and store.
import { randomUUID } from "node:crypto";
import type { ApiKeyRecord, IdentityStore } from "@sbx/auth";
import type { Notifier } from "@sbx/core";
import { describe, expect, it } from "vitest";
import { IdentityListener, KeyCache } from "../src/index.ts";

function fakeNotifier() {
	let fn: ((p: string | null) => void) | null = null;
	const notifier: Notifier = {
		subscribe(_channel, f) {
			fn = f;
			return () => {
				fn = null;
			};
		},
		async close() {},
	};
	return { notifier, emit: (p: string | null) => fn?.(p) };
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const TEAM = randomUUID();

function keyRecord(id: string, revokedAt: Date | null): ApiKeyRecord {
	return {
		id,
		kind: "team",
		sandboxId: null,
		teamId: TEAM,
		name: "k",
		secretHash: "h",
		prefix: "p",
		last4: "l",
		scopes: [],
		createdBy: null,
		createdVia: "api",
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 86_400_000),
		lastUsedAt: null,
		revokedAt,
		rotatedAt: null,
	};
}

describe("KeyCache", () => {
	for (const payload of ["api-keys:ID", "*"]) {
		it(`a lookup after '${payload}' does not join a load started before it`, async () => {
			const id = randomUUID();
			const loads: ReturnType<typeof deferred<ApiKeyRecord | null>>[] = [];
			const store = {
				findApiKeyByHash: () => {
					const d = deferred<ApiKeyRecord | null>();
					loads.push(d);
					return d.promise;
				},
				team: async () => ({ id: TEAM, name: "t" }),
			} as unknown as IdentityStore;
			const { notifier, emit } = fakeNotifier();
			const events = new IdentityListener(notifier);
			events.start();
			emit(null);
			const cache = new KeyCache(store, events);

			const before = cache.lookup("hash");
			emit(payload.replace("ID", id)); // the key is revoked meanwhile
			const after = cache.lookup("hash");
			expect(loads).toHaveLength(2);
			loads[1]?.resolve(keyRecord(id, new Date()));
			loads[0]?.resolve(keyRecord(id, null));
			expect((await before)?.key.revokedAt).toBeNull();
			expect((await after)?.key.revokedAt).not.toBeNull();
			// The pre-revoke answer was not cached either.
			expect((await cache.lookup("hash"))?.key.revokedAt).not.toBeNull();
			expect(loads).toHaveLength(2);
		});
	}

	it("forget(id) drops the key on this pod without a NOTIFY", async () => {
		const id = randomUUID();
		let revokedAt: Date | null = null;
		let loads = 0;
		const store = {
			findApiKeyByHash: async () => {
				loads++;
				return keyRecord(id, revokedAt);
			},
			team: async () => ({ id: TEAM, name: "t" }),
		} as unknown as IdentityStore;
		const cache = new KeyCache(store, new IdentityListener(null));
		expect((await cache.lookup("hash"))?.key.revokedAt).toBeNull();
		revokedAt = new Date();
		// Still cached (30 s) until forgotten.
		expect((await cache.lookup("hash"))?.key.revokedAt).toBeNull();
		cache.forget(id);
		expect((await cache.lookup("hash"))?.key.revokedAt).not.toBeNull();
		expect(loads).toBe(2);
	});
});
