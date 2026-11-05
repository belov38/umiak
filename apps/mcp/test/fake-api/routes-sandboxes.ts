// Catalog, account, sandboxes, their lifecycle actions and operations
// (S7 §5.10, §8, §13).
import { cp, rm } from "node:fs/promises";
import { FakeApiError, invalidState, notFound, validation } from "./errors.ts";
import {
	activeOperation,
	checkScope,
	claimIdempotency,
	finishOperation,
	forceStopFor,
	limitOf,
	longPoll,
	lookupSandbox,
	markForceStopped,
	operationResource,
	paginate,
	sandboxResource,
	startOperation,
	templateOf,
} from "./model.ts";
import { loseRunningCommands } from "./scenario.ts";
import type {
	Fake,
	FakeApp,
	FakeOperation,
	FakePrincipal,
	FakeSandbox,
	SandboxState,
} from "./state.ts";

const SANDBOX_STATES: SandboxState[] = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
	"deleted",
];
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const POWERED: SandboxState[] = ["creating", "ready", "starting", "stopping"];

type Json = Record<string, unknown>;

function parseStates(
	raw: string | undefined,
	path: string,
): SandboxState[] | undefined {
	if (raw === undefined) return undefined;
	const items = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const bad = items.filter((s) => !SANDBOX_STATES.includes(s as SandboxState));
	if (bad.length > 0) {
		throw validation([
			{
				path,
				message: `unknown state ${bad.join(", ")}; one of ${SANDBOX_STATES.join(", ")}`,
			},
		]);
	}
	return items as SandboxState[];
}

function usageOf(fake: Fake, teamId: string) {
	let activeSandboxes = 0;
	let ramMb = 0;
	for (const sb of fake.state.sandboxes.values()) {
		if (sb.teamId !== teamId || !POWERED.includes(sb.state)) continue;
		activeSandboxes += 1;
		ramMb += sb.memoryMb;
	}
	let savedSnapshots = 0;
	for (const s of fake.state.snapshots.values()) {
		if (s.teamId === teamId && (s.state === "ready" || s.state === "creating"))
			savedSnapshots += 1;
	}
	return { activeSandboxes, ramMb, savedSnapshots };
}

function remainingOf(fake: Fake, teamId: string) {
	const u = usageOf(fake, teamId);
	const q = fake.opts.quota;
	return {
		activeSandboxes: Math.max(0, q.maxActiveSandboxes - u.activeSandboxes),
		ramMb: Math.max(0, q.maxRamMb - u.ramMb),
		savedSnapshots: Math.max(0, q.maxSavedSnapshots - u.savedSnapshots),
	};
}

/** Throws 403 quota_exceeded when one more sandbox of `memoryMb` does not fit. */
function checkQuota(fake: Fake, teamId: string, memoryMb: number): void {
	const u = usageOf(fake, teamId);
	const q = fake.opts.quota;
	if (u.activeSandboxes >= q.maxActiveSandboxes) {
		throw new FakeApiError(
			403,
			"quota_exceeded",
			"the team has reached its limit of active sandboxes; stop or delete one",
			{
				details: {
					quota: "maxActiveSandboxes",
					limit: q.maxActiveSandboxes,
					current: u.activeSandboxes,
				},
			},
		);
	}
	if (u.ramMb + memoryMb > q.maxRamMb) {
		throw new FakeApiError(
			403,
			"quota_exceeded",
			"the team has reached its RAM limit; stop or delete a sandbox",
			{
				details: { quota: "maxRamMb", limit: q.maxRamMb, current: u.ramMb },
			},
		);
	}
}

function setTtl(sb: FakeSandbox, ttl: number | null | undefined): void {
	if (ttl === undefined) return;
	sb.ttlSeconds = ttl;
	sb.deadlineAt =
		ttl === null || sb.state !== "ready"
			? null
			: new Date(Date.now() + ttl * 1000);
}

