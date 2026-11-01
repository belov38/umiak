// Saved snapshots (S7 §13): save with an operation, list, get, delete with
// a confirmation header.
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeApiError, invalidState, validation } from "./errors.ts";
import {
	activeOperation,
	claimIdempotency,
	finishOperation,
	forceStopFor,
	iso,
	isoOrNull,
	lookupSandbox,
	markForceStopped,
	operationResource,
	startOperation,
	templateOf,
} from "./model.ts";
import type { Fake, FakeApp, FakeOperation, FakeSnapshot } from "./state.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function snapshotResource(fake: Fake, s: FakeSnapshot) {
	return {
		id: s.id,
		name: s.name,
		state: s.state,
		sourceSandboxId: s.sourceSandboxId,
		template: s.template,
		templateVersion:
			s.template === null
				? null
				: (templateOf(fake, s.template)?.version ?? null),
		size: s.size,
		consistency: s.consistency,
		error: s.error,
		createdAt: iso(s.createdAt),
		readyAt: isoOrNull(s.readyAt),
	};
}

export function registerSnapshotRoutes(app: FakeApp, fake: Fake): void {
	const { state } = fake;

	const ofTeam = (teamId: string) =>
		[...state.snapshots.values()].filter(
			(s) => s.teamId === teamId && s.state !== "deleting",
		);

	/** The ready snapshot of a name, else the one being saved. */
	const byName = (teamId: string, name: string): FakeSnapshot | undefined => {
		const all = ofTeam(teamId).filter((s) => s.name === name);
		return all.find((s) => s.state === "ready") ?? all[0];
	};

	app.get("/v1/snapshots", (c) =>
		c.json({
			data: ofTeam(c.get("principal").teamId)
				.sort((a, b) => b.seq - a.seq)
				.map((s) => snapshotResource(fake, s)),
		}),
	);

	app.post("/v1/snapshots", async (c) => {
		const p = c.get("principal");
		const b = c.get("json") as {
			sandbox: string;
			name: string;
			forceStop?: boolean;
		};
		const claim = claimIdempotency(fake, c, "snapshots.create", b);
		if (claim?.replay) {
			const snap = state.snapshots.get(
				claim.replay.snapshotId as string,
			) as FakeSnapshot;
			const op = state.operations.get(
				claim.replay.operationId as string,
			) as FakeOperation;
			return c.json(
				{
					snapshot: snapshotResource(fake, snap),
					operation: operationResource(op),
				},
				202,
				{
					"Idempotency-Replayed": "true",
				},
			);
		}
		const sb = lookupSandbox(fake, p, b.sandbox);
		if (!NAME_RE.test(b.name)) {
			throw validation([
				{ path: "name", message: "must match ^[a-z0-9][a-z0-9-]{0,62}$" },
			]);
		}
		if (sb.state !== "ready" && sb.state !== "stopped") {
			throw invalidState(
				`sandbox ${sb.slug} is ${sb.state}; only a ready or stopped sandbox can be saved`,
				{ state: sb.state },
			);
		}
		const active = activeOperation(fake, sb);
		if (active) {
			throw new FakeApiError(
				409,
				"operation_in_progress",
				`the sandbox already has a running '${active.kind}' operation; retry after it finishes`,
				{
					retryable: true,
					details: { operationId: active.id, kind: active.kind },
				},
			);
		}
		const forced = forceStopFor(fake, sb, "save_snapshot", b.forceStop);
		const replaced = byName(p.teamId, b.name);
		if (
			!replaced &&
			ofTeam(p.teamId).length >= fake.opts.quota.maxSavedSnapshots
		) {
			throw new FakeApiError(
				403,
				"quota_exceeded",
				"the team has reached its limit of saved snapshots; delete one",
				{
					details: {
						quota: "maxSavedSnapshots",
						limit: fake.opts.quota.maxSavedSnapshots,
						current: ofTeam(p.teamId).length,
					},
				},
			);
		}
		const id = fake.newId("snap");
		const snap: FakeSnapshot = {
			id,
			name: b.name,
			teamId: p.teamId,
			state: "creating",
			sourceSandboxId: sb.id,
			template: sb.template,
			size: sb.size,
			consistency: null,
			error: null,
			createdAt: new Date(),
			readyAt: null,
			dir: join(state.filesRoot, `_snapshot_${id}`),
			seq: fake.nextSeq(),
		};
		state.snapshots.set(id, snap);
		await cp(state.fs(sb.id).root, snap.dir, {
			recursive: true,
			verbatimSymlinks: true,
		});
		const wasReady = sb.state === "ready";
		const op = startOperation(fake, sb, "save_snapshot", "copying");
		if (forced) {
			op.forceStop = {
				sourceStopped: false,
				sourceRestarted: null,
				restartError: null,
			};
		}
		fake.later(state.readyAfterMs, () => {
			snap.state = "ready";
			snap.readyAt = new Date();
			snap.consistency = wasReady && !forced ? "quiesced" : "powered_off";
			if (forced) markForceStopped(fake, op, sb);
			// The new snapshot replaces a ready one of the same name.
			for (const other of state.snapshots.values()) {
				if (
					other !== snap &&
					other.teamId === snap.teamId &&
					other.name === snap.name &&
					other.state === "ready"
				) {
					state.snapshots.delete(other.id);
					void rm(other.dir, { recursive: true, force: true });
				}
			}
			finishOperation(fake, op, "succeeded");
		});
		claim?.save({ snapshotId: id, operationId: op.id });
		return c.json(
			{
				snapshot: snapshotResource(fake, snap),
				operation: operationResource(op),
			},
			202,
		);
	});

	app.get("/v1/snapshots/:name", (c) => {
		const snap = byName(c.get("principal").teamId, c.req.param("name"));
		if (!snap)
			throw new FakeApiError(
				404,
				"snapshot_not_found",
				`no snapshot named ${c.req.param("name")}`,
			);
		return c.json(snapshotResource(fake, snap));
	});

	app.delete("/v1/snapshots/:name", (c) => {
		const name = c.req.param("name");
		const snap = byName(c.get("principal").teamId, name);
		if (!snap)
			throw new FakeApiError(
				404,
				"snapshot_not_found",
				`no snapshot named ${name}`,
			);
		const confirm = c.req.header("Sbx-Confirm-Delete");
		if (
			confirm === undefined ||
			(confirm !== snap.id && confirm !== snap.name)
		) {
			throw new FakeApiError(
				428,
				"confirmation_required",
				`deleting needs the header Sbx-Confirm-Delete: ${snap.id}${confirm === undefined ? "" : ` (got ${confirm})`}`,
				{
					details: { reason: confirm === undefined ? "missing" : "mismatch" },
				},
			);
		}
		if (snap.state === "creating") {
			throw invalidState(
				`snapshot ${snap.name} is still being saved; wait until it is ready`,
				{ state: "creating" },
			);
		}
		state.snapshots.delete(snap.id);
		void rm(snap.dir, { recursive: true, force: true });
		return c.body(null, 204);
	});
}
