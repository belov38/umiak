import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgNotifier } from "../src/index.ts";

describe.skipIf(skipPg())("PgNotifier", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 5 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	const notify = (channel: string, payload: string) =>
		t.pool.query("SELECT pg_notify($1, $2)", [channel, payload]);

	function recorder() {
		const calls: (string | null)[] = [];
		const fn = (p: string | null) => {
			calls.push(p);
		};
		return { calls, fn };
	}

	it("signals ready (null) once LISTEN is active, then delivers payloads", async () => {
		const n = new PgNotifier({ connectionString: t.url });
		try {
			const a = recorder();
			n.subscribe("chan_a", a.fn);
			await vi.waitFor(() => expect(a.calls).toEqual([null]));
			await notify("chan_a", "x1");
			await notify("chan_other", "nope");
			await vi.waitFor(() => expect(a.calls).toEqual([null, "x1"]));

			// A second subscriber of an active channel gets its own ready signal.
			const b = recorder();
			const off = n.subscribe("chan_a", b.fn);
			await vi.waitFor(() => expect(b.calls).toEqual([null]));
			off();
			await notify("chan_a", "x2");
			await vi.waitFor(() => expect(a.calls).toEqual([null, "x1", "x2"]));
			expect(b.calls).toEqual([null]);
		} finally {
			await n.close();
		}
	});

	it("reconnects after the connection is killed and signals ready again", async () => {
		const n = new PgNotifier({
			connectionString: t.url,
			reconnectDelayMs: 50,
		});
		try {
			const a = recorder();
			n.subscribe("chan_r", a.fn);
			await vi.waitFor(() => expect(a.calls).toEqual([null]));
			await t.pool.query(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				 WHERE datname = current_database() AND pid <> pg_backend_pid()
				   AND query ILIKE 'LISTEN%'`,
			);
			await vi.waitFor(() => expect(a.calls).toEqual([null, null]), {
				timeout: 5000,
			});
			await notify("chan_r", "after");
			await vi.waitFor(() => expect(a.calls).toEqual([null, null, "after"]));
		} finally {
			await n.close();
		}
	});

	it("rejects channel names that are not plain identifiers", () => {
		const n = new PgNotifier({ connectionString: t.url });
		expect(() => n.subscribe('x"; DROP', () => {})).toThrow();
	});
});