function mergeEnv(
	env: Record<string, string>,
	patch: Record<string, string | null> | undefined,
): void {
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (v === null) delete env[k];
		else env[k] = v;
	}
}

function uniqueSlug(fake: Fake, wanted: string | undefined, n: number): string {
	const taken = (s: string) =>
		[...fake.state.sandboxes.values()].some(
			(x) => x.slug === s && x.state !== "deleted",
		);
	if (wanted !== undefined) {
		if (!SLUG_RE.test(wanted)) {
			throw validation([
				{
					path: "slug",
					message: "lowercase letters, digits and dashes, 1-63 characters",
				},
			]);
		}
		if (taken(wanted)) {
			throw new FakeApiError(409, "slug_taken", `the slug ${wanted} is taken`);
		}
		return wanted;
	}
	let slug = `fake-box-${n}`;
	for (let i = 2; taken(slug); i++) slug = `fake-box-${n}-${i}`;
	return slug;
}

interface SpawnSpec {
	template: string;
	size: string;
	slug: string | undefined;
	name: string | null | undefined;
	labels: Record<string, string>;
	env: Record<string, string>;
	ttlSeconds: number | null | undefined;
	idleTimeoutSeconds: number | null | undefined;
	origin: FakeSandbox["origin"];
	/** Host directory whose files the new sandbox starts with. */
	copyFrom: string | null;
}

/** Makes a sandbox in `creating`, its `create` operation and the timer to `ready`. */
async function spawnSandbox(
	fake: Fake,
	p: FakePrincipal,
	spec: SpawnSpec,
): Promise<{ sandbox: FakeSandbox; operation: FakeOperation }> {
	const size = fake.state.sizes.find((s) => s.slug === spec.size);
	if (!size)
		throw new FakeApiError(
			422,
			"template_unavailable",
			`unknown size ${spec.size}`,
		);
	checkQuota(fake, p.teamId, size.memoryMb);
	const n = fake.state.sandboxes.size + 1;
	const slug = uniqueSlug(fake, spec.slug, n);
	const now = new Date();
	const sb: FakeSandbox = {
		id: fake.newId("sb"),
		slug,
		name: spec.name ?? null,
		teamId: p.teamId,
		createdBy: p.kind === "session" ? "usr_fake" : null,
		createdByKey: p.keyId ?? null,
		template: spec.template,
		size: spec.size,
		vcpu: size.vcpu,
		memoryMb: size.memoryMb,
		state: "creating",
		health: "ok",
		activity: "unknown",
		stopReason: null,
		error: null,
		origin: spec.origin,
		labels: spec.labels,
		env: spec.env,
		ttlSeconds: spec.ttlSeconds ?? null,
		deadlineAt: null,
		idleTimeoutSeconds: spec.idleTimeoutSeconds ?? null,
		activeOperationId: null,
		createdAt: now,
		readyAt: null,
		stoppedAt: null,
		deletedAt: null,
		updatedAt: now,
		seq: n,
	};
	fake.state.sandboxes.set(sb.id, sb);
	const fs = fake.state.fs(sb.id);
	await fs.init();
	if (spec.copyFrom !== null) {
		await cp(spec.copyFrom, fs.root, {
			recursive: true,
			verbatimSymlinks: true,
		});
	}
	const op = startOperation(fake, sb, "create", "booting");
	const fail = fake.script.createFails;
	delete fake.script.createFails;
	fake.later(fake.state.readyAfterMs, () => {
		if (sb.state !== "creating") return;
		if (fail) {
			sb.state = "error";
			sb.error = fail;
			sb.updatedAt = new Date();
			finishOperation(fake, op, "failed", { ...fail, retryable: false });
			return;
		}
		becomeReady(fake, sb, op);
	});
	return { sandbox: sb, operation: op };
}

