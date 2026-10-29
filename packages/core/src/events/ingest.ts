import { withTx } from "@sbx/db";
import type pg from "pg";
import { type ValidationIssue, validation } from "../errors.ts";
import type { JobSender } from "../jobs.ts";
import { isUuid } from "../service/common.ts";

// Agent event intake (S6 §10.1). `apps/api` decodes the S2 batch (protojson,
// `Any`) and calls this. One transaction stores the raw type and payload with
// `ON CONFLICT DO NOTHING` (redelivery is normal) and enqueues one
// `machine-events {machineId}` job (stately, singletonKey = machineId), so
// the ack is sent only after every row of the batch is durable.

/** S2 synthetic event types (S2 §9.6). */
export const SYNTHETIC_EVENT_TYPES = [
	"connected",
	"disconnected",
	"agent_restarted",
	"rebooted",
	"identity_changed",
] as const;
export type SyntheticEventType = (typeof SYNTHETIC_EVENT_TYPES)[number];

export interface AgentEventIn {
	seq: number;
	bootId: string;
	type: string;
	time: string | Date;
	/** Decoded payload object. */
	payload: unknown;
}

export interface SyntheticEventIn {
	epoch: number;
	type: SyntheticEventType;
	instanceId: string;
	time: string | Date;
}

export interface AgentEventBatch {
	machineId: string;
	events: AgentEventIn[];
	synthetic: SyntheticEventIn[];
}

/**
 * Copy of a decoded payload without U+0000 in strings and keys: Postgres
 * jsonb rejects it, and one bad event would fail the batch on every
 * redelivery and stall the machine's events.
 */
export function stripNul(v: unknown): unknown {
	if (typeof v === "string") return noNul(v);
	if (Array.isArray(v)) return v.map(stripNul);
	if (typeof v === "object" && v !== null) {
		// fromEntries keeps a `__proto__` key as an own property.
		return Object.fromEntries(
			Object.entries(v).map(([k, val]) => [noNul(k), stripNul(val)]),
		);
	}
	return v;
}

function noNul(s: string): string {
	return s.includes("\0") ? s.replaceAll("\0", "") : s;
}

function isNonNegInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function toDate(v: unknown): Date | null {
	const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
	return d !== null && !Number.isNaN(d.getTime()) ? d : null;
}

function nonEmpty(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function validateBatch(b: AgentEventBatch): void {
	const issues: ValidationIssue[] = [];
	if (!isUuid(b?.machineId)) {
		issues.push({ path: "machineId", message: "must be a UUID" });
	}
	if (!Array.isArray(b?.events)) {
		issues.push({ path: "events", message: "must be an array" });
	} else {
		b.events.forEach((e, i) => {
			const p = `events[${i}]`;
			if (!isNonNegInt(e?.seq))
				issues.push({
					path: `${p}.seq`,
					message: "must be a non-negative integer",
				});
			if (!nonEmpty(e?.bootId))
				issues.push({
					path: `${p}.bootId`,
					message: "must be a non-empty string",
				});
			if (!nonEmpty(e?.type))
				issues.push({
					path: `${p}.type`,
					message: "must be a non-empty string",
				});
			if (toDate(e?.time) === null)
				issues.push({ path: `${p}.time`, message: "must be a timestamp" });
		});
	}
	if (!Array.isArray(b?.synthetic)) {
		issues.push({ path: "synthetic", message: "must be an array" });
	} else {
		b.synthetic.forEach((e, i) => {
			const p = `synthetic[${i}]`;
			if (!isNonNegInt(e?.epoch))
				issues.push({
					path: `${p}.epoch`,
					message: "must be a non-negative integer",
				});
			if (!SYNTHETIC_EVENT_TYPES.includes(e?.type)) {
				issues.push({
					path: `${p}.type`,
					message: `must be one of ${SYNTHETIC_EVENT_TYPES.join(", ")}`,
				});
			}
			if (!nonEmpty(e?.instanceId))
				issues.push({
					path: `${p}.instanceId`,
					message: "must be a non-empty string",
				});
			if (toDate(e?.time) === null)
				issues.push({ path: `${p}.time`, message: "must be a timestamp" });
		});
	}
	if (issues.length > 0) throw validation(issues);
}

/**
 * Stores the batch and enqueues its processing. `ackedSeq` is the largest
 * `seq` of the batch (every row is written, duplicates included), null if the
 * batch has no agent events.
 */
export async function ingestAgentEvents(
	pool: pg.Pool,
	jobs: JobSender,
	batch: AgentEventBatch,
): Promise<{ ackedSeq: number | null }> {
	validateBatch(batch);
	const { machineId, events, synthetic } = batch;
	const ackedSeq = events.reduce<number | null>(
		(max, e) => (max === null || e.seq > max ? e.seq : max),
		null,
	);
	if (events.length === 0 && synthetic.length === 0) return { ackedSeq };

	await withTx(pool, async (tx) => {
		if (events.length > 0) {
			await tx.client.query(
				`INSERT INTO runtime.agent_events (machine_id, seq, boot_id, type, time, payload)
				 SELECT $1, e.seq, e.boot_id, e.type, e.time, e.payload
				 FROM unnest($2::bigint[], $3::text[], $4::text[], $5::timestamptz[], $6::jsonb[])
				   AS e(seq, boot_id, type, time, payload)
				 ON CONFLICT (machine_id, seq) DO NOTHING`,
				[
					machineId,
					events.map((e) => e.seq),
					events.map((e) => noNul(e.bootId)),
					events.map((e) => noNul(e.type)),
					events.map((e) => toDate(e.time)),
					events.map((e) => JSON.stringify(stripNul(e.payload ?? {}))),
				],
			);
		}
		if (synthetic.length > 0) {
			await tx.client.query(
				`INSERT INTO runtime.agent_synthetic_events (machine_id, epoch, type, instance_id, time)
				 SELECT $1, e.epoch, e.type, e.instance_id, e.time
				 FROM unnest($2::bigint[], $3::text[], $4::text[], $5::timestamptz[])
				   AS e(epoch, type, instance_id, time)
				 ON CONFLICT (machine_id, epoch, type) DO NOTHING`,
				[
					machineId,
					synthetic.map((e) => e.epoch),
					synthetic.map((e) => e.type),
					synthetic.map((e) => noNul(e.instanceId)),
					synthetic.map((e) => toDate(e.time)),
				],
			);
		}
		await jobs.send(
			tx,
			"machine-events",
			{ machineId },
			{ singletonKey: machineId },
		);
	});
	return { ackedSeq };
}
