import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import {
	hasOperatorRights,
	parseLabel,
	type Sandbox,
	sandboxBlocked,
} from "@sbx/core";
import type { Context } from "hono";
import { agentErrorToHttp } from "../agent/errors.ts";
import type { DesktopMethod } from "../agent/types.ts";
import { authOf } from "../auth/principal.ts";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import { poolOf } from "../routes/internal/common.ts";

/**
 * `write`: the call drives the guest (input, clipboard, links, access), so an
 * operator block refuses it like exec (S8 C3, 403 `sandbox_blocked`). Reads
 * (status, screenshot, clipboard read) stay allowed, like file reads.
 */
export async function desktopSandbox(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	ref: string,
	opts: { ready?: boolean; write?: boolean } = {},
): Promise<Sandbox> {
	const principal = authOf(c).principal;
	const s = await deps.svc.get(principal, resolveSandboxRef(ref));
	if (opts.write && s.blocked && !hasOperatorRights(principal))
		throw sandboxBlocked();
	if (
		!(await deps.config.template(s.templateSlug))?.capabilities.includes(
			"desktop",
		)
	)
		throw new ApiError(
			422,
			"desktop_unsupported",
			"this template has no desktop capability",
		);
	if ((opts.ready ?? true) && (s.state !== "ready" || !s.machineId))
		throw new ApiError(409, "sandbox_not_ready", "sandbox must be ready");
	await poolOf(deps).query(
		"INSERT INTO runtime.sandbox_desktops(sandbox_id) VALUES($1) ON CONFLICT DO NOTHING",
		[s.id],
	);
	await deps.svc.touchApiActivity(s.id);
	return s;
}
export async function desktopRpc(
	deps: ApiDeps,
	machineId: string,
	method: DesktopMethod,
	body: Record<string, unknown> = {},
	signal?: AbortSignal,
	requestId?: string,
) {
	try {
		await deps.agent.requireCapability(machineId, "desktop.v1", signal);
		const capability =
			method === "act"
				? "desktop.input.v1"
				: method === "getClipboard" || method === "setClipboard"
					? "desktop.clipboard.v1"
					: method === "open" ||
							method === "endStreams" ||
							method === "stopStreamer"
						? "desktop.stream.v1"
						: undefined;
		if (capability)
			await deps.agent.requireCapability(machineId, capability, signal);
		return await deps.agent.desktopCall(machineId, method, body, {
			requestId: requestId ?? randomUUID(),
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		throw agentErrorToHttp(error);
	}
}
export async function desktopPolicy(deps: ApiDeps, id: string) {
	const r = await poolOf(deps).query<{
		access: "token" | "sso" | "public";
		auth_epoch: number;
	}>(
		"SELECT access,auth_epoch FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[id],
	);
	const p = r.rows[0];
	if (!p) throw new ApiError(404, "route_not_found", "no desktop policy");
	return p;
}
export const desktopUrl = (deps: ApiDeps, slug: string) =>
	`https://${slug}-desktop.${deps.settings.sbxDomain}/`;
export const ticketHash = (ticket: string) =>
	createHash("sha256").update(ticket).digest();
export async function issueDesktopLink(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	s: Sandbox,
	options: Record<string, unknown> = {},
) {
	const p = authOf(c).principal;
	const policy = await desktopPolicy(deps, s.id);
	const ticket = `sbxd_${randomBytes(32).toString("base64url")}`;
	const result = await poolOf(deps).query<{ expires_at: Date }>(
		`INSERT INTO runtime.desktop_tickets(ticket_hash,sandbox_id,label,user_id,api_key_id,auth_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') RETURNING expires_at`,
		[
			ticketHash(ticket),
			s.id,
			`${s.slug}-desktop`,
			p.userId,
			p.apiKeyId,
			policy.auth_epoch,
		],
	);
	// Pairing is eager here; the gateway retries Open when the viewer arrives.
	void desktopRpc(deps, s.machineId as string, "open").catch(() =>
		deps.log.debug("desktop pre-open is pending"),
	);
	const url = new URL(desktopUrl(deps, s.slug));
	url.searchParams.set("_ticket", ticket);
	if (options.fps) url.searchParams.set("fps", String(options.fps));
	if (options.bitrateKbps)
		url.searchParams.set("bitrate", String(options.bitrateKbps));
	if (options.transport)
		url.searchParams.set("dataTransport", String(options.transport));
	return {
		url: url.toString(),
		expiresAt: result.rows[0]?.expires_at.toISOString(),
	};
}
/** Desktop routes use template capability and policy, never a hosted TCP port. */
export async function lookupDesktopRoute(deps: ApiDeps, label: string) {
	const parsed = parseLabel(label);
	if (parsed?.kind !== "desktop") return null;
	const r = await poolOf(deps).query<{
		id: string;
		slug: string;
		machine_id: string | null;
		state: string;
		team_id: string;
		template_slug: string;
		blocked: boolean;
		block_reason: string | null;
	}>(
		"SELECT id,slug,machine_id,state,team_id,template_slug,blocked,block_reason FROM runtime.sandboxes WHERE slug=$1 AND state NOT IN ('deleting','deleted')",
		[parsed.slug],
	);
	const s = r.rows[0];
	if (
		!s ||
		!(await deps.config.template(s.template_slug))?.capabilities.includes(
			"desktop",
		)
	)
		return null;
	await poolOf(deps).query(
		"INSERT INTO runtime.sandbox_desktops(sandbox_id) VALUES($1) ON CONFLICT DO NOTHING",
		[s.id],
	);
	const p = await desktopPolicy(deps, s.id);
	const defaults = await deps.config.defaults();
	const disabled = p.access === "public" && !defaults.publicDesktopEnabled;
	return {
		label,
		kind: "desktop" as const,
		sandboxId: encodeUuid("sandbox", s.id),
		slug: s.slug,
		port: 47800,
		machineId: s.machine_id,
		sandboxState: s.state,
		access: p.access,
		tokenHash: null,
		authEpoch: p.auth_epoch,
		blocked: s.blocked || disabled,
		blockReason: s.blocked
			? s.block_reason
			: disabled
				? "public_disabled"
				: null,
		hostRewrite: "localhost",
		appProtocol: "http1",
		teamId: encodeUuid("team", s.team_id),
		rawSandboxId: s.id,
		rawTeamId: s.team_id,
	};
}
