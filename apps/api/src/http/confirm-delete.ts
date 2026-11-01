// Umiak-Confirm-Delete (S7 §5.12): a DELETE of a sandbox or a saved snapshot
// names the resource again, by public id (any case) or by slug / name. A
// guard against wrong slugs and empty variables in scripts, not against an
// attacker.
import type { Context } from "hono";
import type { ApiEnv } from "../deps.ts";
import { ApiError } from "./errors.ts";

export const CONFIRM_DELETE_HEADER = "Umiak-Confirm-Delete";

export interface ConfirmTarget {
	/** Public id (`sb_...`, `snap_...`). */
	id: string;
	/** Other accepted names: slug, snapshot name. */
	aliases: string[];
}

/** 428 confirmation_required (`details.reason`: missing | mismatch). */
export function requireConfirmDelete(
	c: Context<ApiEnv>,
	target: ConfirmTarget,
): void {
	const value = c.req.header(CONFIRM_DELETE_HEADER)?.trim() ?? "";
	if (value === "") {
		throw new ApiError(
			428,
			"confirmation_required",
			`set the header ${CONFIRM_DELETE_HEADER} to the id (${target.id}) of the resource to delete`,
			{ details: { reason: "missing" } },
		);
	}
	const ok =
		value.toLowerCase() === target.id.toLowerCase() ||
		target.aliases.includes(value);
	if (!ok) {
		throw new ApiError(
			428,
			"confirmation_required",
			`${CONFIRM_DELETE_HEADER} names another resource; set it to ${target.id}; nothing was deleted`,
			{ details: { reason: "mismatch" } },
		);
	}
}
