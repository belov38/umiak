import { createHash, randomBytes } from "node:crypto";
import { type Tx, withTx } from "@sbx/db";
import { invalidState, notFound, validation } from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import { portLabel } from "../label.ts";
import type { Principal } from "../principal.ts";
import { type HostedPort, hostedPortFromRow, type PortMode } from "../rows.ts";
import {
	findSandboxRow,
	type SandboxRow,
	type SandboxServiceDeps,
} from "./common.ts";

// Hosted ports (S6 §5.8, S7 §11.2, S4 §4.2, §8.3). Every change runs under the
// sandbox row lock, so concurrent calls for one port serialize. The token
// (`sbxp_` + 32 random bytes base64url) is returned only by the call that
// issued it; the row keeps its sha256. Any mode change, rotation or revoke
// bumps `auth_epoch` (S4 §8.2); the `hosted_ports` trigger notifies the gateway.

export const PORT_MODES: readonly PortMode[] = ["token", "sso", "public"];
/**
 * Ports that cannot be hosted: SSH, plus ports reserved by the platform
 * (S3/S10; shared with the gateway). Nothing else is reserved yet.
 */
export const RESERVED_PORTS: readonly number[] = [22];
/** S4: at most 50 hosted ports per sandbox. */
export const MAX_HOSTED_PORTS = 50;
export const PORT_TOKEN_PREFIX = "sbxp_";

export interface HostPortResult {
	hostedPort: HostedPort;
	/** Only when this call issued a token (new token port or a switch to token). */
	token?: string;
}

function newToken(): { token: string; hash: Buffer } {
	const token = PORT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
	return { token, hash: createHash("sha256").update(token, "utf8").digest() };
}

function validatePort(port: unknown): asserts port is number {
	if (
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		throw validation([
			{ path: "port", message: "must be an integer in 1..65535" },
		]);
	}
	if (RESERVED_PORTS.includes(port)) {
		throw validation([
			{ path: "port", message: `port ${port} is reserved by the platform` },
		]);
	}
}

async function activePort(
	tx: Tx,
	sandboxId: string,
	port: number,
): Promise<HostedPort | null> {
	const r = await tx.client.query(
		`SELECT * FROM runtime.hosted_ports
		 WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL`,
		[sandboxId, port],
	);
	return r.rows[0] ? hostedPortFromRow(r.rows[0]) : null;
}

function notDeleting(row: SandboxRow): void {
	if (row.state === "deleting" || row.state === "deleted") {
		throw invalidState(row.state);
	}
}

export async function hostPort(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
	mode: PortMode,
): Promise<HostPortResult> {
	validatePort(port);
	if (!PORT_MODES.includes(mode)) {
		throw validation([
			{ path: "mode", message: `must be one of ${PORT_MODES.join(", ")}` },
		]);
	}
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		notDeleting(row);
		const cur = await activePort(tx, row.id, port);
		if (cur !== null && cur.mode === mode) return { hostedPort: cur };

		const issued = mode === "token" ? newToken() : null;
		if (cur !== null) {
			const r = await tx.client.query(
				`UPDATE runtime.hosted_ports
				 SET mode = $2, token_hash = $3, auth_epoch = auth_epoch + 1
				 WHERE id = $1 RETURNING *`,
				[cur.id, mode, issued?.hash ?? null],
			);
			return withToken(hostedPortFromRow(r.rows[0]), issued);
		}

		const count = await tx.client.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM runtime.hosted_ports
			 WHERE sandbox_id = $1 AND deleted_at IS NULL`,
			[row.id],
		);
		if ((count.rows[0]?.n ?? 0) >= MAX_HOSTED_PORTS) {
			throw validation([
				{
					path: "port",
					message: `at most ${MAX_HOSTED_PORTS} hosted ports per sandbox`,
				},
			]);
		}
		const r = await tx.client.query(
			// The epoch continues above every earlier row of this label, so a
			// cookie bound to {label, mode, authEpoch} from before an unhost never
			// becomes valid again (S4 §8.2). Label rows are only written under the
			// sandbox row lock, so the max is stable.
			`INSERT INTO runtime.hosted_ports (id, sandbox_id, port, label, mode, token_hash, auth_epoch)
			 VALUES ($1, $2, $3, $4, $5, $6,
			         COALESCE((SELECT max(auth_epoch) + 1 FROM runtime.hosted_ports WHERE label = $4), 0))
			 RETURNING *`,
			[
				uuidv7(),
				row.id,
				port,
				portLabel(row.slug, port),
				mode,
				issued?.hash ?? null,
			],
		);
		return withToken(hostedPortFromRow(r.rows[0]), issued);
	});
}

function withToken(
	hostedPort: HostedPort,
	issued: { token: string } | null,
): HostPortResult {
	return issued === null ? { hostedPort } : { hostedPort, token: issued.token };
}

/** Revokes the port (`deleted_at`, `auth_epoch + 1`); a port that is not hosted is a no-op. */
export async function unhostPort(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
): Promise<void> {
	validatePort(port);
	await withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		await tx.client.query(
			`UPDATE runtime.hosted_ports
			 SET deleted_at = now(), auth_epoch = auth_epoch + 1
			 WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL`,
			[row.id, port],
		);
	});
}

/** New token for a `token` port; the old token and cookies stop working at once. */
export async function rotatePortToken(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
): Promise<{ token: string }> {
	validatePort(port);
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, { lock: true });
		notDeleting(row);
		const cur = await activePort(tx, row.id, port);
		if (cur === null) throw notFound("hosted port");
		if (cur.mode !== "token") {
			throw validation([
				{ path: "port", message: `port ${port} is not in token mode` },
			]);
		}
		const issued = newToken();
		await tx.client.query(
			`UPDATE runtime.hosted_ports
			 SET token_hash = $2, auth_epoch = auth_epoch + 1
			 WHERE id = $1`,
			[cur.id, issued.hash],
		);
		return { token: issued.token };
	});
}
