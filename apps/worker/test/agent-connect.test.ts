import { randomUUID } from "node:crypto";
import {
	Code,
	ConnectError,
	createRouterTransport,
	type ServiceImpl,
} from "@connectrpc/connect";
import {
	AgentClient,
	HEADER_REQUEST_ID,
	type Registry,
	type Route,
} from "@sbx/agent-client";
import { ErrorDetailSchema } from "@sbx/proto";
import { ClaimReason, System } from "@sbx/proto/agent/v1";
import { describe, expect, it } from "vitest";
import {
	ConnectAgentPort,
	parseCaKeys,
} from "../src/adapters/agent-connect.ts";
import { QuiesceFailed } from "../src/ops/snapshot-step.ts";
import { AgentRejected, AgentUnavailable } from "../src/ports.ts";

const machineId = randomUUID();

/** Registry that always routes the machine to one (unused) instance URL. */
class StaticRegistry implements Registry {
	async lookup(id: string): Promise<Route | undefined> {
		return {
			machineId: id,
			instanceId: "gw-1",
			internalUrl: "http://gateway.test",
			epoch: 1n,
			capabilities: [],
		};
	}
	async isLiveInstance(): Promise<boolean> {
		return true;
	}
	invalidate(): void {}
	async waitForChange(): Promise<void> {}
	async close(): Promise<void> {}
}

type SystemImpl = Partial<ServiceImpl<typeof System>>;

function portFor(
	impl: SystemImpl,
	opts: ConstructorParameters<typeof ConnectAgentPort>[1] = {},
): ConnectAgentPort {
	const client = new AgentClient({
		registry: new StaticRegistry(),
		serviceToken: "svc",
		waitForAgentMs: 50,
		pollIntervalMs: 10,
		maxAttempts: 2,
		createTransport: () =>
			createRouterTransport(({ service }) => service(System, impl)),
	});
	return new ConnectAgentPort(client, opts);
}

function detailed(code: Code, detail: string, retryable = false): ConnectError {
	return new ConnectError(`agent said ${detail}`, code, undefined, [
		{ desc: ErrorDetailSchema, value: { code: detail, retryable } },
	]);
}

