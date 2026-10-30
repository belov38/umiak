// The exit reason and outputTruncated are stored with the command (S7 §9.6,
// §23.3): the Command resource prefers the agent's live values and falls
// back to the stored ones when the agent is unavailable or the command was
// ended by the platform (lost).
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveCommandRef } from "../src/map/command.ts";
import {
	type Any,
	openStream,
	type ReadySandbox,
	readySandbox,
	shellGate,
	until,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

describe.skipIf(skipPg())("stored exit reason and outputTruncated", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
	});
	afterEach(() => {
		w.agent.setUnavailable(sb.machineId, false);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	async function stored(pub: string) {
		const r = await w.pool.query(
			"SELECT status, reason, output_truncated FROM runtime.commands WHERE id = $1",
			[resolveCommandRef(pub)],
		);
		return r.rows[0];
	}

	const getCommand = async (pub: string) => {
		const r = await h.request("GET", `${sb.commands}/${pub}`);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		return r.body as Any;
	};

	it("a stream's exit stores them; without the agent GET and the list answer the stored values", async () => {
		const gate = shellGate();
		const s = await openStream(h, "POST", sb.commands, {
			json: { mode: "stream", command: `${gate.shell}; echo x` },
		});
		const started = (await s.next()) as Any;
		const pub = started.commandId as string;
		w.agent.truncateOutput(resolveCommandRef(pub), "disk_full");
		gate.open();
		expect((await s.rest()).at(-1)).toMatchObject({
			type: "exit",
			reason: "none",
			outputTruncated: "disk_full",
		});
		expect(await stored(pub)).toEqual({
			status: "exited",
			reason: "none",
			output_truncated: "disk_full",
		});

		w.agent.setUnavailable(sb.machineId, true);
		expect(await getCommand(pub)).toMatchObject({
			status: "exited",
			reason: "none",
			outputTruncated: "disk_full",
		});
		const list = await h.request("GET", sb.commands);
		expect(
			((list.body as Any).data as Any[]).find((c) => c.id === pub),
		).toMatchObject({ reason: "none", outputTruncated: "disk_full" });
	});

	it("a detached command completed by GET stores them; a truncation the agent reports after the end is added", async () => {
		const gate = shellGate();
		const r = await h.request("POST", sb.commands, {
			json: { mode: "detached", command: `${gate.shell}; kill -9 $$` },
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const pub = (r.body as Any).id as string;
		const id = resolveCommandRef(pub);
		w.agent.truncateOutput(id, "disk_full");
		gate.open();
		await until(
			async () => (await w.agent.get(sb.machineId, id)).exit !== null,
		);
		expect(await getCommand(pub)).toMatchObject({
			status: "killed",
			reason: "signal",
			outputTruncated: "disk_full",
		});
		expect(await stored(pub)).toEqual({
			status: "killed",
			reason: "signal",
			output_truncated: "disk_full",
		});

		// Ended and stored without it; the agent learns of it later.
		const plain = await h.request("POST", sb.commands, {
			json: { command: "echo y" },
		});
		expect(plain.status).toBe(200);
		const plainPub = (plain.body as Any).command.id as string;
		expect(await stored(plainPub)).toEqual({
			status: "exited",
			reason: "none",
			output_truncated: null,
		});
		w.agent.truncateOutput(resolveCommandRef(plainPub), "disk_full");
		expect(await getCommand(plainPub)).toMatchObject({
			outputTruncated: "disk_full",
		});
		expect((await stored(plainPub)).output_truncated).toBe("disk_full");
		w.agent.setUnavailable(sb.machineId, true);
		expect(await getCommand(plainPub)).toMatchObject({
			status: "exited",
			reason: "none",
			outputTruncated: "disk_full",
		});
	});

	it("the sync answer carries the stored reason", async () => {
		const r = await h.request("POST", sb.commands, {
			json: { command: "exit 3" },
		});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect((r.body as Any).command).toMatchObject({
			status: "exited",
			exitCode: 3,
			reason: "none",
			outputTruncated: null,
		});
	});

	it("a command the platform marked lost answers its stored reason; one without a reason answers null", async () => {
		const start = async () => {
			const r = await h.request("POST", sb.commands, {
				json: { mode: "detached", command: "sleep 30" },
			});
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			return (r.body as Any).id as string;
		};
		const rebooted = await start();
		const old = await start();
		// What the worker writes when the boot id changed (reason `reboot`),
		// and a lost row whose cause is unknown (a stop, a missing VM, or a
		// row from before the column existed).
		await w.pool.query(
			`UPDATE runtime.commands SET status = 'lost', ended_at = now(),
			   reason = CASE WHEN id = $1 THEN 'reboot' END
			 WHERE id = ANY($2)`,
			[resolveCommandRef(rebooted), [rebooted, old].map(resolveCommandRef)],
		);
		w.agent.setUnavailable(sb.machineId, true);
		expect(await getCommand(rebooted)).toMatchObject({
			status: "lost",
			reason: "reboot",
			outputTruncated: null,
		});
		expect(await getCommand(old)).toMatchObject({
			status: "lost",
			reason: null,
		});
	});

	it("an ended row's stored reason wins over the agent's; the agent's fills a missing one", async () => {
		const ended = async () => {
			const r = await h.request("POST", sb.commands, {
				json: { mode: "detached", command: "true" },
			});
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			const pub = (r.body as Any).id as string;
			const id = resolveCommandRef(pub);
			await until(
				async () => (await w.agent.get(sb.machineId, id)).exit !== null,
			);
			return pub;
		};
		const known = await ended();
		const unknown = await ended();
		// The platform ended both first (the agent says `none`).
		await w.pool.query(
			`UPDATE runtime.commands SET status = 'lost', ended_at = now(),
			   reason = CASE WHEN id = $1 THEN 'reboot' END
			 WHERE id = ANY($2)`,
			[resolveCommandRef(known), [known, unknown].map(resolveCommandRef)],
		);
		expect(await getCommand(known)).toMatchObject({
			status: "lost",
			reason: "reboot",
		});
		expect(await getCommand(unknown)).toMatchObject({
			status: "lost",
			reason: "none",
		});
	});

	it("an outputTruncated the agent sends that cannot be stored is not answered (GET, sync)", async () => {
		const r = await h.request("POST", sb.commands, {
			json: { mode: "detached", command: "true" },
		});
		const pub = (r.body as Any).id as string;
		const id = resolveCommandRef(pub);
		await until(
			async () => (await w.agent.get(sb.machineId, id)).exit !== null,
		);
		w.agent.truncateOutput(id, "x".repeat(65));
		expect(await getCommand(pub)).toMatchObject({ outputTruncated: null });
		expect((await stored(pub)).output_truncated).toBeNull();

		const gate = shellGate();
		const marker = `odd-${Date.now()}`;
		const sync = h.request("POST", sb.commands, {
			json: { command: `${gate.shell}; echo ${marker}` },
		});
		const syncId = await until(async () => {
			const q = await w.pool.query<{ id: string }>(
				"SELECT id FROM runtime.commands WHERE cmd LIKE $1 AND status = 'running'",
				[`%${marker}%`],
			);
			return q.rows[0]?.id;
		});
		w.agent.truncateOutput(syncId, "disk\nfull");
		gate.open();
		const done = await sync;
		expect(done.status, JSON.stringify(done.body)).toBe(200);
		expect((done.body as Any).command).toMatchObject({
			status: "exited",
			outputTruncated: null,
		});
	});
});
