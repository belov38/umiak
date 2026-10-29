// Wire names shared with the Go `wire` package (libs/tunnel/wire). Keep the
// values identical.

/** Idempotency key of mutating unary calls; retries keep it unchanged. */
export const HEADER_REQUEST_ID = "Sbx-Request-Id";
/** Set by the gateway on proxied calls: the caller name (api, worker). */
export const HEADER_CALLER = "Sbx-Caller";
/** Gateway error code on 421/503 answers (machine_moved, agent_unavailable). */
export const HEADER_ERROR_CODE = "Sbx-Error-Code";
/** Internal URL of the owning gateway instance on a 421 answer. */
export const HEADER_INSTANCE_URL = "Sbx-Instance-Url";
/** Drain deadline in milliseconds of a peer CONNECT stream. */
export const HEADER_TCP_DRAIN_DEADLINE = "Sbx-Tcp-Drain-Deadline-Ms";

/** Authorization scheme of the service token. */
export const SCHEME_BEARER = "Bearer";

/** The machine is served by another gateway instance (HTTP 421). */
export const CODE_MACHINE_MOVED = "machine_moved";
/** No gateway instance serves the machine right now (HTTP 503). */
export const CODE_AGENT_UNAVAILABLE = "agent_unavailable";
/** The agent lacks a required capability (API answers 409). */
export const CODE_AGENT_OUTDATED = "agent_outdated";
/** The agent's answer cannot be passed on (gateway 502, AgentClient.fetch). */
export const CODE_BAD_AGENT_RESPONSE = "bad_agent_response";
/** A mutating unary call came without Sbx-Request-Id. */
export const CODE_REQUEST_ID_REQUIRED = "request_id_required";

/** Postgres NOTIFY channel for session changes; the payload is the machine id. */
export const NOTIFY_CHANNEL = "tunnel_sessions";
/** Postgres NOTIFY channel for gateway instance changes; the payload is the instance id. */
export const NOTIFY_INSTANCES_CHANNEL = "gateway_instances";

/** Service prefix of the agent API (S3). */
export const SERVICE_PREFIX_AGENT = "sbx.agent.v1.";
/** Service prefix of the tunnel API; the gateway refuses it on the internal listener. */
export const SERVICE_PREFIX_TUNNEL = "sbx.tunnel.v1.";

/**
 * Maximum Connect message size in bytes (spec section 4.3), after
 * decompression; the gateway and the agent use the same limit.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
