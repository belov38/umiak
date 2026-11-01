import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
import { DesktopActionFailureSchema } from "@sbx/proto/agent/v1";
import { expect, it } from "vitest";
import { toAgentError } from "../src/agent/connect.ts";
import { AgentCallError, agentErrorToHttp } from "../src/agent/errors.ts";

it.each(["invalid_action", "action_failed"])(
	"preserves structured %s progress",
	(code) => {
		const err = new ConnectError(
			"desktop batch failed",
			Code.FailedPrecondition,
			undefined,
			[
				{ desc: ErrorDetailSchema, value: create(ErrorDetailSchema, { code }) },
				{
					desc: DesktopActionFailureSchema,
					value: create(DesktopActionFailureSchema, {
						index: 3,
						completed: 2,
						reason: "unknown key",
					}),
				},
			],
		);
		const mapped = toAgentError(err);
		expect(mapped).toBeInstanceOf(AgentCallError);
		expect((mapped as AgentCallError).details).toEqual(
			code === "invalid_action"
				? { index: 3, reason: "unknown key" }
				: { index: 3, completed: 2 },
		);
		expect(agentErrorToHttp(mapped).details).toEqual(
			(mapped as AgentCallError).details,
		);
	},
);
