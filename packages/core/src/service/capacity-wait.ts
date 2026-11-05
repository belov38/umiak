import type { Tx } from "@umiak/db";
import type { ValidationIssue } from "../errors.ts";
import type { JobSender } from "../jobs.ts";
import { lockTeam } from "../locks.ts";
export const CAPACITY_WAIT_MAX_SECONDS = 604800;
export function checkCapacityWait(value: unknown, issues: ValidationIssue[]) {
	if (
		value !== undefined &&
		(!Number.isSafeInteger(value) ||
			typeof value !== "number" ||
			value < 0 ||
			value > CAPACITY_WAIT_MAX_SECONDS)
	)
		issues.push({
			path: "capacityWaitSeconds",
			message: `must be an integer from 0 to ${CAPACITY_WAIT_MAX_SECONDS}`,
		});
}
export async function teamHasQueuedStarts(
	tx: Tx,
	teamId: string,
): Promise<boolean> {
	return Boolean(
		(
			await tx.client.query(
				"SELECT 1 FROM runtime.start_queue q JOIN runtime.operations o ON o.id=q.operation_id WHERE q.team_id=$1 AND o.state IN ('pending','running') LIMIT 1",
				[teamId],
			)
		).rowCount,
	);
}
export async function enqueueCapacityWait(
	tx: Tx,
	jobs: JobSender,
	teamId: string,
	operationId: string,
	seconds: number,
) {
	await lockTeam(tx, teamId);
	const ticket = (
		await tx.client.query<{ deadline_at: Date }>(
			"INSERT INTO runtime.start_queue(operation_id,team_id,deadline_at) VALUES($1,$2,now()+make_interval(secs=>$3)) ON CONFLICT(operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING deadline_at",
			[operationId, teamId, seconds],
		)
	).rows[0];
	if (!ticket) throw new Error("capacity ticket was not inserted");
	await tx.client.query(
		"UPDATE runtime.operations SET progress=progress || $2::jsonb,deadline_at=GREATEST(deadline_at,$3::timestamptz+interval '20 minutes'),version=version+1 WHERE id=$1",
		[
			operationId,
			JSON.stringify({
				phase: "queued",
				queuedUntil: ticket.deadline_at.toISOString(),
			}),
			ticket.deadline_at,
		],
	);
	await jobs.send(tx, "ctl-start-queue", {});
}
