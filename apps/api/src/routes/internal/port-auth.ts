// POST /internal/v1/gateway/port-auth/exchange (S7 §12.1, S4 §8.4): the
// gateway burns a one-time code of /sbx-auth/authorize. One atomic UPDATE:
// the code is used once, only for its label and before it expires, whatever
// pod the gateway asks.
import { createHash } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import { z } from "zod";
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { ApiError } from "../../http/errors.ts";
import { poolOf, readJson, requireGateway } from "./common.ts";

/** How long a code lives (S7 §7.7). */
export const PORT_AUTH_CODE_TTL_SECONDS = 60;

/** What `port_auth_codes.code_hash` stores: sha256 of the code as sent. */
export function portAuthCodeHash(code: string): Buffer {
	return createHash("sha256").update(code, "utf8").digest();
}

const ExchangeRequest = z.object({ code: z.string(), label: z.string() });

export function registerPortAuthRoutes(app: ApiApp, deps: ApiDeps): void {
	app.post(
		"/internal/v1/gateway/port-auth/exchange",
		requireGateway(),
		async (c) => {
			const { code, label } = await readJson(c, ExchangeRequest);
			const r = await poolOf(deps).query<{
				user_id: string;
				email: string;
				auth_epoch: number;
			}>(
				`UPDATE runtime.port_auth_codes SET used_at = now()
				  WHERE code_hash = $1 AND label = $2 AND used_at IS NULL AND expires_at > now()
				  RETURNING user_id, email, auth_epoch`,
				[portAuthCodeHash(code), label],
			);
			const row = r.rows[0];
			if (row === undefined) {
				throw new ApiError(
					400,
					"invalid_code",
					"the code is unknown, expired, already used or for another label",
				);
			}
			return c.json(
				{
					userId: encodeUuid("user", row.user_id),
					email: row.email,
					label,
					authEpoch: row.auth_epoch,
				},
				200,
			);
		},
	);
}
