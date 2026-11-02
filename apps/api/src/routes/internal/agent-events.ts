// POST /internal/v1/agent-events (S7 §12.1, S6 §10.1, S2 §9.6): the gateway
// delivers guest events and tunnel connection events of a machine. The body
// is AgentEventsRequest as binary protobuf (`application/proto`, what the
// gateway sends) or protojson (`application/json`); the answer
// AgentEventsResponse {ackedSeq} uses the same format. ackedSeq is the
// largest seq of the batch once every row is stored, 0 without guest events.
import {
	create,
	fromBinary,
	fromJsonString,
	toBinary,
	toJsonString,
} from "@bufbuild/protobuf";
import { ingestAgentEvents } from "@umiak/core";
import {
	type AgentEventsRequest,
	AgentEventsRequestSchema,
	AgentEventsResponseSchema,
} from "@umiak/proto";
import {
	AGENT_EVENT_PAYLOAD_REGISTRY,
	decodeAgentEvents,
} from "../../agent/event-decode.ts";
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { validationError } from "../../http/errors.ts";
import { poolOf, requireGateway } from "./common.ts";

const PROTO_TYPES = new Set(["application/proto", "application/x-protobuf"]);

function mediaType(header: string | undefined): string {
	return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function badBody(message: string) {
	return validationError([{ path: "body", message }]);
}

export function registerAgentEventRoutes(app: ApiApp, deps: ApiDeps): void {
	app.post("/internal/v1/agent-events", requireGateway(), async (c) => {
		const type = mediaType(c.req.header("content-type"));
		const binary = PROTO_TYPES.has(type);
		if (!binary && type !== "application/json") {
			throw validationError([
				{
					path: "header.content-type",
					message: "must be application/proto or application/json",
				},
			]);
		}
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		let req: AgentEventsRequest;
		try {
			req = binary
				? fromBinary(AgentEventsRequestSchema, bytes)
				: fromJsonString(
						AgentEventsRequestSchema,
						new TextDecoder("utf-8", { fatal: true }).decode(bytes),
						{ registry: AGENT_EVENT_PAYLOAD_REGISTRY },
					);
		} catch (e) {
			throw badBody(
				`not an AgentEventsRequest: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		const { ackedSeq } = await ingestAgentEvents(
			poolOf(deps),
			deps.jobs,
			decodeAgentEvents(req),
		);
		const res = create(AgentEventsResponseSchema, {
			ackedSeq: BigInt(ackedSeq ?? 0),
		});
		if (binary) {
			return c.body(toBinary(AgentEventsResponseSchema, res), 200, {
				"Content-Type": "application/proto",
			});
		}
		return c.body(
			toJsonString(AgentEventsResponseSchema, res, {
				alwaysEmitImplicit: true,
			}),
			200,
			{ "Content-Type": "application/json" },
		);
	});
}
