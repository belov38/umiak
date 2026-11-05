import { afterAll, beforeAll, expect, it } from "vitest";
import { type CliWorld, startWorld, until } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

let w: CliWorld;
let home: CliHome;
let env: Record<string, string>;
beforeAll(async () => {
	w = await startWorld();
	home = cliHome();
	env = { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: w.secret };
});
afterAll(async () => {
	home?.rm();
	await w?.close();
});
it("start --wait 100m queues for 6000 seconds, waits for ready, and cancellation prevents a later start", async () => {
	const sb = await w.readySandbox();
	await w.markStopped(sb.slug);
	await w.db.pool.query("UPDATE runtime.nodes SET ram_cap_mb=0 WHERE id=$1", [
		w.env.topo.nodeId,
	]);
	const pending = runCli(["start", sb.slug, "--wait", "100m"], { env });
	const ticket = await until(
		async () =>
			(
				await w.db.pool.query(
					"SELECT extract(epoch FROM (q.deadline_at-q.created_at)) AS seconds FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id JOIN runtime.sandboxes s ON s.id=o.sandbox_id WHERE s.slug=$1",
					[sb.slug],
				)
			).rows[0],
	);
	expect(Number(ticket.seconds)).toBe(6000);
	const cancelled = await runCli(["cancel-start", sb.slug], { env });
	expect(cancelled.code, cancelled.stderr).toBe(0);
	expect(cancelled.last()).toMatchObject({
		sandbox: { state: "stopped" },
		operation: { state: "failed", error: { code: "cancelled" } },
	});
	const done = await pending;
	expect(done.code).toBe(1);
	expect(done.lines()[0]).toMatchObject({
		event: "accepted",
		sandbox: { state: "queued" },
	});
	expect(
		w.requests.filter((r) => r.includes("waitFor=") || r.includes("waitFor%3D"))
			.length,
	).toBeLessThan(10);
});
it("create --capacity-wait accepts without waiting for ready", async () => {
	const result = await runCli(["create", "--capacity-wait", "100m"], { env });
	expect(result.code, result.stderr).toBe(0);
	expect(result.last()).toMatchObject({
		sandbox: { state: "queued" },
		operation: { state: "queued" },
	});
});
