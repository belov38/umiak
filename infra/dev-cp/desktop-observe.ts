// Read-only observation avoids API reads refreshing the idle clock.
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { Sandbox } from "../../packages/sdk-ts/src/index.ts";

export interface Observation {
	state: string;
	counters: Record<string, number> | null;
	api_age: number | null;
	stop_reason: string | null;
	runtime_id: string | null;
}
export function observeDesktop(slug: string): Observation {
	if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("unsafe sandbox slug");
	const sql = `SELECT row_to_json(x) FROM (SELECT s.state,s.activity_counters AS counters,extract(epoch FROM now()-s.last_api_call_at)::int AS api_age,s.stop_reason,m.vmid::text AS runtime_id FROM runtime.sandboxes s LEFT JOIN runtime.machines m ON m.id=s.machine_id WHERE s.slug='${slug}' AND s.labels->>'e2e'='desktop') x;`;
	const text = execFileSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			process.env.SBX_DEVCP_SSH ?? "sbx@192.168.68.90",
			"docker",
			"exec",
			"-i",
			"sbx-postgres-1",
			"psql",
			"-U",
			"sbx",
			"-d",
			"sbx",
			"-At",
		],
		{ input: sql, encoding: "utf8", timeout: 30_000 },
	).trim();
	if (!text) throw new Error("desktop sandbox observation missing");
	return JSON.parse(text) as Observation;
}
export async function verifyDesktopIdleHold(
	sb: Sandbox,
	holdMs: number,
	logFile: string,
) {
	const start = Date.now();
	while (Date.now() - start < holdMs) {
		const row = observeDesktop(sb.data.slug);
		const c = row.counters;
		if (row.state !== "ready")
			throw new Error(`desktop stopped with live viewer: ${row.state}`);
		if (
			(c?.desktopStreams ?? 0) < 1 ||
			c?.runningCommands !== 0 ||
			c.openPtys !== 0 ||
			c.tcpStreams !== 0
		)
			throw new Error(
				"idle proof requires desktopStreams alone, all other counters zero",
			);
		await appendFile(
			logFile,
			`${JSON.stringify({ elapsedMs: Date.now() - start, ...row })}\n`,
			{ mode: 0o600 },
		);
		if (Date.now() - start > 70_000 && (row.api_age ?? 0) < 60)
			throw new Error("idle proof was refreshed by API activity");
		console.log(
			"idle_viewer_hold_ms",
			Date.now() - start,
			"desktopStreams",
			c.desktopStreams,
		);
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(10_000, holdMs - (Date.now() - start))),
		);
	}
	console.log("ok live viewer prevents idle-stop", holdMs);
}
export async function waitDesktopIdleStop(sb: Sandbox) {
	const deadline = Date.now() + 180_000;
	for (;;) {
		const row = observeDesktop(sb.data.slug);
		if (row.state === "stopped") {
			if (row.stop_reason !== "idle")
				throw new Error(`wrong stop reason ${row.stop_reason}`);
			console.log("ok idle-stop after closing viewer");
			return;
		}
		if (Date.now() > deadline)
			throw new Error("desktop did not idle-stop after viewer closed");
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
}
