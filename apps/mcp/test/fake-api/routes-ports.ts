// Ports (S7 §11.2): hosted ports with tokens, and what listens in the guest.
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { forbidden, invalidState, notFound, validation } from "./errors.ts";
import { iso, lookupSandbox, sandboxParam } from "./model.ts";
import {
	type Fake,
	type FakeApp,
	type FakeEnv,
	type FakePort,
	type FakeSandbox,
	SBX_DOMAIN,
} from "./state.ts";

const RESERVED_PORTS = [22, 47800, 47984, 47989, 47990, 48010];
const MAX_HOSTED = 50;

function urlOf(sb: FakeSandbox, port: number): string {
	return `https://${sb.slug}-${port}.${SBX_DOMAIN}`;
}

function hostedResource(sb: FakeSandbox, p: FakePort) {
	return {
		port: p.port,
		label: `${sb.slug}-${p.port}`,
		url: urlOf(sb, p.port),
		access: p.access,
		hostRewrite: p.hostRewrite,
		appProtocol: p.appProtocol,
		blocked: false,
		blockReason: null,
		createdAt: iso(p.createdAt),
	};
}

function newToken(): string {
	return `sbxp_${randomBytes(16).toString("hex")}`;
}

export function registerPortRoutes(app: FakeApp, fake: Fake): void {
	const { state } = fake;
	const base = "/v1/sandboxes/:sandbox/ports";

	/** Any state but deleting and deleted (deleted is already a 404). */
	function target(c: Context<FakeEnv>): {
		sb: FakeSandbox;
		ports: Map<number, FakePort>;
	} {
		const sb = lookupSandbox(fake, c.get("principal"), sandboxParam(c));
		if (sb.state === "deleting") {
			throw invalidState(`sandbox ${sb.slug} is deleting`, { state: sb.state });
		}
		let ports = state.ports.get(sb.id);
		if (!ports) {
			ports = new Map();
			state.ports.set(sb.id, ports);
		}
		return { sb, ports };
	}

	function portOf(c: Context<FakeEnv>): number {
		const port = Number(c.req.param("port"));
		if (RESERVED_PORTS.includes(port)) {
			throw validation([
				{
					path: "param.port",
					message: `port ${port} is reserved by the platform`,
				},
			]);
		}
		return port;
	}

	app.get(base, (c) => {
		const sb = lookupSandbox(fake, c.get("principal"), c.req.param("sandbox"));
		const hosted = [...(state.ports.get(sb.id)?.values() ?? [])].sort(
			(a, b) => a.port - b.port,
		);
		return c.json({
			hosted: hosted.map((p) => hostedResource(sb, p)),
			listening: state.listening.get(sb.id) ?? [],
			listeningObservedAt:
				sb.state === "ready" ? new Date().toISOString() : null,
		});
	});

	app.put(`${base}/:port`, (c) => {
		const { sb, ports } = target(c);
		const port = portOf(c);
		const b = (c.get("json") ?? {}) as Record<string, string | undefined>;
		const access = (b.access ?? "token") as FakePort["access"];
		if (access === "public" && state.publicPortsDisabled) {
			throw forbidden("public ports are turned off by the operator", {
				reason: "public_disabled",
			});
		}
		const existing = ports.get(port);
		if (!existing && ports.size >= MAX_HOSTED) {
			throw validation([
				{
					path: "param.port",
					message: `at most ${MAX_HOSTED} hosted ports per sandbox`,
				},
			]);
		}
		const next: FakePort = {
			port,
			access,
			hostRewrite: (b.hostRewrite ?? "preserve") as FakePort["hostRewrite"],
			appProtocol: (b.appProtocol ?? "http1") as FakePort["appProtocol"],
			createdAt: existing?.createdAt ?? new Date(),
			// A changed mode ends the old token; a new token comes only with the issue.
			token:
				access === "token" && existing?.access === "token"
					? existing.token
					: null,
		};
		const issued = access === "token" && existing?.access !== "token";
		if (issued) next.token = newToken();
		ports.set(port, next);
		const body: Record<string, unknown> = hostedResource(sb, next);
		if (issued && next.token !== null) {
			body.token = next.token;
			body.urlWithToken = `${urlOf(sb, port)}/?_token=${next.token}`;
		}
		return c.json(body, existing ? 200 : 201);
	});

	app.delete(`${base}/:port`, (c) => {
		const { ports } = target(c);
		ports.delete(portOf(c));
		return c.body(null, 204);
	});

	app.post(`${base}/:port/rotate-token`, (c) => {
		const { sb, ports } = target(c);
		const port = portOf(c);
		const existing = ports.get(port);
		if (!existing) throw notFound("port");
		if (existing.access !== "token") {
			throw validation([
				{
					path: "param.port",
					message: `port ${port} is not in token mode (it is ${existing.access})`,
				},
			]);
		}
		existing.token = newToken();
		return c.json({
			token: existing.token,
			urlWithToken: `${urlOf(sb, port)}/?_token=${existing.token}`,
		});
	});
}
