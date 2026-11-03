// Hosted ports of a sandbox (S7 §11.2, S4 §8): list (hosted and listening),
// PUT with full settings, rotate-token, DELETE. The port token is returned
// only by the call that issued it; core keeps its sha256. `public` is
// refused while the operator has turned it off (read on every request,
// S8 C7). Tokens never reach logs.
import { createRoute } from "@hono/zod-openapi";
import {
	type HostedPort,
	type PortMode,
	portLabel,
	type Sandbox,
} from "@umiak/core";
import { authOf } from "../auth/principal.ts";
import { requireOperator, requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { iso } from "../map/operation.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
	optionalJsonBody,
} from "../openapi/registry.ts";
import { type PreviewSettings, previewUrl } from "../preview-url.ts";
import { SandboxParams } from "../schemas/common.ts";
import {
	HostedPortSchema,
	HostedPortWriteSchema,
	HostPortRequest,
	PortParams,
	PortTokenSchema,
	RESERVED_PORTS_TEXT,
	SandboxPortsSchema,
} from "../schemas/port.ts";
import { BlockRequest, UnblockRequest } from "../schemas/sandbox.ts";
import { blockInput, unblockInput } from "./sandboxes.ts";

const TAGS = ["ports"];

const notFound404 = errorResponse("`not_found`: no such sandbox in the team");
const portBlocked403 = errorResponse(
	"`forbidden` with details.reason `port_blocked` (an operator blocked this port) or " +
		"`sandbox_blocked` (an operator blocked the sandbox)",
);
const port400 = errorResponse(
	`\`validation\`: port outside 1-65535, a reserved port (${RESERVED_PORTS_TEXT}), ` +
		"or more than 50 hosted ports",
);

const listPorts = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/ports",
	operationId: "ports.list",
	summary: "List hosted and listening ports",
	description:
		"`hosted`: ports published through the gateway, with their URLs (tokens are never " +
		"shown again). `listening`: TCP ports processes in the guest listen on, live from the " +
		"agent when the sandbox is ready, else the last report.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:read")] as const,
	request: { params: SandboxParams },
	responses: {
		200: jsonResponse(SandboxPortsSchema, "Hosted and listening ports"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const hostPort = createRoute({
	method: "put",
	path: "/v1/sandboxes/{sandbox}/ports/{port}",
	operationId: "ports.put",
	summary: "Publish a port or change its access",
	description:
		"Publishes the guest port at the configured preview scheme, domain and port with the given settings " +
		"(PUT: omitted fields take their defaults: access token, hostRewrite preserve, " +
		"appProtocol http1). 201 for a new port, 200 for a change or the same settings. A new " +
		"token port or a switch to token returns `token` and `urlWithToken` once; keep them. " +
		"Any access change invalidates the port's links and cookies. Allowed in any state but " +
		"deleting and deleted.",
	tags: TAGS,
	middleware: [requireScope("ports:write")] as const,
	request: {
		params: PortParams,
		body: optionalJsonBody(HostPortRequest, "Settings of the port"),
	},
	responses: {
		200: jsonResponse(HostedPortWriteSchema, "Changed or unchanged"),
		201: jsonResponse(HostedPortWriteSchema, "Published"),
		400: port400,
		403: errorResponse(
			"`forbidden` with details.reason `public_disabled` (the operator turned public ports " +
				"off), `port_blocked` (an operator blocked this port) or `sandbox_blocked`",
		),
		404: notFound404,
		409: errorResponse("`invalid_state`: deleting or deleted"),
		...ERROR_RESPONSES,
	},
});

const rotateToken = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ports/{port}/rotate-token",
	operationId: "ports.rotateToken",
	summary: "Issue a new port token",
	description:
		"Replaces the token of a token port: the old token, its links and cookies stop working " +
		"at once. The new token is returned only here.",
	tags: TAGS,
	middleware: [requireScope("ports:write")] as const,
	request: { params: PortParams },
	responses: {
		200: jsonResponse(PortTokenSchema, "The new token"),
		400: errorResponse(
			"`validation`: a bad port or the port is not in token mode",
		),
		403: portBlocked403,
		404: errorResponse(
			"`not_found`: no such sandbox, or the port is not hosted",
		),
		409: errorResponse("`invalid_state`: deleting or deleted"),
		...ERROR_RESPONSES,
	},
});

