// AgentEventsRequest (S2 §9.6, @sbx/proto) to the batch of core's
// ingestAgentEvents (S6 §10.1). Payloads are google.protobuf.Any of S3/S6
// types (plan decision 4): JSON-compatible ones (Struct, Value, ListValue)
// are decoded to JSON; the agent's own types are not linked yet (S3), so
// their payload is stored as {"@type": typeUrl} until the S3 registry lands.
import { createRegistry, type DescMessage, toJson } from "@bufbuild/protobuf";
import {
	type Any,
	anyIs,
	anyUnpack,
	ListValueSchema,
	StructSchema,
	type Timestamp,
	timestampDate,
	ValueSchema,
} from "@bufbuild/protobuf/wkt";
import type { AgentEventBatch } from "@sbx/core";
import type { AgentEventsRequest } from "@sbx/proto";
import { type Issue, validationError } from "../http/errors.ts";

const JSON_PAYLOADS: DescMessage[] = [
	StructSchema,
	ValueSchema,
	ListValueSchema,
];

/** Types that protojson request bodies may carry in `Any`. */
export const AGENT_EVENT_PAYLOAD_REGISTRY = createRegistry(...JSON_PAYLOADS);

/** The payload as JSON; {} when absent; {"@type"} when unknown or corrupt. */
export function decodePayload(any: Any | undefined): unknown {
	if (any === undefined || (any.typeUrl === "" && any.value.length === 0)) {
		return {};
	}
	for (const schema of JSON_PAYLOADS) {
		if (anyIs(any, schema)) {
			// A corrupt payload must not fail the batch: the gateway retries
			// any non-2xx forever and the machine's events would stall.
			try {
				const m = anyUnpack(any, schema);
				if (m !== undefined) return toJson(schema, m);
			} catch {
				break;
			}
		}
	}
	return { "@type": any.typeUrl };
}

/** A uint64 as a safe integer, or an issue. */
function safe(v: bigint, path: string, issues: Issue[]): number {
	if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
		issues.push({ path, message: "must be at most 2^53 - 1" });
		return 0;
	}
	return Number(v);
}

/** Missing timestamps stay invalid, so core reports them. */
function time(t: Timestamp | undefined): Date | string {
	return t === undefined ? "" : timestampDate(t);
}

/**
 * Throws 400 validation for what core cannot see: a seq or epoch beyond
 * 2^53, a connection event of another machine. Core validates the rest.
 */
export function decodeAgentEvents(req: AgentEventsRequest): AgentEventBatch {
	const issues: Issue[] = [];
	const events = req.events.map((e, i) => ({
		seq: safe(e.seq, `events[${i}].seq`, issues),
		bootId: e.bootId,
		type: e.type,
		time: time(e.time),
		payload: decodePayload(e.payload),
	}));
	const synthetic = req.connectionEvents.map((e, i) => {
		if (e.machineId !== "" && e.machineId !== req.machineId) {
			issues.push({
				path: `connectionEvents[${i}].machineId`,
				message: "must be the machineId of the request",
			});
		}
		return {
			epoch: safe(e.epoch, `connectionEvents[${i}].epoch`, issues),
			// Core checks the type against the S2 set.
			type: e.type as AgentEventBatch["synthetic"][number]["type"],
			instanceId: e.instanceId,
			time: time(e.time),
		};
	});
	if (issues.length > 0) throw validationError(issues);
	return { machineId: req.machineId, events, synthetic };
}
