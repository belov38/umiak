// Agent events intake (S7 §12.1, S6 §10.1, S2 §9.6; plan decision 4): the
// gateway posts binary AgentEventsRequest, the api stores the batch through
// core and answers AgentEventsResponse {ackedSeq} in the request's format.
import { randomUUID } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	anyPack,
	StructSchema,
	timestampFromDate,
	ValueSchema,
} from "@bufbuild/protobuf/wkt";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import {
	type AgentEventsRequest,
	AgentEventsRequestSchema,
	AgentEventsResponseSchema,
	ConnectionEventSchema,
	EventSchema,
} from "@sbx/proto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTokens } from "../src/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: internal answers are not in the document
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const GW = "gw-token-events-0123456789abcdef";
const PATH = "/internal/v1/agent-events";
const PROTO = "application/proto";
const T0 = new Date("2026-10-30T10:00:00.000Z");

describe.skipIf(skipPg())("POST /internal/v1/agent-events", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness({
			listener: "internal",
			bearer: GW,
			deps: { serviceTokens: new ServiceTokens({ gateway: [GW] }) },
		});
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	function event(seq: number, type: string, payload?: Record<string, unknown>) {
		return create(EventSchema, {
			seq: BigInt(seq),
			time: timestampFromDate(T0),
			bootId: "boot-1",
			type,
			...(payload === undefined
				? {}
				: {
						payload: anyPack(
							StructSchema,
							create(StructSchema, {
								fields: Object.fromEntries(
									Object.entries(payload).map(([k, v]) => [
										k,
										create(ValueSchema, {
											kind:
												typeof v === "number"
													? { case: "numberValue", value: v }
													: { case: "stringValue", value: String(v) },
										}),
									]),
								),
							}),
						),
					}),
		});
	}

	function batch(machineId: string): AgentEventsRequest {
		return create(AgentEventsRequestSchema, {
			machineId,
			events: [
				event(1, "activity", { runningCommands: 2, openPtys: 0 }),
				event(2, "sbx.tunnel.event_too_large"),
				create(EventSchema, {
					seq: 3n,
					time: timestampFromDate(T0),
					bootId: "boot-1",
					type: "s3.only",
					payload: {
						typeUrl: "type.googleapis.com/sbx.agent.v1.Unknown",
						value: new Uint8Array([8, 1]),
					},
				}),
			],
		});
	}

	const postProto = (
		req: AgentEventsRequest,
		headers: Record<string, string> = {},
	) =>
		h.request("POST", PATH, {
			headers: { "content-type": PROTO, ...headers },
			body: toBinary(AgentEventsRequestSchema, req),
		});

	async function rows(machineId: string) {
		const r = await db.pool.query(
			"SELECT seq::int AS seq, boot_id, type, time, payload FROM runtime.agent_events WHERE machine_id = $1 ORDER BY seq",
			[machineId],
		);
		return r.rows;
	}

	it("a binary batch of 3 events: ackedSeq 3 in binary; a repeat keeps the same rows", async () => {
		const machineId = randomUUID();
		w.env.jobs.clear();
		const r = await postProto(batch(machineId));
		expect(r.status, r.text).toBe(200);
		expect(r.headers.get("content-type")).toBe(PROTO);
		expect(fromBinary(AgentEventsResponseSchema, r.bytes).ackedSeq).toBe(3n);
		const stored = await rows(machineId);
		expect(stored).toEqual([
			{
				seq: 1,
				boot_id: "boot-1",
				type: "activity",
				time: T0,
				payload: { runningCommands: 2, openPtys: 0 },
			},
			{
				seq: 2,
				boot_id: "boot-1",
				type: "sbx.tunnel.event_too_large",
				time: T0,
				payload: {},
			},
			{
				seq: 3,
				boot_id: "boot-1",
				type: "s3.only",
				time: T0,
				payload: { "@type": "type.googleapis.com/sbx.agent.v1.Unknown" },
			},
		]);
		expect(w.env.jobs.sent).toEqual([
			{
				queue: "machine-events",
				data: { machineId },
				opts: { singletonKey: machineId },
			},
		]);

		const again = await postProto(batch(machineId));
		expect(again.status).toBe(200);
		expect(fromBinary(AgentEventsResponseSchema, again.bytes).ackedSeq).toBe(
			3n,
		);
		expect(await rows(machineId)).toEqual(stored);
	});

	it("a protojson request gets a protojson answer", async () => {
		const machineId = randomUUID();
		const ev = (seq: number, payload?: unknown) => ({
			seq: String(seq),
			time: T0.toISOString(),
			bootId: "boot-1",
			type: "activity",
			...(payload === undefined ? {} : { payload }),
		});
		const r = await h.request("POST", PATH, {
			json: {
				machineId,
				events: [
					ev(1, {
						"@type": "type.googleapis.com/google.protobuf.Struct",
						value: { runningCommands: 2 },
					}),
					ev(2),
					ev(3, {
						"@type": "type.googleapis.com/google.protobuf.Value",
						value: "x",
					}),
				],
			},
		});
		expect(r.status, r.text).toBe(200);
		expect(r.headers.get("content-type")).toMatch(/^application\/json/);
		expect(body(r)).toEqual({ ackedSeq: "3" });
		const stored = await rows(machineId);
		expect(stored.map((e) => e.payload)).toEqual([
			{ runningCommands: 2 },
			{},
			"x",
		]);
	});

	it("connection events go to the synthetic events; ackedSeq 0 without guest events", async () => {
		const machineId = randomUUID();
		const req = create(AgentEventsRequestSchema, {
			machineId,
			connectionEvents: [
				create(ConnectionEventSchema, {
					machineId,
					epoch: 4n,
					type: "connected",
					time: timestampFromDate(T0),
					instanceId: "gw-1",
					agentInstanceId: "agent-9",
				}),
			],
		});
		const r = await postProto(req);
		expect(r.status, r.text).toBe(200);
		expect(fromBinary(AgentEventsResponseSchema, r.bytes).ackedSeq).toBe(0n);
		const s = await db.pool.query(
			"SELECT epoch::int AS epoch, type, instance_id, time FROM runtime.agent_synthetic_events WHERE machine_id = $1",
			[machineId],
		);
		expect(s.rows).toEqual([
			{ epoch: 4, type: "connected", instance_id: "gw-1", time: T0 },
		]);
	});

	it("bad input is 400 validation: garbage bytes, another content type, a bad machine id, a seq beyond 2^53, a foreign connection event", async () => {
		const machineId = randomUUID();
		const cases: { name: string; init: Parameters<Harness["request"]>[2] }[] = [
			{
				name: "garbage",
				init: {
					headers: { "content-type": PROTO },
					body: new Uint8Array([0xff, 0xff, 0xff]),
				},
			},
			{
				name: "text/plain",
				init: {
					headers: { "content-type": "text/plain" },
					body: toBinary(AgentEventsRequestSchema, batch(machineId)),
				},
			},
			{
				name: "machine id",
				init: {
					headers: { "content-type": PROTO },
					body: toBinary(AgentEventsRequestSchema, batch("not-a-uuid")),
				},
			},
			{
				name: "seq",
				init: {
					headers: { "content-type": PROTO },
					body: toBinary(
						AgentEventsRequestSchema,
						create(AgentEventsRequestSchema, {
							machineId,
							events: [
								create(EventSchema, {
									seq: 2n ** 60n,
									time: timestampFromDate(T0),
									bootId: "b",
									type: "x",
								}),
							],
						}),
					),
				},
			},
			{
				name: "foreign connection event",
				init: {
					headers: { "content-type": PROTO },
					body: toBinary(
						AgentEventsRequestSchema,
						create(AgentEventsRequestSchema, {
							machineId,
							connectionEvents: [
								create(ConnectionEventSchema, {
									machineId: randomUUID(),
									epoch: 1n,
									type: "connected",
									time: timestampFromDate(T0),
									instanceId: "gw-1",
								}),
							],
						}),
					),
				},
			},
		];
		for (const c of cases) {
			const r = await h.request("POST", PATH, c.init);
			expect(r.status, c.name).toBe(400);
			expect(body(r).code, c.name).toBe("validation");
		}
		expect(await rows(machineId)).toEqual([]);
	});

	it("needs a service token", async () => {
		const r = await h.request("POST", PATH, {
			headers: { "content-type": PROTO, authorization: "Bearer nope" },
			body: toBinary(AgentEventsRequestSchema, batch(randomUUID())),
		});
		expect(r.status).toBe(401);
	});
});
