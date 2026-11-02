import { createHash, randomBytes } from "node:crypto";
import { type Tx, withTx } from "@umiak/db";
import {
	invalidState,
	notFound,
	portBlocked,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import { uuidv7 } from "../ids.ts";
import { portLabel } from "../label.ts";
import { hasOperatorRights, type Principal } from "../principal.ts";
import {
	type HostedPort,
	hostedPortFromRow,
	type PortAppProtocol,
	type PortHostRewrite,
	type PortMode,
} from "../rows.ts";
import {
	findSandboxRow,
	type SandboxRow,
	type SandboxServiceDeps,
} from "./common.ts";
import { checkKnownKeys, isPlainObject } from "./validate.ts";

// Hosted ports (S6 §5.8, S7 §11.2, S4 §4.2, §8.3). Every change runs under the
// sandbox row lock, so concurrent calls for one port serialize. The token
// (`umiakp_` + 32 random bytes base64url) is returned only by the call that
// issued it; the row keeps its sha256. Any mode change, rotation or revoke
// bumps `auth_epoch` (S4 §8.2); a change of only the proxy options
// (`hostRewrite`, `appProtocol`) does not. The `hosted_ports` trigger
// notifies the gateway.

export const PORT_MODES: readonly PortMode[] = ["token", "sso", "public"];
export const PORT_HOST_REWRITES: readonly PortHostRewrite[] = [
	"preserve",
	"localhost",
];
export const PORT_APP_PROTOCOLS: readonly PortAppProtocol[] = ["http1", "h2c"];

/**
 * The desired settings of a hosted port (`PUT /ports/{port}`, S7 §11.2).
 * Absent options take their defaults (`preserve`, `http1`), not the current values.
 */
export interface HostPortOptions {
	access: PortMode;
	hostRewrite?: PortHostRewrite;
	appProtocol?: PortAppProtocol;
}
/**
 * Ports that cannot be hosted: SSH and the desktop stream ports
 * (S10 §8.1: moonlight-web and Sunshine). The same list as the gateway's
 * (S4 §4.2, S7 §11.2).
 */
export const RESERVED_PORTS: readonly number[] = [
	22, 47800, 47984, 47989, 47990, 48010,
];
/** S4: at most 50 hosted ports per sandbox. */
export const MAX_HOSTED_PORTS = 50;
export const PORT_TOKEN_PREFIX = "umiakp_";

export interface HostPortResult {
	hostedPort: HostedPort;
	/** Only when this call issued a token (new token port or a switch to token). */
	token?: string;
	/** A new port row (`201`); false for a change or no change (`200`). */
	created: boolean;
}

function newToken(): { token: string; hash: Buffer } {
	const token = PORT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
	return { token, hash: createHash("sha256").update(token, "utf8").digest() };
}

export function validatePort(port: unknown): asserts port is number {
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

/** `port_blocked` for a port an operator blocked, unless `p` is an operator (S8 C3). */
function assertPortNotBlocked(p: Principal, cur: HostedPort | null): void {
	if (cur?.blocked === true && !hasOperatorRights(p)) {
		throw portBlocked(cur.port);
	}
}

function notDeleting(row: SandboxRow): void {
	if (row.state === "deleting" || row.state === "deleted") {
		throw invalidState(row.state);
	}
}

interface PortSettings {
	mode: PortMode;
	hostRewrite: PortHostRewrite;
	appProtocol: PortAppProtocol;
}

function portSettings(mode: PortMode | HostPortOptions): PortSettings {
	if (typeof mode !== "string" && !isPlainObject(mode as unknown)) {
		throw validation([
			{
				path: "access",
				message: "must be an access mode or an options object",
			},
		]);
	}
	const o: HostPortOptions = typeof mode === "string" ? { access: mode } : mode;
	const s: PortSettings = {
		mode: o.access,
		hostRewrite: o.hostRewrite ?? "preserve",
		appProtocol: o.appProtocol ?? "http1",
	};
	const issues: ValidationIssue[] = [];
	checkKnownKeys(
		o as unknown as Record<string, unknown>,
		["access", "hostRewrite", "appProtocol"],
		issues,
	);
	if (!PORT_MODES.includes(s.mode)) {
		issues.push({
			path: typeof mode === "string" ? "mode" : "access",
			message: `must be one of ${PORT_MODES.join(", ")}`,
		});
	}
	if (!PORT_HOST_REWRITES.includes(s.hostRewrite)) {
		issues.push({
			path: "hostRewrite",
			message: `must be one of ${PORT_HOST_REWRITES.join(", ")}`,
		});
	}
	if (!PORT_APP_PROTOCOLS.includes(s.appProtocol)) {
		issues.push({
			path: "appProtocol",
			message: `must be one of ${PORT_APP_PROTOCOLS.join(", ")}`,
		});
	}
	if (issues.length > 0) throw validation(issues);
	return s;
}

/**
 * Hosts a port or changes its settings. `mode` is the access mode (S6 form)
 * or the full options (S7). The same settings again change nothing.
 */
export async function hostPort(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	port: number,
	mode: PortMode | HostPortOptions,
): Promise<HostPortResult> {
	validatePort(port);
	const want = portSettings(mode);
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		notDeleting(row);
		const cur = await activePort(tx, row.id, port);
		assertPortNotBlocked(p, cur);
		if (cur !== null && cur.mode === want.mode) {
			if (
				cur.hostRewrite === want.hostRewrite &&
				cur.appProtocol === want.appProtocol
			) {
				return { hostedPort: cur, created: false };
			}
			// Proxy options only: the access and its cookies stay valid.
			const r = await tx.client.query(
				`UPDATE runtime.hosted_ports SET host_rewrite = $2, app_protocol = $3
				 WHERE id = $1 RETURNING *`,
				[cur.id, want.hostRewrite, want.appProtocol],
			);
			return { hostedPort: hostedPortFromRow(r.rows[0]), created: false };
		}

		const issued = want.mode === "token" ? newToken() : null;
		if (cur !== null) {
			const r = await tx.client.query(
				`UPDATE runtime.hosted_ports
				 SET mode = $2, token_hash = $3, host_rewrite = $4, app_protocol = $5,
				     auth_epoch = auth_epoch + 1
				 WHERE id = $1 RETURNING *`,
				[
					cur.id,
					want.mode,
					issued?.hash ?? null,
					want.hostRewrite,
					want.appProtocol,
				],
			);
			return withToken(hostedPortFromRow(r.rows[0]), issued, false);
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
			`INSERT INTO runtime.hosted_ports
			   (id, sandbox_id, port, label, mode, token_hash, host_rewrite, app_protocol, auth_epoch)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
			         COALESCE((SELECT max(auth_epoch) + 1 FROM runtime.hosted_ports WHERE label = $4), 0))
			 RETURNING *`,
			[
				uuidv7(),
				row.id,
				port,
				portLabel(row.slug, port),
				want.mode,
				issued?.hash ?? null,
				want.hostRewrite,
				want.appProtocol,
			],
		);
		return withToken(hostedPortFromRow(r.rows[0]), issued, true);
	});
}

function withToken(
	hostedPort: HostedPort,
	issued: { token: string } | null,
	created: boolean,
): HostPortResult {
	return issued === null
		? { hostedPort, created }
		: { hostedPort, token: issued.token, created };
}

/** The live hosted ports of the sandbox by port number (any sandbox state). */
export async function listHostedPorts(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<HostedPort[]> {
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	const r = await deps.pool.query(
		`SELECT * FROM runtime.hosted_ports
		 WHERE sandbox_id = $1 AND deleted_at IS NULL
		 ORDER BY port`,
		[row.id],
	);
	return r.rows.map(hostedPortFromRow);
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
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		const cur = await activePort(tx, row.id, port);
		if (cur === null) return;
		assertPortNotBlocked(p, cur);
		await tx.client.query(
			`UPDATE runtime.hosted_ports
			 SET deleted_at = now(), auth_epoch = auth_epoch + 1
			 WHERE id = $1`,
			[cur.id],
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
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		notDeleting(row);
		const cur = await activePort(tx, row.id, port);
		if (cur === null) throw notFound("hosted port");
		assertPortNotBlocked(p, cur);
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
