import type { WorkerCtx } from "./context.ts";
import { AgentUnavailable } from "./ports.ts";
import type { StepFence } from "./steps.ts";
import { waitUntil } from "./wait.ts";

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
		{
			authEpoch,
			// Without TURN the desktop runs on the WebSocket transport only.
			iceServers: [],
		},
		requestId,
	);
	await ctx.pool.query(
		"UPDATE runtime.sandbox_desktops SET updated_at=now() WHERE sandbox_id=$1 AND auth_epoch=$2",
		[sandboxId, authEpoch],
	);
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
