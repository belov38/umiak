import { decodeUuid } from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// S9 §24.8: a running Windows sandbox is forked or saved only from a stopped
// VM. Without `forceStop` the API answers 409 `snapshot_requires_stop` with a
// hint; with it the operations carry `forceStop` and report the restart.

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const HINT_DETAILS = {
	reason: "windows_running",
	retryWith: { forceStop: true },
	cli: "--force-stop",
};

describe.skipIf(skipPg())(
	"forceStop for Windows fork and saved snapshot",
	() => {
		let db: TestDatabase;
		let w: ApiWorld;
		let h: Harness;

		beforeAll(async () => {
			db = await createTestDatabase({ max: 20 });
			w = await apiWorld(db.pool, {
				quota: {
					maxActiveSandboxes: 100,
					maxRamMb: 1_000_000,
					maxSavedSnapshots: 100,
				},
			});
			h = w.harness();
		});
		afterAll(async () => {
			await w?.close();
			await db?.drop();
		});

		async function setOs(machineId: string, os: "linux" | "windows") {
			await db.pool.query(
				"UPDATE runtime.template_builds SET os = $2 WHERE id = (SELECT template_build_id FROM runtime.machines WHERE id = $1)",
				[machineId, os],
			);
		}
		let windowsMachine: string | undefined;
		afterEach(async () => {
			if (windowsMachine) await setOs(windowsMachine, "linux");
			windowsMachine = undefined;
		});
		async function windows(state: "ready" | "stopped") {
			const s = await w.seed({ state });
			const machineId = s.machineId as string;
			await setOs(machineId, "windows");
			windowsMachine = machineId;
			return s;
		}

		it("fork of a running Windows sandbox without forceStop: 409 with the hint", async () => {
			const s = await windows("ready");
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json: {},
			});
			expect(r.status).toBe(409);
			expect(body(r).error).toEqual({
				code: "snapshot_requires_stop",
				message:
					"Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again",
				retryable: false,
				details: HINT_DETAILS,
				requestId: expect.any(String),
			});
		});

		it("saved snapshot of a running Windows sandbox without forceStop: 409 with the save wording", async () => {
			const s = await windows("ready");
			const r = await h.request("POST", "/v1/snapshots", {
				json: { sandbox: s.slug, name: "win-save" },
			});
			expect(r.status).toBe(409);
			expect(body(r).error).toMatchObject({
				code: "snapshot_requires_stop",
				message: expect.stringMatching(
					/^Windows snapshots are saved from a stopped VM; stop it first or retry with forceStop: true \(CLI --force-stop\)/,
				),
				details: HINT_DETAILS,
			});
		});

		it("forceStop: true is accepted; the source operation reports the stop and restart", async () => {
			const s = await windows("ready");
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json: { forceStop: true },
			});
			expect(r.status).toBe(202);
			const src = body(r).sourceOperation;
			expect(src).toMatchObject({
				kind: "fork",
				forceStop: {
					sourceStopped: false,
					sourceRestarted: null,
					restartError: null,
				},
			});
			expect(body(r).operation.forceStop).toBeNull();

			const id = decodeUuid("operation", src.id);
			await db.pool.query(
				`UPDATE runtime.operations
			 SET progress = progress || '{"forceStopped": true, "sourceRestarted": false,
			   "restartError": {"code": "agent_timeout", "message": "no agent"}}'::jsonb
			 WHERE id = $1`,
				[id],
			);
			const g = await h.request("GET", `/v1/operations/${src.id}`);
			expect(g.status).toBe(200);
			expect(body(g).forceStop).toEqual({
				sourceStopped: true,
				sourceRestarted: false,
				restartError: { code: "agent_timeout", message: "no agent" },
			});

			const save = await h.request("POST", "/v1/snapshots", {
				json: { sandbox: s.slug, name: "win-forced", forceStop: true },
			});
			// The fork is still active on the source.
			expect(save.status).toBe(409);
			expect(body(save).error.code).toBe("operation_in_progress");
		});

		it("forceStop is ignored for a stopped Windows sandbox", async () => {
			const off = await windows("stopped");
			const a = await h.request("POST", "/v1/snapshots", {
				json: { sandbox: off.slug, name: "win-off", forceStop: true },
			});
			expect(a.status).toBe(202);
			expect(body(a).operation.forceStop).toBeNull();
		});

		it("forceStop is ignored for a running Linux sandbox", async () => {
			const lin = await w.seed({ state: "ready" });
			const b = await h.request("POST", "/v1/snapshots", {
				json: { sandbox: lin.slug, name: "lin-live", forceStop: true },
			});
			expect(b.status).toBe(202);
			expect(body(b).operation.forceStop).toBeNull();
		});

		it("forceStop must be a boolean", async () => {
			const s = await w.seed({ state: "ready" });
			const r = await h.request("POST", `/v1/sandboxes/${s.slug}/fork`, {
				json: { forceStop: "yes" },
			});
			expect(r.status).toBe(400);
			expect(body(r).error.code).toBe("validation");
		});
	},
);
