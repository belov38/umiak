// Prometheus metrics of the remote MCP server (S11 13.3), in their own
// registry. Labels never carry tokens, sandbox ids or arguments.
import { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface CallRecord {
	tool: string;
	/** `ok` or the error code of the tool result. */
	outcome: string;
	durationMs: number;
	/** Bytes of the result content (text and base64 data). */
	bytes: number;
}

export class Metrics {
	readonly registry = new Registry();
	/** Tool calls per tool and outcome. */
	readonly calls: Counter<"tool" | "outcome">;
	readonly callDuration: Histogram<"tool">;
	readonly responseBytes: Histogram<"tool">;
	/** Tool calls running now (on this pod). */
	readonly inFlight: Gauge;
	/** Refused bearers (401, 403; 400 bad team, 503 api down) per status and reason. */
	readonly authRejections: Counter<"status" | "reason">;
	/** Bearer checks that had to call GET /v1/me. */
	readonly meCacheMisses: Counter;

	constructor() {
		const registers = [this.registry];
		this.calls = new Counter({
			name: "sbx_mcp_tool_calls_total",
			help: "Tool calls per tool and outcome (ok or an error code)",
			labelNames: ["tool", "outcome"],
			registers,
		});
		this.callDuration = new Histogram({
			name: "sbx_mcp_tool_call_duration_seconds",
			help: "Tool call time per tool",
			labelNames: ["tool"],
			buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60],
			registers,
		});
		this.responseBytes = new Histogram({
			name: "sbx_mcp_tool_response_bytes",
			help: "Size of tool results per tool",
			labelNames: ["tool"],
			buckets: [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576],
			registers,
		});
		this.inFlight = new Gauge({
			name: "sbx_mcp_tool_calls_in_flight",
			help: "Tool calls running now",
			registers,
		});
		this.authRejections = new Counter({
			name: "sbx_mcp_auth_rejections_total",
			help: "Refused bearers of the MCP endpoint per HTTP status and reason",
			labelNames: ["status", "reason"],
			registers,
		});
		this.meCacheMisses = new Counter({
			name: "sbx_mcp_me_cache_misses_total",
			help: "Bearer checks that called GET /v1/me",
			registers,
		});
	}

	recordCall(r: CallRecord): void {
		this.calls.inc({ tool: r.tool, outcome: r.outcome });
		this.callDuration.observe({ tool: r.tool }, r.durationMs / 1000);
		this.responseBytes.observe({ tool: r.tool }, r.bytes);
	}
}