describe("ConnectAgentPort", () => {
	it("claim maps fields (TestClaimMapsFields)", async () => {
		const seen: { req?: unknown; requestId?: string | null } = {};
		const port = portFor({
			async claim(req, ctx) {
				seen.req = req;
				seen.requestId = ctx.requestHeader.get(HEADER_REQUEST_ID);
				return { ready: true };
			},
		});
		await port.claim(
			machineId,
			{
				reason: "claim",
				sandboxId: "sbx-1",
				hostname: "box",
				env: { A: "1" },
				secretEnv: { S: "x" },
				secretFiles: [
					{
						name: "plain",
						contentBase64: Buffer.from("hello").toString("base64"),
					},
					{
						name: "tuned",
						contentBase64: Buffer.from([0, 255, 7]).toString("base64"),
						mode: 0o600,
						linkPath: "/etc/tuned",
					},
				],
				authorizedKeys: ["ssh-ed25519 AAAA"],
			},
			"req-claim-1",
		);
		expect(seen.requestId).toBe("req-claim-1");
		const req = seen.req as {
			reason: ClaimReason;
			sandboxId: string;
			hostname: string;
			env: Record<string, string>;
			secretEnv: Record<string, string>;
			authorizedKeys: string[];
			secretFiles: {
				name: string;
				content: Uint8Array;
				mode: number;
				linkPath: string;
			}[];
		};
		expect(req.reason).toBe(ClaimReason.CLAIM);
		expect(req.sandboxId).toBe("sbx-1");
		expect(req.hostname).toBe("box");
		expect(req.env).toEqual({ A: "1" });
		expect(req.secretEnv).toEqual({ S: "x" });
		expect(req.authorizedKeys).toEqual(["ssh-ed25519 AAAA"]);
		const [plain, tuned] = req.secretFiles;
		expect(Buffer.from(plain?.content ?? []).toString()).toBe("hello");
		expect(plain?.mode).toBe(0o440);
		expect(plain?.linkPath).toBe("");
		expect([...(tuned?.content ?? [])]).toEqual([0, 255, 7]);
		expect(tuned?.mode).toBe(0o600);
		expect(tuned?.linkPath).toBe("/etc/tuned");
		// Without the worker settings both fields stay empty.
		expect((seen.req as { portDomain: string }).portDomain).toBe("");
		expect((seen.req as { sshUserCaKeys: string[] }).sshUserCaKeys).toEqual([]);
	});

	it("claim carries the port domain and the SSH user CA keys", async () => {
		const seen: { portDomain?: string; sshUserCaKeys?: string[] }[] = [];
		const port = portFor(
			{
				async claim(req) {
					seen.push({
						portDomain: req.portDomain,
						sshUserCaKeys: req.sshUserCaKeys,
					});
					return { ready: true };
				},
			},
			{
				portDomain: "sbx.example.com",
				sshUserCaKeys: ["ssh-ed25519 AAAA ca-1", "ssh-ed25519 BBBB ca-2"],
			},
		);
		const req = {
			reason: "claim" as const,
			sandboxId: "sbx-1",
			hostname: "box",
			env: {},
			secretEnv: {},
			secretFiles: [],
			authorizedKeys: [],
		};
		await port.claim(machineId, req, "r1");
		await port.claim(machineId, req, "r2");
		expect(seen).toEqual([
			{
				portDomain: "sbx.example.com",
				sshUserCaKeys: ["ssh-ed25519 AAAA ca-1", "ssh-ed25519 BBBB ca-2"],
			},
			{
				portDomain: "sbx.example.com",
				sshUserCaKeys: ["ssh-ed25519 AAAA ca-1", "ssh-ed25519 BBBB ca-2"],
			},
		]);
	});

	it("updateSshCa sends the configured SSH user CA keys with the request id", async () => {
		const seen: { id: string | null; keys: string[] }[] = [];
		const impl: SystemImpl = {
			async updateSshCa(req, ctx) {
				seen.push({
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					keys: req.keys,
				});
				return {};
			},
		};
		await portFor(impl, {
			sshUserCaKeys: ["ssh-ed25519 AAAA ca-1", "ssh-ed25519 BBBB ca-2"],
		}).updateSshCa(machineId, "r1");
		// Without the worker setting the list is empty: the agent restores the
		// template keys, as for a claim without keys.
		await portFor(impl).updateSshCa(machineId, "r2");
		expect(seen).toEqual([
			{ id: "r1", keys: ["ssh-ed25519 AAAA ca-1", "ssh-ed25519 BBBB ca-2"] },
			{ id: "r2", keys: [] },
		]);
	});

	it("parseCaKeys keeps key lines and drops blanks and comments", () => {
		expect(
			parseCaKeys(
				"# user CA\nssh-ed25519 AAAA ca-1\n\n  ssh-rsa BBBB ca-2  \r\n",
			),
		).toEqual(["ssh-ed25519 AAAA ca-1", "ssh-rsa BBBB ca-2"]);
	});

	it("updateEnv, updateSecrets and prepareStop reach the agent", async () => {
		const calls: { m: string; id: string | null; body: unknown }[] = [];
		const port = portFor({
			async updateEnv(req, ctx) {
				calls.push({
					m: "updateEnv",
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					body: req.env,
				});
				return {};
			},
			async updateSecrets(req, ctx) {
				calls.push({
					m: "updateSecrets",
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					body: [req.secretEnv, req.secretFiles.map((f) => f.mode)],
				});
				return {};
			},
			async prepareStop(_req, ctx) {
				calls.push({
					m: "prepareStop",
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					body: null,
				});
				return {};
			},
		});
		await port.updateEnv(machineId, { K: "v" }, "r1");
		await port.updateSecrets(
			machineId,
			{
				secretEnv: { S: "1" },
				secretFiles: [{ name: "f", contentBase64: "" }],
			},
			"r2",
		);
		await port.prepareStop(machineId);
		expect(calls).toEqual([
			{ m: "updateEnv", id: "r1", body: { K: "v" } },
			{ m: "updateSecrets", id: "r2", body: [{ S: "1" }, [0o440]] },
			{ m: "prepareStop", id: null, body: null },
		]);
	});

	it("quiesce hook round trip (TestQuiesceHookRoundTrip)", async () => {
		const quiesces: { id: string | null; leaseMs: number | undefined }[] = [];
		const thaws: { id: string | null; leaseId: string }[] = [];
		let freezeFailures = 1;
		const port = portFor({
			async quiesce(req, ctx) {
				quiesces.push({
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					leaseMs: req.leaseMs,
				});
				if (freezeFailures-- > 0) throw detailed(Code.Internal, "boom");
				return { leaseId: "lease-7" };
			},
			async thaw(req, ctx) {
				thaws.push({
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					leaseId: req.leaseId,
				});
				return {};
			},
		});
		const hook = port.quiesceHook(machineId, 30_000);
		// Thaw before any freeze does nothing.
		await hook.thaw();
		expect(thaws).toEqual([]);

		await expect(hook.freeze()).rejects.toBeInstanceOf(AgentRejected);
		await hook.freeze();
		await hook.thaw();

		expect(quiesces).toHaveLength(2);
		expect(quiesces[0]?.leaseMs).toBe(30_000);
		expect(quiesces[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(quiesces[1]?.id).toBe(quiesces[0]?.id);
		expect(thaws).toHaveLength(1);
		expect(thaws[0]?.leaseId).toBe("lease-7");
		expect(thaws[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(thaws[0]?.id).not.toBe(quiesces[0]?.id);

		// Another hook gets its own request ids.
		const other = port.quiesceHook(machineId, 30_000);
		await other.freeze();
		expect(quiesces[2]?.id).not.toBe(quiesces[0]?.id);
	});

	it("thaw of an auto-thawed lease rejects (TestThawAutoThawedRejects)", async () => {
		let thaws = 0;
		const port = portFor({
			async quiesce() {
				return { leaseId: "lease-9" };
			},
			async thaw() {
				thaws++;
				return {
					autoThawed: true,
					autoThawedAt: { seconds: 1_700_000_000n, nanos: 0 },
				};
			},
		});
		const hook = port.quiesceHook(machineId, 1000);
		await hook.freeze();
		const err = await hook.thaw().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(QuiesceFailed);
		expect((err as Error).message).toContain("lease-9");
		expect((err as Error).message).toContain("2023-11-14T22:13:20.000Z");
		// Retries of a failed thaw (S1 retries three times) keep the outcome.
		for (let i = 0; i < 2; i++) {
			await expect(hook.thaw()).rejects.toBeInstanceOf(QuiesceFailed);
		}
		expect(thaws).toBe(1);
	});

	it("thaw after a freeze with a lost response thaws the active lease", async () => {
		const thaws: string[] = [];
		let infos = 0;
		const port = portFor({
			async quiesce() {
				// The agent took the lease, the response never arrived.
				throw new ConnectError("lost", Code.Unavailable);
			},
			async info() {
				infos++;
				return { quiesce: { active: true, leaseId: "lease-lost" } };
			},
			async thaw(req) {
				thaws.push(req.leaseId);
				return {};
			},
		});
		const hook = port.quiesceHook(machineId, 1000);
		await expect(hook.freeze()).rejects.toBeInstanceOf(AgentUnavailable);
		await hook.thaw();
		expect(infos).toBe(1);
		expect(thaws).toEqual(["lease-lost"]);
	});

	it("thaw after a rejected or lost freeze without an active lease does nothing", async () => {
		let thaws = 0;
		let infos = 0;
		let freezeError = new ConnectError("lost", Code.Unavailable);
		const port = portFor({
			async quiesce() {
				throw freezeError;
			},
			async info() {
				infos++;
				return { quiesce: { active: false } };
			},
			async thaw() {
				thaws++;
				return {};
			},
		});
		const lost = port.quiesceHook(machineId, 1000);
		await expect(lost.freeze()).rejects.toBeInstanceOf(AgentUnavailable);
		await lost.thaw();
		expect(infos).toBe(1);

		// A rejected freeze took no lease: no lookup at all.
		freezeError = detailed(Code.FailedPrecondition, "quiesced");
		const rejected = port.quiesceHook(machineId, 1000);
		await expect(rejected.freeze()).rejects.toBeInstanceOf(AgentRejected);
		await rejected.thaw();
		expect(infos).toBe(1);
		expect(thaws).toBe(0);
	});

	it("a thaw that did not reach the agent is retried with the same ids", async () => {
		const thaws: { id: string | null; leaseId: string }[] = [];
		// AgentClient retries Unavailable itself: stay down until the first
		// port-level call has failed.
		let down = true;
		const port = portFor({
			async quiesce() {
				return { leaseId: "lease-3" };
			},
			async thaw(req, ctx) {
				thaws.push({
					id: ctx.requestHeader.get(HEADER_REQUEST_ID),
					leaseId: req.leaseId,
				});
				if (down) throw new ConnectError("down", Code.Unavailable);
				return {};
			},
		});
		const hook = port.quiesceHook(machineId, 1000);
		await hook.freeze();
		await expect(hook.thaw()).rejects.toBeInstanceOf(AgentUnavailable);
		down = false;
		await hook.thaw();
		const reached = thaws.length;
		// The clean outcome is kept too: no further Thaw RPC.
		await hook.thaw();
		// The client's own retry of the failed attempt and the port-level retry
		// all carry the same lease and request id.
		expect(thaws).toHaveLength(reached);
		expect(thaws.length).toBeGreaterThanOrEqual(2);
		expect(new Set(thaws.map((t) => `${t.id}/${t.leaseId}`)).size).toBe(1);
		expect(thaws[0]?.leaseId).toBe("lease-3");
	});

	it("maps errors (TestErrorMapping)", async () => {
		const failWith = (e: ConnectError) =>
			portFor({
				async prepareStop() {
					throw e;
				},
			}).prepareStop(machineId);

		const unavailable = await failWith(
			new ConnectError("down", Code.Unavailable),
		).catch((e: unknown) => e);
		expect(unavailable).toBeInstanceOf(AgentUnavailable);

		const rejected = await failWith(
			detailed(Code.FailedPrecondition, "already_claimed"),
		).catch((e: unknown) => e);
		expect(rejected).toBeInstanceOf(AgentRejected);
		expect((rejected as AgentRejected).code).toBe("already_claimed");

		const notReady = await failWith(
			detailed(Code.Unavailable, "identity_not_ready", true),
		).catch((e: unknown) => e);
		expect(notReady).toBeInstanceOf(AgentUnavailable);

		const retryableDetail = await failWith(
			detailed(Code.FailedPrecondition, "identity_not_ready", true),
		).catch((e: unknown) => e);
		expect(retryableDetail).toBeInstanceOf(AgentUnavailable);

		const plain = await failWith(
			new ConnectError("nope", Code.InvalidArgument),
		).catch((e: unknown) => e);
		expect(plain).toBeInstanceOf(AgentRejected);
		expect((plain as AgentRejected).code).toBe("invalid_argument");

		const late = await failWith(
			new ConnectError("slow", Code.DeadlineExceeded),
		).catch((e: unknown) => e);
		expect(late).toBeInstanceOf(AgentUnavailable);
	});

	it("maps a machine without a route to AgentUnavailable", async () => {
		const client = new AgentClient({
			registry: new (class extends StaticRegistry {
				override async lookup(): Promise<Route | undefined> {
					return undefined;
				}
			})(),
			serviceToken: "svc",
			waitForAgentMs: 30,
			pollIntervalMs: 10,
			createTransport: () => createRouterTransport(() => {}),
		});
		const port = new ConnectAgentPort(client);
		await expect(port.prepareStop(machineId)).rejects.toBeInstanceOf(
			AgentUnavailable,
		);
	});

	it("maps activity (TestActivity)", async () => {
		const port = portFor({
			async activity() {
				return {
					runningCommands: 3,
					openPtys: 2,
					tcpStreams: 5,
					attachStreams: 9,
				};
			},
		});
		await expect(port.activity(machineId)).resolves.toEqual({
			runningCommands: 3,
			openPtys: 2,
			tcpStreams: 5,
		});
	});
});
