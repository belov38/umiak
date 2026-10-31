// Access rules of the collections and the global (S8 §7): reads and writes
// through Payload access (REST /cms-api, /admin) are for operators only.
// api, worker and the server actions of web use the Local API with
// overrideAccess: true and check permissions themselves (S8 §9.11).
import type { Access } from "payload";

/** True when the request user is an operator (S8 §5.5). */
export function isOperatorReq(req: { user?: unknown }): boolean {
	const user = req.user as { isOperator?: unknown } | null | undefined;
	return user?.isOperator === true;
}

export const operatorOnly: Access = ({ req }) => isOperatorReq(req);

export const nobody: Access = () => false;

/**
 * One document by id, operators only: no bulk update/delete by `where`.
 * Payload runs the hooks of a bulk operation in parallel in one
 * transaction, so per-document invariants (the last owner) would not hold.
 */
export const operatorByIdOnly: Access = ({ req, id }) =>
	isOperatorReq(req) && id !== undefined;

/** Collection access with every operation for operators only. */
export const operatorAccess = {
	read: operatorOnly,
	create: operatorOnly,
	update: operatorOnly,
	delete: operatorOnly,
} as const;

/**
 * Header of the "Delete team" button of /admin (apps/web, S8 §6.4): the
 * button first asks the api whether the team still has sandboxes, saved
 * snapshots or environments (web cannot see the runtime), then deletes
 * with this header.
 */
export const DELETE_TEAM_HEADER = "x-sbx-delete-team";

/**
 * Delete of a team: one team by id, operators only, and only with the
 * button's header. The admin computes its permissions without that header,
 * so Payload's own Delete never shows and the check cannot be skipped by
 * accident. A guard for operators, not a security boundary (an operator
 * may delete teams anyway).
 */
export const teamDeleteAccess: Access = ({ req, id }) =>
	operatorByIdOnly({ req, id } as Parameters<Access>[0]) === true &&
	req.headers?.get(DELETE_TEAM_HEADER) === "checked";
