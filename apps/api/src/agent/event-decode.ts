// AgentEventsRequest (S2 §9.6, @umiak/proto) to the batch of core's
// ingestAgentEvents (S6 §10.1). Payloads are google.protobuf.Any: the S3
// event messages (umiak.agent.v1, events.proto and the messages they embed)
// and JSON-compatible ones (Struct, Value, ListValue) are decoded to
// protojson with zero values emitted (an exit code 0 or zero running
// commands is data), which core's normalizeAgentEvent reads. Other types
// are stored as {"@type": typeUrl}.
import {
	createRegistry,
	type DescMessage,
	type Registry,
	toJson,
} from "@bufbuild/protobuf";
import {
	type Any,
	anyUnpack,
	ListValueSchema,
	StructSchema,
	type Timestamp,
	timestampDate,
	ValueSchema,
} from "@bufbuild/protobuf/wkt";
import type { AgentEventBatch } from "@umiak/core";
import type { AgentEventsRequest } from "@umiak/proto";
import {
	file_umiak_agent_v1_common,
	file_umiak_agent_v1_events,
} from "@umiak/proto/agent/v1";
import { type Issue, validationError } from "../http/errors.ts";

const JSON_PAYLOADS: DescMessage[] = [
	StructSchema,
	ValueSchema,
	ListValueSchema,
];

/** Types that event payloads (binary Any or protojson bodies) may carry. */
export const AGENT_EVENT_PAYLOAD_REGISTRY: Registry = createRegistry(
	...JSON_PAYLOADS,
	file_umiak_agent_v1_events,
	file_umiak_agent_v1_common,
);

/** The message name of a type URL (`type.googleapis.com/umiak.agent.v1.X`). */
function typeName(typeUrl: string): string {
	return typeUrl.slice(typeUrl.lastIndexOf("/") + 1);
}

/** The payload as JSON; {} when absent; {"@type"} when unknown or corrupt. */
export function decodePayload(any: Any | undefined): unknown {
	if (any === undefined || (any.typeUrl === "" && any.value.length === 0)) {
		return {};
	}
	const schema = AGENT_EVENT_PAYLOAD_REGISTRY.getMessage(typeName(any.typeUrl));
	if (schema !== undefined) {
		// A corrupt payload must not fail the batch: the gateway retries any
		// non-2xx forever and the machine's events would stall.
		try {
			const m = anyUnpack(any, schema);
			if (m !== undefined) {
				return toJson(schema, m, {
					alwaysEmitImplicit: true,
					registry: AGENT_EVENT_PAYLOAD_REGISTRY,
				});
			}
		} catch {
			// stored as {"@type"} below
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