const unhostPort = createRoute({
	method: "delete",
	path: "/v1/sandboxes/{sandbox}/ports/{port}",
	operationId: "ports.delete",
	summary: "Unpublish a port",
	description:
		"Stops publishing the port; its links and cookies stop working. Repeating is safe: a " +
		"port that is not hosted also answers 204.",
	tags: TAGS,
	middleware: [requireScope("ports:write")] as const,
	request: { params: PortParams },
	responses: {
		204: { description: "Not hosted any more" },
		400: port400,
		403: portBlocked403,
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const OPERATOR_ONLY =
	"Only a platform operator's browser session (the dashboard); API keys and Keycloak " +
	"tokens are 403 `forbidden` (details.reason `operator_required`). The sandbox is found " +
	"in any team, no Umiak-Team needed.";

const blockPortRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ports/{port}/block",
	operationId: "ports.block",
	summary: "Block a hosted port (operator)",
	description:
		"Blocks the port: the gateway refuses it, and for everyone but an operator PUT, " +
		"rotate-token and DELETE of the port are 403 `forbidden` (details.reason " +
		"`port_blocked`), so the block survives an unpublish and a new publish. The same " +
		`reason again changes nothing. ${OPERATOR_ONLY}`,
	tags: TAGS,
	middleware: [requireOperator()] as const,
	request: { params: PortParams, body: jsonBody(BlockRequest, "Why") },
	responses: {
		200: jsonResponse(HostedPortSchema, "The blocked port"),
		400: port400,
		403: errorResponse(
			"`forbidden` with details.reason `operator_required`: not a platform operator",
		),
		404: errorResponse(
			"`not_found`: no such sandbox in any team, or the port is not hosted",
		),
		...ERROR_RESPONSES,
	},
});

const unblockPortRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ports/{port}/unblock",
	operationId: "ports.unblock",
	summary: "Unblock a hosted port (operator)",
	description: `Lifts the port's block at once; on a port that is not blocked nothing changes. ${OPERATOR_ONLY}`,
	tags: TAGS,
	middleware: [requireOperator()] as const,
	request: {
		params: PortParams,
		body: optionalJsonBody(UnblockRequest, "Optional note"),
	},
	responses: {
		200: jsonResponse(HostedPortSchema, "The port"),
		400: port400,
		403: errorResponse(
			"`forbidden` with details.reason `operator_required`: not a platform operator",
		),
		404: errorResponse(
			"`not_found`: no such sandbox in any team, or the port is not hosted",
		),
		...ERROR_RESPONSES,
	},
});

function withToken(url: string, token: string): string {
	return `${url}/?_token=${token}`;
}

function toHostedPort(p: HostedPort, settings: PreviewSettings) {
	return {
		port: p.port,
		label: p.label,
		url: previewUrl(p.label, settings),
		access: p.mode,
		hostRewrite: p.hostRewrite,
		appProtocol: p.appProtocol,
		blocked: p.blocked,
		blockReason: p.blockReason,
		createdAt: iso(p.createdAt),
	};
}

interface ListeningPort {
	port: number;
	addresses: string[];
	process: string;
	user: string;
}

/** The stored `ports.changed` report; malformed entries are skipped. */
function storedListening(raw: unknown): ListeningPort[] {
	if (!Array.isArray(raw)) return [];
	const out: ListeningPort[] = [];
	for (const e of raw) {
		if (e === null || typeof e !== "object") continue;
		const r = e as Record<string, unknown>;
		const port = r.port;
		if (typeof port !== "number" || !Number.isInteger(port)) continue;
		out.push({
			port,
			addresses: Array.isArray(r.addresses)
				? r.addresses.filter((a): a is string => typeof a === "string")
				: [],
			process: typeof r.process === "string" ? r.process : "",
			user: typeof r.user === "string" ? r.user : "",
		});
	}
	return out;
}

