import { createHmac } from "node:crypto";
import { stepRequestId } from "@sbx/core";
import type { WorkerCtx } from "./context.ts";
import {
	AgentRejected,
	AgentUnavailable,
	type DesktopConfiguration,
} from "./ports.ts";
import type { StepFence } from "./steps.ts";
import { waitUntil } from "./wait.ts";

/** Only worker and coturn hold this key. Never log this configuration. */
export interface TurnConfig {
	secret: string;
	urls: string[];
}
export function issueTurnCredentials(
	config: TurnConfig,
	sandboxId: string,
	now = new Date(),
): DesktopConfiguration["iceServers"][number] {
	if (
		config.secret.length < 32 ||
		config.urls.length === 0 ||
		config.urls.some((url) => !/^turns?:[^\s]+$/.test(url))
	)
		throw new Error("TURN secret and URLs are not configured correctly");
	const username = `${Math.floor(now.getTime() / 1000) + 86400}:${sandboxId}`;
	return {
		urls: [...config.urls],
		username,
		credential: createHmac("sha1", config.secret)
			.update(username)
			.digest("base64"),
	};
}
/** Called after claim and after secrets delivery on every new boot. */
export async function configureDesktop(
	ctx: WorkerCtx,
	sandboxId: string,
	machineId: string,
	requestId: string,
): Promise<void> {
	const sandbox = await ctx.pool.query<{ template_slug: string }>(
		"SELECT template_slug FROM runtime.sandboxes WHERE id=$1",
		[sandboxId],
	);
	const slug = sandbox.rows[0]?.template_slug;
	if (!slug) return;
	if (!(await ctx.config.template(slug))?.capabilities.includes("desktop"))
		return;
	if (!ctx.turn) throw new AgentRejected("desktop_turn_unconfigured");
	await ctx.pool.query(
		"INSERT INTO runtime.sandbox_desktops(sandbox_id) VALUES($1) ON CONFLICT DO NOTHING",
		[sandboxId],
	);
	const result = await ctx.pool.query<{ auth_epoch: number }>(
		"SELECT auth_epoch FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[sandboxId],
	);
	const authEpoch = result.rows[0]?.auth_epoch;
	if (authEpoch === undefined) throw new Error("desktop policy missing");
	await ctx.agent.configureDesktop(
		machineId,
		{ authEpoch, iceServers: [issueTurnCredentials(ctx.turn, sandboxId)] },
		requestId,
	);
	await ctx.pool.query(
		"UPDATE runtime.sandbox_desktops SET turn_issued_at=now(),updated_at=now() WHERE sandbox_id=$1 AND auth_epoch=$2",
		[sandboxId, authEpoch],
	);
}
/** Desktops renewed per controller run; the rest wait for the next run. */
export const DESKTOP_TURN_BATCH = 100;
/**
 * Every ten minutes refresh credentials older than twelve hours, oldest first.
 * One unreachable guest is logged and skipped: it stays due and is retried on
 * the next run, the others are renewed now.
 */
export async function refreshDesktopTurn(ctx: WorkerCtx): Promise<number> {
	if (!ctx.turn) return 0;
	const due = await ctx.pool.query<{ id: string; machine_id: string }>(
		`SELECT s.id,s.machine_id FROM runtime.sandboxes s JOIN runtime.sandbox_desktops d ON d.sandbox_id=s.id WHERE s.state='ready' AND s.machine_id IS NOT NULL AND (d.turn_issued_at IS NULL OR d.turn_issued_at<now()-interval '12 hours') ORDER BY d.turn_issued_at ASC NULLS FIRST, s.id LIMIT $1`,
		[DESKTOP_TURN_BATCH],
	);
	let count = 0;
	for (const s of due.rows) {
		try {
			await configureDesktop(
				ctx,
				s.id,
				s.machine_id,
				stepRequestId(
					s.id,
					`desktop-turn:${Math.floor(Date.now() / 600000)}`,
				),
			);
			count++;
		} catch (err) {
			ctx.log.warn(
				{ sandboxId: s.id, err: (err as Error).message },
				"desktop TURN renewal failed; retrying on the next run",
			);
		}
	}
	return count;
}

/** A configured desktop must become usable on this same boot before finish. */
export async function waitForDesktopReady(
	ctx: WorkerCtx,
	fence: StepFence,
	sandboxId: string,
	machineId: string,
): Promise<void> {
	const r = await ctx.pool.query<{
		template_slug: string;
		boot_timeout_s: number | null;
	}>(
		"SELECT s.template_slug,b.boot_timeout_s FROM runtime.sandboxes s JOIN runtime.machines m ON m.id=s.machine_id LEFT JOIN runtime.template_builds b ON b.id=m.template_build_id WHERE s.id=$1",
		[sandboxId],
	);
	const sandbox = r.rows[0];
	if (
		!sandbox ||
		!(await ctx.config.template(sandbox.template_slug))?.capabilities.includes(
			"desktop",
		)
	)
		return;
	const session = async () =>
		(
			await ctx.pool.query<{ boot_id: string; state: string }>(
				"SELECT boot_id,state FROM tunnel.tunnel_sessions WHERE machine_id=$1",
				[machineId],
			)
		).rows[0];
	const initial = await session();
	if (!initial?.boot_id || initial.state !== "connected")
		throw new AgentUnavailable("desktop boot is disconnected");
	const checkBoot = async () => {
		const current = await session();
		if (current?.state !== "connected" || current.boot_id !== initial.boot_id)
			throw new AgentUnavailable("desktop boot changed while waiting");
	};
	await waitUntil(
		ctx,
		fence,
		async () => {
			await fence.check();
			await checkBoot();
			const ready = await ctx.agent.desktopReady(machineId);
			await checkBoot();
			return ready ? true : undefined;
		},
		{
			timeoutMs: (sandbox.boot_timeout_s ?? 300) * 1000,
			pollMs: ctx.timing.pollMs,
			what: "desktop readiness",
		},
	);
}