function becomeReady(fake: Fake, sb: FakeSandbox, op: FakeOperation): void {
	const now = new Date();
	sb.state = "ready";
	sb.readyAt = now;
	sb.updatedAt = now;
	sb.activity = "idle";
	sb.error = null;
	sb.deadlineAt =
		sb.ttlSeconds === null
			? null
			: new Date(now.getTime() + sb.ttlSeconds * 1000);
	finishOperation(fake, op, "succeeded");
}

function checkTemplateAndSize(
	fake: Fake,
	templateSlug: string | undefined,
	sizeSlug: string | undefined,
): { template: string; size: string } {
	const t = templateOf(fake, templateSlug ?? "linux");
	if (!t?.enabled) {
		throw new FakeApiError(
			422,
			"template_unavailable",
			`template ${templateSlug ?? "linux"} is not available`,
		);
	}
	const size = sizeSlug ?? t.defaultSize;
	if (!t.allowedSizes.includes(size)) {
		throw new FakeApiError(
			422,
			"template_unavailable",
			`size ${size} is not allowed for template ${t.slug}; one of ${t.allowedSizes.join(", ")}`,
		);
	}
	return { template: t.slug, size };
}

/** Another operation is running: 409 operation_in_progress. */
function inProgress(op: FakeOperation): FakeApiError {
	return new FakeApiError(
		409,
		"operation_in_progress",
		`the sandbox already has a running '${op.kind}' operation; retry after it finishes`,
		{
			retryable: true,
			details: { operationId: op.id, kind: op.kind },
		},
	);
}