/** Live from the agent when ready; else, or when the agent fails, the stored report. */
async function listening(
	deps: ApiDeps,
	s: Sandbox,
): Promise<{ listening: ListeningPort[]; listeningObservedAt: string | null }> {
	if (s.state === "ready" && s.machineId !== null) {
		try {
			const ports = await deps.agent.listPorts(s.machineId);
			return {
				listening: ports.map((p) => ({
					port: p.port,
					addresses: p.addresses,
					process: p.process,
					user: p.user,
				})),
				listeningObservedAt: new Date().toISOString(),
			};
		} catch (e) {
			// Never fails the request: the last report below. Name and code
			// only; agent messages may quote guest data. (`err.code` would be
			// redacted as a secret, hence the flat fields.)
			deps.log.warn(
				{
					sandboxId: s.id,
					errName: e instanceof Error ? e.name : typeof e,
					errCode: (e as { code?: unknown } | null)?.code,
				},
				"listPorts failed; the stored report is used",
			);
		}
	}
	return {
		listening: storedListening(s.listeningPorts),
		listeningObservedAt: null,
	};
}

function publicDisabled(): ApiError {
	return new ApiError(
		403,
		"forbidden",
		"public ports are turned off by the platform operator; use access token or sso",
		{ details: { reason: "public_disabled" } },
	);
}

export function registerPortRoutes(app: ApiApp, deps: ApiDeps): void {
	const svc = deps.svc;
	const settings = deps.settings;

	app.openapi(listPorts, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const s = await svc.get(p, ref);
		const hosted = await svc.listHostedPorts(p, s.id);
		return c.json(
			{
				hosted: hosted.map((h) => toHostedPort(h, settings)),
				...(await listening(deps, s)),
			},
			200,
		);
	});

	app.openapi(hostPort, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, port } = c.req.valid("param");
		const body = c.req.valid("json");
		const access: PortMode = body.access ?? "token";
		// The sandbox first: another team's sandbox is 404 whatever the body.
		const s = await svc.get(p, resolveSandboxRef(sandbox));
		if (
			access === "public" &&
			!(await deps.config.defaults()).publicPortsEnabled
		) {
			throw publicDisabled();
		}
		const r = await svc.hostPort(p, s.id, port, {
			access,
			...(body.hostRewrite === undefined
				? {}
				: { hostRewrite: body.hostRewrite }),
			...(body.appProtocol === undefined
				? {}
				: { appProtocol: body.appProtocol }),
		});
		const out = toHostedPort(r.hostedPort, settings);
		const issued =
			r.token === undefined
				? {}
				: { token: r.token, urlWithToken: withToken(out.url, r.token) };
		return c.json({ ...out, ...issued }, r.created ? 201 : 200);
	});

	app.openapi(rotateToken, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, port } = c.req.valid("param");
		const s = await svc.get(p, resolveSandboxRef(sandbox));
		const { token } = await svc.rotatePortToken(p, s.id, port);
		// Labels follow the slug (a rename relabels every port).
		const url = previewUrl(portLabel(s.slug, port), settings);
		return c.json({ token, urlWithToken: withToken(url, token) }, 200);
	});

	app.openapi(unhostPort, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, port } = c.req.valid("param");
		await svc.unhostPort(p, resolveSandboxRef(sandbox), port);
		return c.body(null, 204);
	});

	app.openapi(blockPortRoute, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, port } = c.req.valid("param");
		const hp = await svc.blockPort(
			p,
			resolveSandboxRef(sandbox),
			port,
			blockInput(c.req.valid("json")),
		);
		return c.json(toHostedPort(hp, settings), 200);
	});

	app.openapi(unblockPortRoute, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, port } = c.req.valid("param");
		const hp = await svc.unblockPort(
			p,
			resolveSandboxRef(sandbox),
			port,
			unblockInput(c.req.valid("json")),
		);
		return c.json(toHostedPort(hp, settings), 200);
	});
}