export function registerSandboxRoutes(app: FakeApp, fake: Fake): void {
	const { state } = fake;

	// --- account and catalog ---

	app.get("/v1/me", (c) => {
		const p = c.get("principal");
		const teamOf = (id: string) => ({
			id,
			name: `Team ${id}`,
			role: p.kind === "session" ? "owner" : null,
		});
		const team = teamOf(p.teamId);
		// A person's teams: the one of the request (selected by Umiak-Team) and the rest.
		const own = fake.tokens.get(c.get("token"));
		const teams =
			p.kind === "session" && own !== undefined
				? [own.teamId, ...(own.teams ?? [])].map(teamOf)
				: [team];
		const auth: Json = { kind: p.kind, scopes: p.scopes };
		if (p.keyId !== undefined) auth.apiKeyId = p.keyId;
		if (p.expiresAt !== undefined) auth.expiresAt = p.expiresAt;
		if (p.kind === "team_key") {
			auth.createdBy =
				p.userEmail === undefined
					? null
					: {
							id: "usr_creator",
							email: p.userEmail,
							active: true,
							member: true,
						};
		}
		return c.json({
			user:
				p.kind === "session"
					? {
							id: "usr_fake",
							email: p.userEmail ?? "user@example.com",
							name: null,
						}
					: null,
			team,
			teams,
			isOperator: false,
			auth,
		});
	});

	app.get("/v1/limits", (c) => {
		const teamId = c.get("principal").teamId;
		const remaining = remainingOf(fake, teamId);
		const smallest = Math.min(...state.sizes.map((s) => s.memoryMb));
		return c.json({
			quota: { ...fake.opts.quota },
			usage: usageOf(fake, teamId),
			remaining,
			canCreate: remaining.activeSandboxes > 0 && remaining.ramMb >= smallest,
			templates: state.templates.map((t) => ({
				slug: t.slug,
				enabled: t.enabled,
				defaultSize: t.defaultSize,
				sizes: t.allowedSizes.flatMap((slug) => {
					const s = state.sizes.find((x) => x.slug === slug);
					if (!s) return [];
					const reason = !t.enabled
						? "template_disabled"
						: remaining.activeSandboxes === 0
							? "quota_active_sandboxes"
							: remaining.ramMb < s.memoryMb
								? "quota_ram"
								: null;
					return [
						{
							slug,
							vcpu: s.vcpu,
							memoryMb: s.memoryMb,
							allowed: reason === null,
							reason,
						},
					];
				}),
			})),
			rateLimits: { requestsPerSecond: 20, burst: 100, startsPerMinute: 30 },
		});
	});

	app.get("/v1/templates", (c) =>
		c.json({
			data: state.templates.map((t) => ({
				slug: t.slug,
				name: t.name,
				os: t.os,
				enabled: t.enabled,
				defaultSize: t.defaultSize,
				allowedSizes: t.allowedSizes,
				loginUser: t.loginUser,
				capabilities: t.capabilities,
				version: t.version,
			})),
		}),
	);

	app.get("/v1/sizes", (c) => c.json({ data: state.sizes }));

	// --- sandboxes ---

	app.get("/v1/sandboxes", (c) => {
		const p = c.get("principal");
		const states = parseStates(c.req.query("state"), "query.state");
		const labels = new Map<string, string>();
		for (const item of c.req.queries("label") ?? []) {
			const eq = item.indexOf("=");
			if (eq <= 0)
				throw validation([
					{ path: "query.label", message: "must be key=value" },
				]);
			labels.set(item.slice(0, eq), item.slice(eq + 1));
		}
		const template = c.req.query("template");
		const q = c.req.query("q");
		const items = [...state.sandboxes.values()]
			.filter((sb) => sb.teamId === p.teamId)
			.filter((sb) =>
				states ? states.includes(sb.state) : sb.state !== "deleted",
			)
			.filter((sb) => [...labels].every(([k, v]) => sb.labels[k] === v))
			.filter((sb) => template === undefined || sb.template === template)
			.filter(
				(sb) =>
					q === undefined ||
					sb.slug.startsWith(q) ||
					(sb.name ?? "").startsWith(q),
			)
			.sort((a, b) => b.seq - a.seq);
		const page = paginate(items, {
			limit: limitOf(c, 50),
			cursor: c.req.query("cursor"),
			key: (sb) => sb.seq,
			dir: "desc",
		});
		return c.json({
			data: page.data.map((sb) => sandboxResource(fake, sb)),
			nextCursor: page.nextCursor,
		});
	});

	app.post("/v1/sandboxes", async (c) => {
		const p = c.get("principal");
		const body = (c.get("json") ?? {}) as Json;
		const from = body.from as { snapshot: string } | undefined;
		if (from !== undefined) checkScope(p, "snapshots:read");
		const environment = body.environment;
		if (typeof environment === "string") checkScope(p, "environments:read");
		if (body.excludeOwnerSecrets === true) {
			throw validation([
				{
					path: "excludeOwnerSecrets",
					message:
						"not available until environments store it on the sandbox; omit it or send false",
				},
			]);
		}
		const claim = claimIdempotency(fake, c, "sandboxes.create", body);
		if (claim?.replay) {
			const sb = state.sandboxes.get(
				claim.replay.sandboxId as string,
			) as FakeSandbox;
			const op = state.operations.get(
				claim.replay.operationId as string,
			) as FakeOperation;
			return c.json(
				{
					sandbox: sandboxResource(fake, sb),
					operation: operationResource(op),
				},
				202,
				{
					"Idempotency-Replayed": "true",
				},
			);
		}
		let templateSlug = body.template as string | undefined;
		let origin: FakeSandbox["origin"] = { kind: "template" };
		let copyFrom: string | null = null;
		if (from !== undefined) {
			const snap = [...state.snapshots.values()].find(
				(s) =>
					s.teamId === p.teamId &&
					s.name === from.snapshot &&
					s.state === "ready",
			);
			if (!snap) {
				throw new FakeApiError(
					404,
					"snapshot_not_found",
					`no ready snapshot named ${from.snapshot}`,
				);
			}
			templateSlug = snap.template ?? templateSlug;
			origin = { kind: "snapshot", snapshot: snap.name, snapshotId: snap.id };
			copyFrom = snap.dir;
		}
		if (
			typeof environment === "string" &&
			!state.environments.has(environment)
		) {
			throw notFound("environment");
		}
		const { template, size } = checkTemplateAndSize(
			fake,
			templateSlug,
			body.size as string | undefined,
		);
		const { sandbox, operation } = await spawnSandbox(fake, p, {
			template,
			size,
			slug: body.slug as string | undefined,
			name: body.name as string | null | undefined,
			labels: (body.labels as Record<string, string> | undefined) ?? {},
			env: {
				...(body.env as Record<string, string> | undefined),
				...(body.secrets as Record<string, string> | undefined),
			},
			ttlSeconds: body.ttlSeconds as number | null | undefined,
			idleTimeoutSeconds: body.idleTimeoutSeconds as number | null | undefined,
			origin,
			copyFrom,
		});
		claim?.save({ sandboxId: sandbox.id, operationId: operation.id });
		return c.json(
			{
				sandbox: sandboxResource(fake, sandbox),
				operation: operationResource(operation),
			},
			202,
		);
	});

	app.get("/v1/sandboxes/:sandbox", async (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"), {
			allowDeleted: true,
		});
		const waitFor = parseStates(c.req.query("waitFor"), "query.waitFor");
		if (waitFor !== undefined) {
			const seconds = Number(c.req.query("waitSeconds") ?? 30);
			const stop: SandboxState[] = [...waitFor, "error", "deleting", "deleted"];
			await longPoll(
				fake,
				() => stop.includes(sb.state),
				seconds,
				c.req.raw.signal,
			);
		}
		return c.json(sandboxResource(fake, sb));
	});

	app.patch("/v1/sandboxes/:sandbox", (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		if (sb.state === "deleting")
			throw invalidState(`sandbox ${sb.slug} is deleting`, { state: sb.state });
		const b = (c.get("json") ?? {}) as Json;
		if (b.slug !== undefined && b.slug !== sb.slug)
			sb.slug = uniqueSlug(fake, b.slug as string, sb.seq);
		if (b.name !== undefined) sb.name = b.name as string | null;
		if (b.labels !== undefined) sb.labels = b.labels as Record<string, string>;
		if (b.idleTimeoutSeconds !== undefined)
			sb.idleTimeoutSeconds = b.idleTimeoutSeconds as number | null;
		setTtl(sb, b.ttlSeconds as number | null | undefined);
		sb.updatedAt = new Date();
		fake.notify();
		return c.json(sandboxResource(fake, sb));
	});

	app.delete("/v1/sandboxes/:sandbox", (c) => {
		const p = c.get("principal");
		const sb = lookupSandbox(fake, p, c.req.param("sandbox"), {
			allowDeleted: true,
		});
		const confirm = c.req.header("Umiak-Confirm-Delete");
		if (confirm === undefined || (confirm !== sb.id && confirm !== sb.slug)) {
			throw new FakeApiError(
				428,
				"confirmation_required",
				`deleting needs the header Umiak-Confirm-Delete: ${sb.id}${confirm === undefined ? "" : ` (got ${confirm})`}`,
				{
					details: { reason: confirm === undefined ? "missing" : "mismatch" },
				},
			);
		}
		if (sb.state === "deleted") {
			return c.json(
				{ sandbox: sandboxResource(fake, sb), operation: null },
				200,
			);
		}
		let op = activeOperation(fake, sb);
		if (op?.kind !== "delete") {
			if (op) finishOperation(fake, op, "superseded");
			op = startOperation(fake, sb, "delete", "removing");
			sb.state = "deleting";
			sb.updatedAt = new Date();
			loseRunningCommands(fake, sb.id, null);
			const doomed = op;
			fake.later(state.readyAfterMs, () => {
				sb.state = "deleted";
				sb.deletedAt = new Date();
				sb.updatedAt = sb.deletedAt;
				sb.deadlineAt = null;
				void rm(fake.state.fs(sb.id).root, { recursive: true, force: true });
				finishOperation(fake, doomed, "succeeded");
			});
		}
		return c.json(
			{ sandbox: sandboxResource(fake, sb), operation: operationResource(op) },
			202,
		);
	});

	// --- lifecycle actions ---

	app.post("/v1/sandboxes/:sandbox/stop", (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const active = activeOperation(fake, sb);
		if (active) {
			if (active.kind !== "stop") throw inProgress(active);
			return c.json(
				{
					sandbox: sandboxResource(fake, sb),
					operation: operationResource(active),
				},
				202,
			);
		}
		if (sb.state !== "ready") {
			throw invalidState(
				`sandbox ${sb.slug} is ${sb.state}; only a ready sandbox can be stopped`,
				{ state: sb.state, event: "stop" },
			);
		}
		const op = startOperation(fake, sb, "stop", "shutting_down");
		sb.state = "stopping";
		sb.stopReason = "user";
		sb.updatedAt = new Date();
		fake.later(state.readyAfterMs, () => {
			sb.state = "stopped";
			sb.stoppedAt = new Date();
			sb.updatedAt = sb.stoppedAt;
			sb.activity = "unknown";
			sb.deadlineAt = null;
			loseRunningCommands(fake, sb.id, null);
			finishOperation(fake, op, "succeeded");
		});
		return c.json(
			{ sandbox: sandboxResource(fake, sb), operation: operationResource(op) },
			202,
		);
	});

	app.post("/v1/sandboxes/:sandbox/resume", (c) => {
		const p = c.get("principal");
		const sb = lookupSandbox(fake, p, c.req.param("sandbox"));
		const b = (c.get("json") ?? {}) as Json;
		const active = activeOperation(fake, sb);
		if (active) {
			if (active.kind !== "resume") throw inProgress(active);
			return c.json(
				{
					sandbox: sandboxResource(fake, sb),
					operation: operationResource(active),
				},
				202,
			);
		}
		if (sb.state !== "stopped" && sb.state !== "error") {
			throw invalidState(
				`sandbox ${sb.slug} is ${sb.state}; only a stopped sandbox can be resumed`,
				{ state: sb.state, event: "resume" },
			);
		}
		if (b.size !== undefined) {
			const t = templateOf(fake, sb.template);
			const size = state.sizes.find((s) => s.slug === b.size);
			if (!t || !size || !t.allowedSizes.includes(size.slug)) {
				throw new FakeApiError(
					422,
					"template_unavailable",
					`size ${String(b.size)} is not allowed for template ${sb.template}`,
				);
			}
			checkQuota(fake, p.teamId, size.memoryMb);
			sb.size = size.slug;
			sb.vcpu = size.vcpu;
			sb.memoryMb = size.memoryMb;
		} else {
			checkQuota(fake, p.teamId, sb.memoryMb);
		}
		mergeEnv(sb.env, {
			...(b.env as Record<string, string | null> | undefined),
			...(b.secrets as Record<string, string | null> | undefined),
		});
		if (b.ttlSeconds !== undefined)
			sb.ttlSeconds = b.ttlSeconds as number | null;
		const op = startOperation(fake, sb, "resume", "booting");
		sb.state = "starting";
		sb.stopReason = null;
		sb.updatedAt = new Date();
		fake.later(state.readyAfterMs, () => {
			sb.stoppedAt = null;
			becomeReady(fake, sb, op);
		});
		return c.json(
			{ sandbox: sandboxResource(fake, sb), operation: operationResource(op) },
			202,
		);
	});

	app.post("/v1/sandboxes/:sandbox/recover", (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const active = activeOperation(fake, sb);
		if (active) {
			if (active.kind !== "recover") throw inProgress(active);
			return c.json(
				{
					sandbox: sandboxResource(fake, sb),
					operation: operationResource(active),
				},
				202,
			);
		}
		if (sb.state !== "ready" && sb.state !== "error") {
			throw invalidState(
				`sandbox ${sb.slug} is ${sb.state}; only a ready or failed sandbox can be recovered`,
				{ state: sb.state, event: "recover" },
			);
		}
		const op = startOperation(fake, sb, "recover", "rebooting");
		sb.state = "starting";
		sb.updatedAt = new Date();
		loseRunningCommands(fake, sb.id, "reboot");
		fake.later(state.readyAfterMs, () => becomeReady(fake, sb, op));
		return c.json(
			{ sandbox: sandboxResource(fake, sb), operation: operationResource(op) },
			202,
		);
	});

	app.post("/v1/sandboxes/:sandbox/fork", async (c) => {
		const p = c.get("principal");
		const src = lookupSandbox(fake, p, c.req.param("sandbox"));
		const b = (c.get("json") ?? {}) as Json;
		const claim = claimIdempotency(fake, c, "sandboxes.fork", {
			sandbox: src.id,
			body: b,
		});
		if (claim?.replay) {
			const sb = state.sandboxes.get(
				claim.replay.sandboxId as string,
			) as FakeSandbox;
			const op = state.operations.get(
				claim.replay.operationId as string,
			) as FakeOperation;
			const source = state.operations.get(
				claim.replay.sourceOperationId as string,
			) as FakeOperation;
			return c.json(
				{
					sandbox: sandboxResource(fake, sb),
					operation: operationResource(op),
					sourceOperation: operationResource(source),
				},
				202,
				{ "Idempotency-Replayed": "true" },
			);
		}
		const active = activeOperation(fake, src);
		if (active) throw inProgress(active);
		if (src.state !== "ready" && src.state !== "stopped") {
			throw invalidState(
				`sandbox ${src.slug} is ${src.state}; only a ready or stopped sandbox can be forked`,
				{ state: src.state, event: "fork" },
			);
		}
		const forced = forceStopFor(fake, src, "fork", b.forceStop);
		const { template, size } = checkTemplateAndSize(
			fake,
			src.template,
			(b.size as string | undefined) ?? src.size,
		);
		const env = { ...src.env };
		mergeEnv(env, {
			...(b.env as Record<string, string | null> | undefined),
			...(b.secrets as Record<string, string | null> | undefined),
		});
		const { sandbox, operation } = await spawnSandbox(fake, p, {
			template,
			size,
			slug: b.slug as string | undefined,
			name: b.name as string | null | undefined,
			labels: (b.labels as Record<string, string> | undefined) ?? {},
			env,
			ttlSeconds: b.ttlSeconds as number | null | undefined,
			idleTimeoutSeconds: b.idleTimeoutSeconds as number | null | undefined,
			origin: { kind: "fork", sandboxId: src.id },
			copyFrom: state.fs(src.id).root,
		});
		const sourceOp = startOperation(fake, src, "fork", "copying");
		if (forced) {
			sourceOp.forceStop = {
				sourceStopped: false,
				sourceRestarted: null,
				restartError: null,
			};
		}
		fake.later(state.readyAfterMs, () => {
			if (forced) markForceStopped(fake, sourceOp, src);
			finishOperation(fake, sourceOp, "succeeded");
		});
		claim?.save({
			sandboxId: sandbox.id,
			operationId: operation.id,
			sourceOperationId: sourceOp.id,
		});
		return c.json(
			{
				sandbox: sandboxResource(fake, sandbox),
				operation: operationResource(operation),
				sourceOperation: operationResource(sourceOp),
			},
			202,
		);
	});

	// --- operations ---

	app.get("/v1/operations/:operation", async (c) => {
		const p = c.get("principal");
		const op = state.operations.get(c.req.param("operation"));
		const sb = op ? state.sandboxes.get(op.sandboxId) : undefined;
		if (!op || !sb || sb.teamId !== p.teamId) throw notFound("operation");
		const seconds = Number(c.req.query("waitSeconds") ?? 0);
		if (seconds > 0) {
			await longPoll(
				fake,
				() => op.state !== "pending" && op.state !== "running",
				seconds,
				c.req.raw.signal,
			);
		}
		return c.json(operationResource(op));
	});
}
